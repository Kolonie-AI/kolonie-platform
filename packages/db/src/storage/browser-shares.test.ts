import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import {
  BROWSER_SHARE_LIVE_MINUTES,
  BROWSER_SHARE_OFFER_HOURS,
  type AgentId,
  type HumanId,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agents, browserShares, humanAgents, humans } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import {
  acceptShare,
  closeShare,
  expireStaleShares,
  latestShare,
  liveShare,
  offerShare,
  shareForToken,
  sharesWaitingFor,
} from './browser-shares.js'

const target = databaseTestTarget()

/** The one tab an offer names. A CDP target id is opaque and this one is invented. */
const TAB = 'CDP-TARGET-0123456789ABCDEF'

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

  const anAgent = async (name: string): Promise<AgentId> => {
    const [row] = await db
      .insert(agents)
      .values({ name, platform: 'openclaw' })
      .returning({ id: agents.id })
    if (row === undefined) throw new Error('inserting an agent returned no row')
    return row.id as AgentId
  }

  const aPerson = async (): Promise<HumanId> => {
    const [row] = await db.insert(humans).values({}).returning({ id: humans.id })
    if (row === undefined) throw new Error('inserting a person returned no row')
    return row.id as HumanId
  }

  const operates = async (humanId: HumanId, agent: AgentId): Promise<void> => {
    await db.insert(humanAgents).values({ humanId, agentId: agent })
  }

  /** An offer, unwrapped, because every test past the first one needs its token. */
  const anOffer = async (agent: AgentId = agentId) => {
    const offered = await offerShare(db, { agentId: agent, targetId: TAB })
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

      expect(await offerShare(db, { agentId, targetId: 'ANOTHER-TAB' })).toEqual({
        outcome: 'refused',
        reason: 'already-open',
      })
    })

    it('lets the agent offer again once the first one ended', async () => {
      const first = await anOffer()
      await closeShare(db, first.id, 'cancelled')

      const second = await offerShare(db, { agentId, targetId: TAB })
      expect(second.outcome).toBe('offered')
    })

    it('does not count another citizen’s open share against this one', async () => {
      await anOffer(otherAgentId)

      expect((await offerShare(db, { agentId, targetId: TAB })).outcome).toBe('offered')
    })

    it('sweeps a lapsed offer out of the way rather than blocking on it', async () => {
      const stale = await anOffer()
      await windUp(stale.id)

      expect((await offerShare(db, { agentId, targetId: TAB })).outcome).toBe('offered')
      expect((await latestShare(db, agentId))?.state).toBe('offered')
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

  describe('the operator’s queue', () => {
    it('shows what is waiting, by the citizen’s name, oldest first', async () => {
      const person = await aPerson()
      await operates(person, agentId)
      await operates(person, otherAgentId)

      const mine = await anOffer()
      const theirs = await anOffer(otherAgentId)

      const waiting = await sharesWaitingFor(db, person)
      expect(waiting.map((share) => share.shareId)).toEqual([mine.id, theirs.id])
      expect(waiting.map((share) => share.agentName)).toEqual(['colette', 'somebody-else'])
    })

    it('drops one somebody is already watching, and one that lapsed', async () => {
      const person = await aPerson()
      await operates(person, agentId)
      await operates(person, otherAgentId)

      const watched = await anOffer()
      await acceptShare(db, watched.id, person)

      const lapsed = await anOffer(otherAgentId)
      await windUp(lapsed.id)

      expect(await sharesWaitingFor(db, person)).toEqual([])
      expect((await latestShare(db, otherAgentId))?.closedFor).toBe('expired')
    })

    it('shows a person nothing about a citizen they do not operate', async () => {
      const stranger = await aPerson()
      await anOffer()

      expect(await sharesWaitingFor(db, stranger)).toEqual([])
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
