import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import {
  BROWSER_SHARE_LIVE_MINUTES,
  BROWSER_SHARE_OFFER_HOURS,
  BROWSER_SHARE_SKILL,
  type AgentId,
  type HumanId,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import {
  agentSkills,
  agents,
  browserShares,
  humanAgents,
  humans,
  submissions,
  tasks,
} from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import {
  acceptShare,
  closeShare,
  expireStaleShares,
  handoverAround,
  latestShare,
  liveShare,
  offerShare,
  shareForToken,
  shareForWakeup,
  shareOfferedTo,
} from './browser-shares.js'

const target = databaseTestTarget()

/** The one tab an offer names. A CDP target id is opaque and this one is invented. */
const TAB = 'CDP-TARGET-0123456789ABCDEF'

/** What the agent asks for, in the sentence the queue entry will show (`#737`). */
const PURPOSE = 'Solve the image challenge and press Continue'

describe('the browser share', () => {
  let db: Database
  let agentId: AgentId
  let otherAgentId: AgentId

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
    agentId = await anAgent('colette')
    otherAgentId = await anAgent('somebody-else')
  })

  /**
   * A citizen that can offer: it holds the rung and somebody is linked to it.
   *
   * Both are prerequisites of {@link offerShare} rather than of the channel
   * (`#737`), so they are set up once here and the tests about them take them
   * away again. A fixture that left them out would make every test in this file
   * about the refusals instead of about what it is testing.
   */
  const anAgent = async (name: string): Promise<AgentId> => {
    const [row] = await db
      .insert(agents)
      .values({ name, platform: 'openclaw' })
      .returning({ id: agents.id })
    if (row === undefined) throw new Error('inserting an agent returned no row')

    const id = row.id as AgentId
    await grantTheRung(id)
    await operates(await aPerson(), id)
    return id
  }

  /**
   * The rung, with the passed submission `agent_skills` insists on.
   *
   * A skill row carries the provenance of the capability — the check constraint
   * admits exactly one demonstrated skill and `browser-session` is not it — so a
   * fixture that wanted the rung has to walk the whole way: a task, a passed
   * submission against it, then the grant.
   */
  const grantTheRung = async (agent: AgentId): Promise<void> => {
    const [task] = await db
      .insert(tasks)
      .values({
        type: `rung-${BROWSER_SHARE_SKILL}`,
        title: 'A rung the Academy carries',
        description: 'What this task is.',
        instructions: 'What the agent must do.',
        rewardReputation: 1,
        timeoutHours: 24,
        status: 'active' as const,
      })
      .returning({ id: tasks.id })
    if (task === undefined) throw new Error('inserting a task returned no row')

    const [submission] = await db
      .insert(submissions)
      .values({
        taskId: task.id,
        agentId: agent,
        payload: {},
        attempt: 1,
        status: 'passed' as const,
        verifiedAt: sql`now()`,
      })
      .returning({ id: submissions.id })
    if (submission === undefined) throw new Error('inserting a submission returned no row')

    await db
      .insert(agentSkills)
      .values({ agentId: agent, skill: BROWSER_SHARE_SKILL, submissionId: submission.id })
  }

  const aPerson = async (): Promise<HumanId> => {
    const [row] = await db.insert(humans).values({}).returning({ id: humans.id })
    if (row === undefined) throw new Error('inserting a person returned no row')
    return row.id as HumanId
  }

  /**
   * Hand a citizen to a person — replacing whoever held it, because
   * `human_agents` is keyed on the agent alone and every citizen here arrives
   * already linked. *Moving* the link is also the only way `taken` is reachable,
   * which one test below relies on.
   */
  const operates = async (humanId: HumanId, agent: AgentId): Promise<void> => {
    await db.delete(humanAgents).where(eq(humanAgents.agentId, agent))
    await db.insert(humanAgents).values({ humanId, agentId: agent })
  }

  /** An offer, unwrapped, because every test past the first one needs its token. */
  const anOffer = async (agent: AgentId = agentId) => {
    const offered = await offerShare(db, { agentId: agent, targetId: TAB, purpose: PURPOSE })
    if (offered.outcome !== 'offered') throw new Error(`expected an offer, got ${offered.reason}`)
    return offered.share
  }

  /** Move a share's window into the past, which is the only way to age one in a test. */
  const windUp = async (shareId: string): Promise<void> => {
    await db
      .update(browserShares)
      .set({ expiresAt: sql`now() - interval '1 minute'` })
      .where(eq(browserShares.id, shareId))
  }

  describe('offering one', () => {
    it('hands the token back exactly once and keeps only its hash', async () => {
      const share = await anOffer()

      const [row] = await db
        .select({ tokenHash: browserShares.tokenHash })
        .from(browserShares)
        .where(eq(browserShares.id, share.id))

      expect(share.token.length).toBeGreaterThan(32)
      expect(row?.tokenHash).not.toBe(share.token)
      expect(row?.tokenHash).toMatch(/^[0-9a-f]{64}$/)
    })

    it('opens the patient window, because the person may be hours away', async () => {
      const share = await anOffer()

      const hours = (Date.parse(share.expiresAt) - Date.now()) / 3_600_000
      expect(hours).toBeGreaterThan(BROWSER_SHARE_OFFER_HOURS - 0.5)
      expect(hours).toBeLessThanOrEqual(BROWSER_SHARE_OFFER_HOURS)
    })

    /**
     * *One open share per agent.* A queued second offer would be an offer against
     * a tab the agent has since moved on from, arriving at an operator with no way
     * to tell.
     */
    it('refuses a second while one is still open', async () => {
      await anOffer()

      expect(await offerShare(db, { agentId, targetId: 'ANOTHER-TAB', purpose: PURPOSE })).toEqual({
        outcome: 'refused',
        reason: 'already-open',
      })
    })

    it('lets the agent offer again once the first one ended', async () => {
      const first = await anOffer()
      await closeShare(db, first.id, 'cancelled')

      const second = await offerShare(db, { agentId, targetId: TAB, purpose: PURPOSE })
      expect(second.outcome).toBe('offered')
    })

    it('does not count another citizen’s open share against this one', async () => {
      await anOffer(otherAgentId)

      expect((await offerShare(db, { agentId, targetId: TAB, purpose: PURPOSE })).outcome).toBe(
        'offered',
      )
    })

    it('sweeps a lapsed offer out of the way rather than blocking on it', async () => {
      const stale = await anOffer()
      await windUp(stale.id)

      expect((await offerShare(db, { agentId, targetId: TAB, purpose: PURPOSE })).outcome).toBe(
        'offered',
      )
      expect((await latestShare(db, agentId))?.state).toBe('offered')
    })

    /**
     * Refused at the offer rather than at the acceptance nobody would make: an
     * unlinked citizen's share would otherwise sit for six hours and close
     * `expired`, and it would learn on its next waking that it had been waiting
     * on nobody.
     */
    it('refuses a citizen nobody is linked to', async () => {
      await db.delete(humanAgents).where(eq(humanAgents.agentId, agentId))

      expect(await offerShare(db, { agentId, targetId: TAB, purpose: PURPOSE })).toEqual({
        outcome: 'refused',
        reason: 'no-operator',
      })
    })

    it('refuses a citizen that does not hold the rung', async () => {
      await db.delete(agentSkills).where(eq(agentSkills.agentId, agentId))

      expect(await offerShare(db, { agentId, targetId: TAB, purpose: PURPOSE })).toEqual({
        outcome: 'refused',
        reason: 'no-skill',
      })
    })

    /**
     * Cheapest-to-fix first: an agent holding an open share is told *that*, not
     * sent off to earn a rung it may already hold or to find an operator it may
     * already have.
     */
    it('says already-open before it says anything about an operator or a rung', async () => {
      await anOffer()
      await db.delete(humanAgents).where(eq(humanAgents.agentId, agentId))
      await db.delete(agentSkills).where(eq(agentSkills.agentId, agentId))

      expect(await offerShare(db, { agentId, targetId: TAB, purpose: PURPOSE })).toEqual({
        outcome: 'refused',
        reason: 'already-open',
      })
    })

    it('carries the agent’s sentence, and what it left out, back to the agent', async () => {
      const placed = await offerShare(db, {
        agentId,
        targetId: TAB,
        purpose: PURPOSE,
        provider: 'mail.tm',
        step: 3,
      })
      if (placed.outcome !== 'offered') throw new Error(placed.reason)

      expect(await liveShare(db, agentId)).toMatchObject({
        purpose: PURPOSE,
        provider: 'mail.tm',
        step: 3,
      })

      // Where a page belongs to nobody in particular and is nobody's numbered
      // step, which is most of them: null rather than an invented placeholder.
      await closeShare(db, placed.share.id, 'cancelled')
      await anOffer()
      expect(await liveShare(db, agentId)).toMatchObject({ provider: null, step: null })
    })
  })

  describe('resolving a token', () => {
    it('answers the relay with the share and nothing about who is on it', async () => {
      const share = await anOffer()

      expect(await shareForToken(db, share.token)).toEqual({
        id: share.id,
        agentId,
        targetId: TAB,
        acceptedAt: null,
        expiresAt: share.expiresAt,
      })
    })

    /**
     * Null for every closed state, so a socket presenting a guessed token cannot
     * learn whether it ever named anything.
     */
    it('is silent about a token that never existed, one that lapsed and one that ended', async () => {
      expect(await shareForToken(db, 'never-minted')).toBeNull()

      const lapsed = await anOffer()
      await windUp(lapsed.id)
      expect(await shareForToken(db, lapsed.token)).toBeNull()

      await closeShare(db, lapsed.id, 'expired')
      const ended = await anOffer()
      await closeShare(db, ended.id, 'completed')
      expect(await shareForToken(db, ended.token)).toBeNull()
    })
  })

  describe('accepting one', () => {
    it('rewrites the patient window into the short live one', async () => {
      const share = await anOffer()
      const person = await aPerson()
      await operates(person, agentId)

      const accepted = await acceptShare(db, share.id, person)
      if (accepted.outcome !== 'accepted') throw new Error(accepted.reason)

      const minutes = (Date.parse(accepted.share.expiresAt) - Date.now()) / 60_000
      expect(minutes).toBeLessThanOrEqual(BROWSER_SHARE_LIVE_MINUTES)
      expect(minutes).toBeGreaterThan(BROWSER_SHARE_LIVE_MINUTES - 1)
      expect(accepted.share.acceptedAt).not.toBeNull()
      expect((await liveShare(db, agentId))?.state).toBe('live')
    })

    /** Only the linked operator — the third of the decision's four questions. */
    it('refuses a person who does not operate this citizen', async () => {
      const share = await anOffer()
      const stranger = await aPerson()
      await operates(stranger, otherAgentId)

      expect(await acceptShare(db, share.id, stranger)).toEqual({
        outcome: 'refused',
        reason: 'not-yours',
      })
    })

    it('says nothing at all about an id that names no open share', async () => {
      const person = await aPerson()
      await operates(person, agentId)
      const gone = await anOffer()
      await closeShare(db, gone.id, 'cancelled')

      expect(await acceptShare(db, gone.id, person)).toEqual({
        outcome: 'refused',
        reason: 'unknown',
      })
    })

    /**
     * The other half of `#768`. A malformed id reaching the query would raise
     * out of the operator's socket rather than refusing it, so the person whose
     * window sent it would see the connection drop with nothing said.
     */
    it('refuses a malformed id as unknown rather than raising', async () => {
      const person = await aPerson()
      await operates(person, agentId)

      expect(await acceptShare(db, 'not-a-uuid', person)).toEqual({
        outcome: 'refused',
        reason: 'unknown',
      })
    })

    /**
     * A reloaded window, a slept laptop, a second tab. Refusing would end a live
     * session over a browser event nobody chose — and re-accepting must not extend
     * the clock, or a reload would be a way to hold a tab open indefinitely.
     */
    it('lets the person already on it join again without moving the clock', async () => {
      const share = await anOffer()
      const person = await aPerson()
      await operates(person, agentId)

      const first = await acceptShare(db, share.id, person)
      if (first.outcome !== 'accepted') throw new Error(first.reason)

      const again = await acceptShare(db, share.id, person)
      if (again.outcome !== 'accepted') throw new Error(again.reason)

      expect(again.share.expiresAt).toBe(first.share.expiresAt)
      expect(again.share.acceptedAt).toBe(first.share.acceptedAt)
    })

    /**
     * `human_agents` is keyed on the agent, so a citizen has one operator at a
     * time and two people cannot ordinarily race for the same offer. The way
     * `taken` is actually reached is the link *moving* while a share is live —
     * the citizen was handed to somebody else this afternoon — and the person who
     * arrives second must not be able to take a session out from under the person
     * already watching it.
     */
    it('refuses a window that arrives after somebody else is already watching', async () => {
      const share = await anOffer()
      const first = await aPerson()
      const second = await aPerson()
      await operates(first, agentId)

      await acceptShare(db, share.id, first)

      await db.delete(humanAgents).where(eq(humanAgents.agentId, agentId))
      await operates(second, agentId)

      expect(await acceptShare(db, share.id, second)).toEqual({
        outcome: 'refused',
        reason: 'taken',
      })
    })
  })

  /**
   * *What is waiting* is answered once, by `operatorQueue`, across all three
   * channels (`#738`). What is left here is the window's own read: **one share,
   * by id, for one person** — everything the console needs to decide whether to
   * render a page, and nothing that could be used to enumerate.
   */
  describe('opening one', () => {
    /**
     * The sentence travels with it (`#737`), because it is what the person reads
     * before touching the tab. A window saying *colette is stuck* would ask them
     * to work out what for from the page in front of them.
     */
    it('carries what the agent asked for, and by whom', async () => {
      const person = await aPerson()
      await operates(person, agentId)
      const offered = await offerShare(db, {
        agentId,
        targetId: TAB,
        purpose: PURPOSE,
        provider: 'mail.tm',
        step: 3,
      })
      if (offered.outcome !== 'offered') throw new Error('expected an offer')

      expect(await shareOfferedTo(db, offered.share.id, person)).toMatchObject({
        shareId: offered.share.id,
        agentName: 'colette',
        purpose: PURPOSE,
        provider: 'mail.tm',
        step: 3,
      })
    })

    /**
     * A reload, a duplicated tab, a laptop that slept: all of them come back
     * here on a share that is already `live`. Refusing would end a session over
     * a browser event nobody chose, so accepted shares are deliberately included
     * — `acceptShare` re-asks *may this person resume it* at the socket.
     */
    it('still answers once the person is on it', async () => {
      const person = await aPerson()
      await operates(person, agentId)
      const share = await anOffer()
      await acceptShare(db, share.id, person)

      expect(await shareOfferedTo(db, share.id, person)).toMatchObject({ shareId: share.id })
    })

    /**
     * **Null and never a refusal**, the same silence `shareForToken` keeps. A
     * page that distinguished *not yours* from *no such thing* would be a way to
     * ask whether a guessed id ever named anything.
     */
    it('tells a stranger what a guessed id is told', async () => {
      const stranger = await aPerson()
      const share = await anOffer()

      expect(await shareOfferedTo(db, share.id, stranger)).toBeNull()
      expect(await shareOfferedTo(db, randomUUID(), stranger)).toBeNull()
    })

    /**
     * `#768`, and the reason it was reported as a defect rather than as a typo:
     * the id goes into `where id = $1` against a `uuid` column, so a string that
     * is not one made Postgres raise instead of matching nothing, and the
     * console answered with "something went wrong" and an error id.
     *
     * The share **token** is the case that actually happened. Both are opaque
     * strings the agent has just been handed, one of them is a uuid, and only
     * the operator can tell which door they are at. It has to be the same
     * silence as a guess.
     */
    it('is silent about a malformed id, including the share token', async () => {
      const person = await aPerson()
      await operates(person, agentId)
      const offered = await offerShare(db, { agentId, targetId: TAB, purpose: PURPOSE })
      if (offered.outcome !== 'offered') throw new Error('expected an offer')

      expect(await shareOfferedTo(db, offered.share.token, person)).toBeNull()
      expect(await shareOfferedTo(db, 'not-a-uuid', person)).toBeNull()
      expect(await shareOfferedTo(db, '', person)).toBeNull()
    })

    it('stops answering once it has lapsed or ended', async () => {
      const person = await aPerson()
      await operates(person, agentId)
      await operates(person, otherAgentId)

      const lapsed = await anOffer()
      await windUp(lapsed.id)

      const ended = await anOffer(otherAgentId)
      await closeShare(db, ended.id, 'cancelled')

      expect(await shareOfferedTo(db, lapsed.id, person)).toBeNull()
      expect(await shareOfferedTo(db, ended.id, person)).toBeNull()
    })
  })

  describe('ending one', () => {
    /**
     * The ways a share ends race by construction: the operator closes the window
     * at the moment the sharer's socket drops, and both paths arrive here.
     */
    it('keeps the first reason and tells the second caller it lost', async () => {
      const share = await anOffer()

      expect(await closeShare(db, share.id, 'completed')).toBe(true)
      expect(await closeShare(db, share.id, 'lost')).toBe(false)

      const summary = await latestShare(db, agentId)
      expect(summary?.state).toBe('closed')
      expect(summary?.closedFor).toBe('completed')
    })

    it('closes a lapsed share with a reason the agent can read back', async () => {
      const share = await anOffer()
      await windUp(share.id)

      expect(await expireStaleShares(db)).toBe(1)
      expect((await latestShare(db, agentId))?.closedFor).toBe('expired')
      expect(await liveShare(db, agentId)).toBeNull()
    })

    it('leaves an open share alone when the sweep runs', async () => {
      await anOffer()

      expect(await expireStaleShares(db)).toBe(0)
      expect((await liveShare(db, agentId))?.state).toBe('offered')
    })

    it('is quiet about an id that names nothing', async () => {
      expect(await closeShare(db, '00000000-0000-0000-0000-000000000000', 'cancelled')).toBe(false)
    })
  })

  /**
   * The half that makes *offer, end the turn, sleep* a real sequence rather than
   * a slogan (`#737`): the agent that slept has to be told on waking, and it is
   * not going to remember to ask.
   */
  describe('what the wake-up says about one', () => {
    /** Long enough ago that nothing in these tests falls outside it. */
    const anHourAgo = (): string => new Date(Date.now() - 3_600_000).toISOString()

    it('reports an open offer however old it is, because it is still owed an answer', async () => {
      const share = await anOffer()

      const reported = await shareForWakeup(db, agentId, new Date().toISOString())
      expect(reported).toMatchObject({ id: share.id, state: 'offered', purpose: PURPOSE })
    })

    it('reports one that ended inside the window', async () => {
      const share = await anOffer()
      await closeShare(db, share.id, 'completed')

      expect(await shareForWakeup(db, agentId, anHourAgo())).toMatchObject({
        id: share.id,
        state: 'closed',
        closedFor: 'completed',
      })
    })

    /** Otherwise every waking for the rest of the agent's life reports it again. */
    it('is silent about one that ended before the window', async () => {
      const share = await anOffer()
      await closeShare(db, share.id, 'completed')

      expect(
        await shareForWakeup(db, agentId, new Date(Date.now() + 1_000).toISOString()),
      ).toBeNull()
    })

    /**
     * The sweep runs first, so an offer nobody came to reads `expired` rather
     * than `offered` — the agent is told it waited on nobody, which is the whole
     * reason the field is there.
     */
    it('reports a lapsed offer as expired rather than as still waiting', async () => {
      const share = await anOffer()
      await windUp(share.id)

      expect(await shareForWakeup(db, agentId, anHourAgo())).toMatchObject({
        id: share.id,
        state: 'closed',
        closedFor: 'expired',
      })
    })

    it('says nothing about a citizen that has never offered one', async () => {
      expect(await shareForWakeup(db, otherAgentId, anHourAgo())).toBeNull()
    })

    it('says nothing about another citizen’s share', async () => {
      await anOffer(otherAgentId)

      expect(await shareForWakeup(db, agentId, anHourAgo())).toBeNull()
    })
  })

  /**
   * The interval a badge rests on (`#739`).
   *
   * `browser-captcha` is no longer *did this agent get past a hostile page* — it
   * is *did its operator get past one, inside the agent's own session, while the
   * agent was there*. That question is this one function, and everything the
   * verdict is allowed to say is what this returns.
   *
   * **The boundaries are the tests worth having.** A clear a second before the
   * person joined, or a second after they left, is a clear the agent produced by
   * itself — and the whole reason the rung was rebuilt is that an agent measured
   * on producing one is an agent under pressure to claim to be human.
   */
  describe('the handover a badge rests on', () => {
    /** Who holds this citizen, which `anAgent` linked and did not hand back. */
    const theOperator = async (agent: AgentId = agentId): Promise<HumanId> => {
      const [row] = await db
        .select({ humanId: humanAgents.humanId })
        .from(humanAgents)
        .where(eq(humanAgents.agentId, agent))
        .limit(1)
      if (row === undefined) throw new Error('nobody operates this agent')
      return row.humanId as HumanId
    }

    /**
     * A whole handover, driven through the real calls and read back off the row.
     *
     * The two timestamps are the database's own rather than the test's, because
     * the assertions below are about an interval and a clock this file invented
     * would be an interval nothing else agrees with.
     */
    const aHandover = async (
      agent: AgentId = agentId,
      reason: 'completed' | 'lost' = 'completed',
    ) => {
      const share = await anOffer(agent)
      const accepted = await acceptShare(db, share.id, await theOperator(agent))
      if (accepted.outcome !== 'accepted') throw new Error(`accept refused: ${accepted.reason}`)
      await closeShare(db, share.id, reason)

      const [row] = await db
        .select({ acceptedAt: browserShares.acceptedAt, closedAt: browserShares.closedAt })
        .from(browserShares)
        .where(eq(browserShares.id, share.id))
      if (row?.acceptedAt == null || row.closedAt == null) throw new Error('the share is not shut')

      return { shareId: share.id, acceptedAt: row.acceptedAt, closedAt: row.closedAt }
    }

    /** A moment inside the window, whatever the two ends turned out to be. */
    const between = (from: string, to: string): string =>
      new Date((Date.parse(from) + Date.parse(to)) / 2).toISOString()

    it('answers with the session a clear fell inside, and why it ended', async () => {
      const { shareId, acceptedAt, closedAt } = await aHandover()

      expect(await handoverAround(db, agentId, between(acceptedAt, closedAt))).toMatchObject({
        shareId,
        closedFor: 'completed',
      })
    })

    /**
     * Both ends count. A challenge that went through on the operator's first
     * click, or on the click they closed the window after, is a challenge they
     * were on the tab for — and a millisecond of rounding is not a reason to
     * refuse somebody a badge.
     */
    it('counts the instant they joined and the instant they left', async () => {
      const { acceptedAt, closedAt } = await aHandover()

      expect(await handoverAround(db, agentId, acceptedAt)).not.toBeNull()
      expect(await handoverAround(db, agentId, closedAt)).not.toBeNull()
    })

    it('says nothing about a moment before the operator arrived', async () => {
      const { acceptedAt } = await aHandover()
      const before = new Date(Date.parse(acceptedAt) - 1_000).toISOString()

      expect(await handoverAround(db, agentId, before)).toBeNull()
    })

    it('says nothing about a moment after the operator left', async () => {
      const { closedAt } = await aHandover()
      const after = new Date(Date.parse(closedAt) + 1_000).toISOString()

      expect(await handoverAround(db, agentId, after)).toBeNull()
    })

    /**
     * A share still running is not yet an answer. The rung is earned on the
     * completion — the agent carries on in the same session and hands in
     * afterwards — so a submission arriving mid-handover has nothing to report
     * on yet.
     */
    it('says nothing about a session that has not ended', async () => {
      const share = await anOffer()
      const accepted = await acceptShare(db, share.id, await theOperator())
      if (accepted.outcome !== 'accepted') throw new Error(`accept refused: ${accepted.reason}`)

      expect(await handoverAround(db, agentId, new Date().toISOString())).toBeNull()
    })

    /**
     * An offer nobody came to. This is the shape `#739` names as *not* a pass —
     * offering a session and achieving nothing — and it is refused by the
     * absence of an `accepted_at` rather than by a rule written twice.
     */
    it('says nothing about an offer that lapsed unanswered', async () => {
      const share = await anOffer()
      const at = new Date().toISOString()
      await windUp(share.id)
      await expireStaleShares(db)

      expect(await handoverAround(db, agentId, at)).toBeNull()
    })

    /**
     * A socket that dropped is still a handover. Whether the person was on the
     * tab when the challenge went through is the question; what the network did
     * a minute later is not, and the reason travels back so the verdict can say
     * which it was.
     */
    it('counts a session that ended badly, and reports how', async () => {
      const { acceptedAt, closedAt } = await aHandover(agentId, 'lost')

      expect(await handoverAround(db, agentId, between(acceptedAt, closedAt))).toMatchObject({
        closedFor: 'lost',
      })
    })

    it('says nothing about another citizen’s handover', async () => {
      const { acceptedAt, closedAt } = await aHandover(otherAgentId)

      expect(await handoverAround(db, agentId, between(acceptedAt, closedAt))).toBeNull()
    })
  })

  /**
   * The property the whole channel rests on, asserted against the disk rather
   * than argued for: drive a share through every call in this file and then read
   * back every column of every row, looking for anything that was on the screen.
   *
   * There is no argument here that could carry a frame — which is the point. If
   * one is ever added, this test is what fails.
   */
  it('writes no frame, and no token, anywhere', async () => {
    const share = await anOffer()
    const person = await aPerson()
    await operates(person, agentId)
    await acceptShare(db, share.id, person)
    await closeShare(db, share.id, 'completed')

    const rows = await db.select().from(browserShares)
    const persisted = JSON.stringify(rows)

    expect(persisted).not.toContain(share.token)
    expect(persisted).not.toContain('frame')
    expect(persisted).not.toContain('screencast')
  })
})
