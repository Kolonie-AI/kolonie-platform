import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { and, eq, sql } from 'drizzle-orm'
import { AccountKindSchema, RegisterAgentRequestSchema, type AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { emailChallenges } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { listAccounts } from './accounts.js'
import { registerAgent } from './agents.js'
import {
  EMAIL_CHALLENGE_LIFETIME_CEILING,
  EMAIL_CHALLENGE_WINDOW_CAP,
  emailChallengeLimits,
  latestEmailChallenge,
  latestEmailSendChallenge,
  markEmailSent,
  mintEmailChallenge,
  mintEmailSendChallenge,
  promoteMailbox,
  provedMailbox,
  provedMailboxes,
  recordInboundMail,
  redeemEmailCode,
  sendingRecordFor,
} from './email.js'

const target = databaseTestTarget()

describe('the mailbox nodes', () => {
  let db: Database
  let agentId: AgentId
  let otherId: AgentId

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
    agentId = await register('postmaster')
    otherId = await register('bystander')
  })

  const register = async (name: string): Promise<AgentId> => {
    const result = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name, platform: 'openclaw' }),
    )
    if (result.outcome !== 'registered') throw new Error(result.outcome)
    return result.agent.id
  }

  /** Mint, without pretending the mail went out. */
  const mint = async (agent: AgentId, address: string) => {
    const result = await mintEmailChallenge(db, agent, address)
    if (result.outcome !== 'minted') throw new Error(result.outcome)
    return result.challenge
  }

  /** Mint and record delivery — what the API does when the mailer succeeds. */
  const mintAndSend = async (agent: AgentId, address: string) => {
    const challenge = await mint(agent, address)
    await markEmailSent(db, challenge.id)
    return challenge
  }

  /**
   * Age a row into the past. Both timestamps move, because
   * `email_challenges_expiry_after_creation` refuses a row whose expiry
   * precedes its creation.
   */
  const expire = async (token: string) => {
    await db
      .update(emailChallenges)
      .set({
        createdAt: sql`now() - interval '48 hours'`,
        expiresAt: sql`now() - interval '1 hour'`,
      })
      .where(eq(emailChallenges.token, token))
  }

  /** The whole granting node, start to finish. Used wherever a *passed* agent is needed. */
  const earnMailbox = async (agent: AgentId, address: string) => {
    const challenge = await mintAndSend(agent, address)
    const redeemed = await redeemEmailCode(db, agent, challenge.code)
    if (redeemed.outcome !== 'verified') throw new Error(redeemed.outcome)
    return challenge
  }

  /**
   * Move every challenge this citizen has opened out of the rolling window.
   *
   * The one thing the surface cannot produce: the window heals by the passage of
   * a month, and that it heals is the point of having one (`#153`).
   */
  const ageOutOfWindow = async (agent: AgentId) => {
    await db
      .update(emailChallenges)
      .set({
        createdAt: sql`now() - interval '60 days'`,
        expiresAt: sql`now() - interval '59 days'`,
        // The verdict moves with the row it belongs to:
        // `email_challenges_verified_before_expiry` refuses a pass dated after
        // the challenge it passed, and a helper that produced an illegal row
        // would be testing something the database cannot hold.
        verifiedAt: sql`case when ${emailChallenges.verifiedAt} is null
                            then null else now() - interval '59 days' end`,
        sentAt: sql`case when ${emailChallenges.sentAt} is null
                        then null else now() - interval '60 days' end`,
      })
      .where(eq(emailChallenges.agentId, agent))
  }

  /** Spend a citizen's window, expiring each challenge so the next one may open. */
  const fillWindow = async (
    agent: AgentId,
    count: number = EMAIL_CHALLENGE_WINDOW_CAP,
    run = 'try',
  ) => {
    for (let index = 0; index < count; index += 1) {
      const challenge = await mintAndSend(agent, `${run}-${index}@example.org`)
      await expire(challenge.token)
    }
  }

  const inboxRowCount = async (agent: AgentId): Promise<number> => {
    const rows = await db
      .select({ id: emailChallenges.id })
      .from(emailChallenges)
      .where(and(eq(emailChallenges.agentId, agent), eq(emailChallenges.purpose, 'inbox')))
    return rows.length
  }

  describe('email-inbox: the granting node', () => {
    it('passes on reading alone — nothing is ever sent by the agent', async () => {
      const challenge = await mintAndSend(agentId, 'citizen@example.org')

      expect(await latestEmailChallenge(db, agentId)).toMatchObject({
        address: 'citizen@example.org',
        inboundAt: null,
        verifiedAt: null,
      })

      expect(await redeemEmailCode(db, agentId, challenge.code)).toEqual({
        outcome: 'verified',
        address: 'citizen@example.org',
      })

      const passed = await latestEmailChallenge(db, agentId)
      expect(passed?.verifiedAt).not.toBeNull()
      // The assertion that matters most in this file: no mail from the agent was
      // involved at any point, so an address that can receive and cannot send
      // has just earned `mailbox`.
      expect(passed?.inboundAt).toBeNull()
    })

    it('keeps a pass permanent when a later attempt is abandoned', async () => {
      await earnMailbox(agentId, 'citizen@example.org')
      await mint(agentId, 'second@example.org')

      // The newer row is unverified. Reading "the latest" naively would report
      // this citizen as having never passed the node it did pass.
      expect((await latestEmailChallenge(db, agentId))?.verifiedAt).not.toBeNull()
    })

    it('refuses a wrong code', async () => {
      await mintAndSend(agentId, 'citizen@example.org')

      expect(await redeemEmailCode(db, agentId, 'AAAAAAAAAAAA')).toEqual({ outcome: 'wrong_code' })
      expect((await latestEmailChallenge(db, agentId))?.verifiedAt).toBeNull()
    })

    /**
     * The distinction that decides what the agent should do next. "The mail
     * never went out" means ask again, which retries the delivery; "wrong code"
     * means read more carefully. Collapsing both into a failure is how an agent
     * spends an hour on the wrong problem.
     */
    it('separates "the mail never went out" from "that code is wrong"', async () => {
      await mint(agentId, 'citizen@example.org')

      expect(await redeemEmailCode(db, agentId, 'AAAAAAAAAAAA')).toEqual({
        outcome: 'nothing_sent_yet',
      })
    })

    it('tells an agent that never minted a challenge so', async () => {
      expect(await redeemEmailCode(db, agentId, 'AAAAAAAAAAAA')).toEqual({
        outcome: 'no_open_challenge',
      })
    })

    it('refuses a code after the challenge expired', async () => {
      const challenge = await mintAndSend(agentId, 'citizen@example.org')
      await expire(challenge.token)

      expect(await redeemEmailCode(db, agentId, challenge.code)).toEqual({ outcome: 'expired' })
    })

    it('accepts the code as the agent read it, whitespace and case included', async () => {
      const challenge = await mintAndSend(agentId, 'citizen@example.org')

      expect(
        (await redeemEmailCode(db, agentId, `  ${challenge.code.toLowerCase()} `)).outcome,
      ).toBe('verified')
    })

    /**
     * A code is twelve characters. Looked up by code alone, anyone holding one
     * could close somebody else's rung — so the agent id is half of the check,
     * not context.
     */
    it('will not let one agent redeem another agent’s code', async () => {
      const mine = await mintAndSend(agentId, 'citizen@example.org')

      // The other agent is taken all the way to its own delivered code, so this
      // reaches the comparison rather than being turned away earlier for having
      // nothing sent. Otherwise the test would pass without exercising the rule.
      await mintAndSend(otherId, 'other@example.org')

      expect(await redeemEmailCode(db, otherId, mine.code)).toEqual({ outcome: 'wrong_code' })
      expect((await latestEmailChallenge(db, agentId))?.verifiedAt).toBeNull()
    })

    it('is single use — a code cannot close two challenges', async () => {
      const challenge = await earnMailbox(agentId, 'citizen@example.org')

      // Already verified, so the second call reports the settled state rather
      // than passing anything a second time.
      expect(await redeemEmailCode(db, agentId, challenge.code)).toEqual({
        outcome: 'verified',
        address: 'citizen@example.org',
      })
    })
  })

  /**
   * The four rules that replaced the sender check as the bound on who the Colony
   * will write to (`kolonie-docs#92`). Before the split it only ever answered
   * mail that had already arrived; now an agent names an address and that
   * address gets mail, so these are what keeps the Academy from being an
   * outbound mailer pointed at addresses somebody else chose.
   */
  describe('what bounds who the Colony will write to', () => {
    /**
     * **The load-bearing rule.** It makes the number of mails a function of the
     * number of citizens rather than of the number of requests.
     *
     * Asserted on the row count as well as the outcome: `open` could be returned
     * by an implementation that also wrote a second row, and the row count is
     * what says no second mail *could* have gone out.
     */
    it('returns the open challenge and mints nothing on a repeat request', async () => {
      const first = await mintAndSend(agentId, 'citizen@example.org')

      const second = await mintEmailChallenge(db, agentId, 'citizen@example.org')

      expect(second).toMatchObject({ outcome: 'open', sent: true })
      if (second.outcome !== 'open') throw new Error(second.outcome)
      expect(second.challenge.token).toBe(first.token)
      expect(await inboxRowCount(agentId)).toBe(1)
    })

    /**
     * A different address while one is open is still the same rule: one open
     * challenge per *citizen*, not per address. Otherwise the bound would be
     * bypassed by naming a new address each time, which is free.
     */
    it('holds even when the repeat names a different address', async () => {
      await mintAndSend(agentId, 'citizen@example.org')

      expect(await mintEmailChallenge(db, agentId, 'elsewhere@example.org')).toMatchObject({
        outcome: 'open',
      })
      expect(await inboxRowCount(agentId)).toBe(1)
    })

    /**
     * The exception, and the reason `sent_at` is a column rather than an
     * assumption: a delivery that failed left the citizen holding a challenge it
     * cannot replace, and refusing to retry would be a rung it can never pass.
     * `sent: false` is how the caller learns it should send.
     */
    it('reports an undelivered challenge as needing its send retried', async () => {
      await mint(agentId, 'citizen@example.org')

      expect(await mintEmailChallenge(db, agentId, 'citizen@example.org')).toMatchObject({
        outcome: 'open',
        sent: false,
      })
      expect(await inboxRowCount(agentId)).toBe(1)
    })

    it('lets a citizen start again once the open challenge expired', async () => {
      const first = await mintAndSend(agentId, 'citizen@example.org')
      await expire(first.token)

      expect((await mintEmailChallenge(db, agentId, 'citizen@example.org')).outcome).toBe('minted')
    })

    /**
     * **The rolling window, which is what bounds the sending domain's exposure**
     * (`#153`). Five in a month is the number the lifetime cap used to be, kept
     * where it does the work it was written for.
     */
    it('refuses past the window, and says when the citizen may ask again', async () => {
      await fillWindow(agentId)

      const refused = await mintEmailChallenge(db, agentId, 'one-more@example.org')

      expect(refused).toMatchObject({
        outcome: 'window_reached',
        limits: {
          openedInWindow: EMAIL_CHALLENGE_WINDOW_CAP,
          windowCap: EMAIL_CHALLENGE_WINDOW_CAP,
        },
      })
      // The half the old single outcome could not express: this refusal is
      // recoverable and says so with a time rather than leaving the citizen to
      // conclude it is finished.
      if (refused.outcome !== 'window_reached') throw new Error(refused.outcome)
      expect(Date.parse(refused.retryAfter)).toBeGreaterThan(Date.now())
    })

    /**
     * **The two refusals are distinguishable by the caller**, which is the whole
     * of why there are two: one of them is waited out and the other is not, and
     * an agent that cannot tell them apart takes the wrong action for one of them.
     */
    it('refuses at the lifetime ceiling, and says nothing about waiting', async () => {
      // Spent the only way it can be spent: a full window, a month's wait, and
      // again — the slow grind the ceiling exists to stop, which is exactly what
      // makes it different from the refusal above.
      for (
        let window = 0;
        window < EMAIL_CHALLENGE_LIFETIME_CEILING / EMAIL_CHALLENGE_WINDOW_CAP;
        window += 1
      ) {
        await fillWindow(agentId, EMAIL_CHALLENGE_WINDOW_CAP, `w${window}`)
        await ageOutOfWindow(agentId)
      }

      const refused = await mintEmailChallenge(db, agentId, 'one-more@example.org')

      expect(refused).toMatchObject({
        outcome: 'ceiling_reached',
        limits: { openedEver: EMAIL_CHALLENGE_LIFETIME_CEILING, nextAvailableAt: null },
      })
    })

    /**
     * The case `#153` exists for. The register (`#150`) makes holding several
     * mailboxes ordinary, and a citizen that replaces one every so often must
     * never meet either bound — the old lifetime cap of five made it certain that
     * it eventually would.
     */
    it('lets a citizen prove three mailboxes over time and meet neither limit', async () => {
      for (const address of ['first@example.org', 'second@example.org', 'third@example.org']) {
        // A failed attempt against each, which is what a real run looks like,
        // and then the address that works.
        const abandoned = await mintAndSend(agentId, `attempt-${address}`)
        await expire(abandoned.token)
        await earnMailbox(agentId, address)
        await ageOutOfWindow(agentId)
      }

      const limits = await emailChallengeLimits(db, agentId)

      expect(limits.openedInWindow).toBe(0)
      expect(limits.openedEver).toBeLessThan(EMAIL_CHALLENGE_LIFETIME_CEILING)
      expect((await provedMailboxes(db, agentId)).map((held) => held.address)).toHaveLength(3)
    })

    /** The window heals, which is the property a lifetime cap never had. */
    it('lets a citizen ask again once its challenges have left the window', async () => {
      await fillWindow(agentId)
      expect((await mintEmailChallenge(db, agentId, 'blocked@example.org')).outcome).toBe(
        'window_reached',
      )

      await ageOutOfWindow(agentId)

      expect((await mintEmailChallenge(db, agentId, 'fresh@example.org')).outcome).toBe('minted')
    })

    it('bounds each citizen separately', async () => {
      await fillWindow(agentId)

      expect((await mintEmailChallenge(db, otherId, 'fresh@example.org')).outcome).toBe('minted')
    })

    /** What a citizen reads before it asks, rather than only when refused. */
    it('reports the limits and what has been spent against them', async () => {
      const challenge = await mintAndSend(agentId, 'citizen@example.org')
      await expire(challenge.token)

      expect(await emailChallengeLimits(db, agentId)).toMatchObject({
        windowCap: EMAIL_CHALLENGE_WINDOW_CAP,
        ceiling: EMAIL_CHALLENGE_LIFETIME_CEILING,
        openedInWindow: 1,
        openedEver: 1,
        // Null while a slot is free: the answer to *when may I ask again* is
        // *now*, and a date here would say otherwise.
        nextAvailableAt: null,
      })
    })

    /**
     * A repeat naming a different mailbox is refused rather than redirected
     * (`#157`).
     *
     * The rule above — one open challenge per *citizen* — is unchanged, and this
     * is what the caller needs on top of it: the open challenge's code belongs to
     * the first address, so answering the second request by mailing that code to
     * the second address would prove control of one mailbox and credit another.
     */
    it('says an open challenge names a different mailbox than the one asked for', async () => {
      await mintAndSend(agentId, 'citizen@example.org')

      const second = await mintEmailChallenge(db, agentId, 'elsewhere@example.org')

      expect(second).toMatchObject({
        outcome: 'open',
        address: 'citizen@example.org',
        matchesRequested: false,
      })
    })

    it('says it is the same mailbox when the repeat names it again', async () => {
      await mintAndSend(agentId, 'citizen@example.org')

      expect(await mintEmailChallenge(db, agentId, 'citizen@example.org')).toMatchObject({
        outcome: 'open',
        matchesRequested: true,
      })
    })

    /**
     * The comparison is `mailboxIdentity` and not `===`, which is the reason it
     * is computed in SQL. A citizen asking again with the address it already gave
     * — in a different case, or with the `+tag` some clients add — must not be
     * told it named a different mailbox.
     */
    it('treats a +tagged, differently cased repeat as the same mailbox', async () => {
      await mintAndSend(agentId, 'citizen@example.org')

      expect(await mintEmailChallenge(db, agentId, 'Citizen+kolonie@example.org')).toMatchObject({
        outcome: 'open',
        matchesRequested: true,
      })
    })
  })

  /**
   * Challenges left behind by the round trip the rung used to be (`#157`).
   *
   * Before kolonie-docs#92 the agent wrote first and the code was minted when its
   * mail arrived, so a challenge sat open carrying none. The rows are legal —
   * `email_challenges_code_belongs_to_inbox` is `sent_at is null or code is not
   * null` — and nothing can ever complete them, because the flow that would have
   * given them a code is gone.
   *
   * Measured on the production database on 2026-08-01 at 10:50 UTC: 7 such rows
   * across 4 citizens, every open inbox challenge there was. One citizen held 5,
   * which is the whole lifetime cap.
   */
  describe('a challenge left over from the round trip', () => {
    /** An open inbox challenge with no code, as the old flow wrote them. */
    const legacyOpen = async (agent: AgentId, address: string): Promise<void> => {
      await db.insert(emailChallenges).values({
        agentId: agent,
        address,
        token: randomBytes(9).toString('hex'),
        purpose: 'inbox',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      })
    }

    it('does not block a citizen from opening one it can complete', async () => {
      await legacyOpen(agentId, 'from-the-old-flow@example.org')

      const result = await mintEmailChallenge(db, agentId, 'a-mailbox-i-can-read@example.org')

      expect(result.outcome).toBe('minted')
    })

    /**
     * The half that decides whether a citizen is stranded rather than merely
     * inconvenienced. The bounds count how many addresses the Colony agreed to
     * write to, and it never agreed to write to these: the old flow asked it to
     * answer mail, not to send any.
     */
    it('spends neither the window nor the ceiling', async () => {
      for (let index = 0; index < EMAIL_CHALLENGE_WINDOW_CAP; index += 1) {
        await legacyOpen(agentId, `round-trip-${index}@example.org`)
      }

      expect(await emailChallengeLimits(db, agentId)).toMatchObject({
        openedInWindow: 0,
        openedEver: 0,
      })
      expect((await mintEmailChallenge(db, agentId, 'fresh@example.org')).outcome).toBe('minted')
    })

    /** A code-carrying challenge is untouched by any of the above. */
    it('leaves an ordinary open challenge blocking, as it should', async () => {
      await legacyOpen(agentId, 'from-the-old-flow@example.org')
      await mintAndSend(agentId, 'citizen@example.org')

      expect(await mintEmailChallenge(db, agentId, 'citizen@example.org')).toMatchObject({
        outcome: 'open',
        matchesRequested: true,
      })
    })
  })

  describe('one mailbox, one citizen', () => {
    it('refuses to mint against an address another citizen has proved', async () => {
      await earnMailbox(agentId, 'shared@example.org')

      expect(await mintEmailChallenge(db, otherId, 'shared@example.org')).toEqual({
        outcome: 'address_taken',
      })
    })

    it('sees through a change of case', async () => {
      await earnMailbox(agentId, 'shared@example.org')

      expect(await mintEmailChallenge(db, otherId, 'Shared@Example.ORG')).toEqual({
        outcome: 'address_taken',
      })
    })

    /**
     * The rule is enforced by the index, and the early refusal above is only the
     * courteous half of it. Two agents that both minted before either finished
     * race to the end — and the loser must be told the address is taken rather
     * than seeing a constraint violation.
     */
    it('holds when two agents raced past the early check', async () => {
      const mine = await mintAndSend(agentId, 'shared@example.org')
      const theirs = await mintAndSend(otherId, 'shared@example.org')

      expect((await redeemEmailCode(db, agentId, mine.code)).outcome).toBe('verified')
      expect(await redeemEmailCode(db, otherId, theirs.code)).toEqual({ outcome: 'address_taken' })
    })

    /**
     * No `expire` here, and it cannot be added: a verified row cannot be aged
     * past its own deadline, because `email_challenges_verified_before_expiry`
     * refuses it. The point stands without one — a passed challenge is not an
     * *open* challenge, so the one-open-challenge rule does not stand in the way.
     */
    it('lets the same citizen re-prove its own address', async () => {
      await earnMailbox(agentId, 'mine@example.org')

      expect((await mintEmailChallenge(db, agentId, 'mine@example.org')).outcome).toBe('minted')
    })

    /**
     * **This is the test that names `sender_mismatch` as no longer load-bearing**
     * (`kolonie-platform#119`).
     *
     * Plus-addressing used to be closed by accident: `recordInboundMail` compares
     * the claimed address against the envelope sender, and most providers send
     * from the base address whatever tag the mail was received on — so a tagged
     * claim minted fine and then failed at the send. That defence fell out of a
     * check written for a different reason, and the granting node no longer has a
     * send half for it to fall out of.
     *
     * So the assertion is made at the mint, with no mail anywhere in it. Nothing
     * here depends on the sender comparison.
     */
    it('refuses a +tagged variant of a proved address, before any mail is involved', async () => {
      await earnMailbox(agentId, 'citizen@example.org')

      expect(await mintEmailChallenge(db, otherId, 'citizen+kolonie@example.org')).toEqual({
        outcome: 'address_taken',
      })
    })

    it('sees through a tag and a change of case together', async () => {
      await earnMailbox(agentId, 'Citizen+one@Example.ORG')

      expect(await mintEmailChallenge(db, otherId, 'citizen+two@example.org')).toEqual({
        outcome: 'address_taken',
      })
    })

    it('holds against a tag when two agents raced past the early check', async () => {
      const mine = await mintAndSend(agentId, 'racer@example.org')
      const theirs = await mintAndSend(otherId, 'racer+second@example.org')

      expect((await redeemEmailCode(db, agentId, mine.code)).outcome).toBe('verified')
      expect(await redeemEmailCode(db, otherId, theirs.code)).toEqual({ outcome: 'address_taken' })
    })

    it('does not merge two different local parts at the same domain', async () => {
      await earnMailbox(agentId, 'first@example.org')

      expect((await mintEmailChallenge(db, otherId, 'second@example.org')).outcome).toBe('minted')
    })

    /**
     * **A documented limit, asserted so nobody closes it by accident.**
     *
     * `g.regor@gmail.com` and `gregor@gmail.com` are one Gmail inbox and two
     * distinct addresses here. Folding dots would mean encoding one provider's
     * addressing scheme in the schema, and then carrying every provider's — and
     * getting one wrong merges two mailboxes that are genuinely different, which
     * is worse than the gap. The rule is a reach rule, not a Sybil bound (D-044),
     * and a catch-all domain defeats any amount of normalisation anyway.
     */
    it('does not fold provider-specific dots, and that is deliberate', async () => {
      await earnMailbox(agentId, 'gregor@gmail.example')

      expect((await mintEmailChallenge(db, otherId, 'g.regor@gmail.example')).outcome).toBe(
        'minted',
      )
    })

    /**
     * The badge proves the citizen can send *from* the mailbox it already holds,
     * so a verified `send` row is the same citizen and the same mailbox — not a
     * second claim on it. Without the `purpose` clause on the unique index,
     * passing the badge would collide with the grant that made it available.
     */
    it('does not let the badge collide with the grant it depends on', async () => {
      await earnMailbox(agentId, 'citizen@example.org')

      const badge = await mintEmailSendChallenge(db, agentId, 'citizen@example.org')
      if (badge.outcome !== 'minted') throw new Error(badge.outcome)

      expect(
        (await recordInboundMail(db, badge.challenge.token, 'citizen@example.org')).outcome,
      ).toBe('accepted')
    })
  })

  /**
   * D-047, `#136`. A citizen may prove several mailboxes; exactly one is the
   * address the Colony reaches it at, and it is the first one proved.
   *
   * Every test here is about the *second* address, because the first one was
   * never the problem: the defect only appears once a citizen has two, and the
   * code that had it was correct for as long as one was the only possibility.
   */
  describe('several mailboxes, one reach address', () => {
    it('makes the first proved address primary, and leaves it there', async () => {
      await earnMailbox(agentId, 'first@example.org')
      await earnMailbox(agentId, 'second@example.org')

      expect(await provedMailbox(db, agentId)).toMatchObject({ address: 'first@example.org' })
    })

    /**
     * The defect itself, stated as a test. `provedMailbox` read
     * `desc(verified_at)` before this, so the newest proof silently became the
     * address the Colony writes to — and the `email-send` badge, which reads its
     * subject from the grant rather than from a payload (D-018), would have been
     * certified about an address the citizen never demonstrated it could send
     * from.
     */
    it('does not let a later proof take over the badge’s subject', async () => {
      await earnMailbox(agentId, 'earned@example.org')
      const before = await provedMailbox(db, agentId)

      await earnMailbox(agentId, 'newer@example.org')

      expect(await provedMailbox(db, agentId)).toEqual(before)
    })

    /**
     * The reason `#136`'s defect never fired in production, and a defect of its
     * own. `redeemEmailCode` read the citizen's *latest* row, which sorts
     * verified first — so a citizen proving a second mailbox was told
     * `verified` about the address it proved weeks ago, without its code being
     * looked at, and the new challenge stayed unverified for ever.
     */
    it('redeems the code against the challenge that is open, not the one already passed', async () => {
      await earnMailbox(agentId, 'first@example.org')
      const second = await mintAndSend(agentId, 'second@example.org')

      expect(await redeemEmailCode(db, agentId, second.code)).toEqual({
        outcome: 'verified',
        address: 'second@example.org',
      })
    })

    /** And the friendly answer survives where it belongs: asking twice is not an error. */
    it('still tells a citizen that submits its code twice that it has passed', async () => {
      const challenge = await mintAndSend(agentId, 'citizen@example.org')
      await redeemEmailCode(db, agentId, challenge.code)

      expect(await redeemEmailCode(db, agentId, challenge.code)).toEqual({
        outcome: 'verified',
        address: 'citizen@example.org',
      })
    })

    /**
     * `#289`. The register learned about accounts from verdicts alone, so a
     * citizen that proved a second mailbox — challenge, code, promotion — read
     * `mailboxes.list` calling it the reach address and `accounts.list` calling
     * it unproved with no capabilities, and had to decide which to believe. No
     * verdict had named it, because `email-inbox` was already earned and there
     * was no second submission to carry it. Reading the code is the proof; the
     * verdict is not what makes it one.
     */
    it('records the mailbox in the account register when the code is redeemed', async () => {
      await earnMailbox(agentId, 'first@example.org')
      await earnMailbox(agentId, 'second@example.org')

      const held = await listAccounts(db, agentId)
      const mailboxes = held.filter((account) => account.kind === 'mailbox')

      expect(mailboxes.map((account) => account.identifier).sort()).toEqual([
        'first@example.org',
        'second@example.org',
      ])
      for (const mailbox of mailboxes) {
        expect(mailbox.proved).toBe(true)
        expect(mailbox.provedAt).not.toBeNull()
        // Reading a nonce proves reach. Sending is the badge's to add.
        expect(mailbox.capabilities).toEqual(['receive'])
      }
    })

    /**
     * The register write must not fabricate a proof out of an attempt: only the
     * address whose code came back is recorded.
     */
    it('records nothing in the register when the code is wrong', async () => {
      await mintAndSend(agentId, 'never-proved@example.org')

      expect(await redeemEmailCode(db, agentId, 'WRONGCODE1234')).toEqual({
        outcome: 'wrong_code',
      })
      expect(await listAccounts(db, agentId)).toEqual([])
    })

    it('shows the citizen every address it proved, primary first', async () => {
      await earnMailbox(agentId, 'first@example.org')
      await earnMailbox(agentId, 'second@example.org')

      const held = await provedMailboxes(db, agentId)

      expect(held.map((row) => row.address)).toEqual(['first@example.org', 'second@example.org'])
      expect(held.map((row) => row.primary)).toEqual([true, false])
    })

    /**
     * Without this the fix would be a trap: a citizen that loses access to the
     * mailbox it proved first would be reachable only at an address it cannot
     * read, permanently.
     */
    it('moves the reach address when the citizen asks, and only then', async () => {
      await earnMailbox(agentId, 'first@example.org')
      await earnMailbox(agentId, 'second@example.org')

      expect(await promoteMailbox(db, agentId, 'second@example.org')).toEqual({
        outcome: 'promoted',
        address: 'second@example.org',
        sendChallengeClosed: false,
      })
      expect(await provedMailbox(db, agentId)).toMatchObject({ address: 'second@example.org' })

      const held = await provedMailboxes(db, agentId)
      expect(held.filter((row) => row.primary)).toHaveLength(1)
    })

    it('refuses to promote an address this citizen has not proved', async () => {
      await earnMailbox(agentId, 'first@example.org')

      expect(await promoteMailbox(db, agentId, 'never-proved@example.org')).toEqual({
        outcome: 'not_proved',
      })
      expect(await provedMailbox(db, agentId)).toMatchObject({ address: 'first@example.org' })
    })

    it('says so rather than doing nothing when the address is already primary', async () => {
      await earnMailbox(agentId, 'first@example.org')

      expect(await promoteMailbox(db, agentId, 'first@example.org')).toEqual({
        outcome: 'already_primary',
        address: 'first@example.org',
      })
    })

    /**
     * Promotion is a promotion, not a grant. An address another citizen proved
     * is not this citizen's to reach through, and the lookup is keyed on the
     * agent — so there is no argument that could aim this at somebody else's
     * mailbox.
     */
    it('cannot promote an address another citizen holds', async () => {
      const other = otherId
      await earnMailbox(agentId, 'mine@example.org')
      await earnMailbox(other, 'theirs@example.org')

      expect(await promoteMailbox(db, agentId, 'theirs@example.org')).toEqual({
        outcome: 'not_proved',
      })
      expect(await provedMailbox(db, other)).toMatchObject({ address: 'theirs@example.org' })
    })

    /** The index, not the code. Two reach addresses is the state that must not exist. */
    it('refuses a second primary in SQL', async () => {
      await earnMailbox(agentId, 'first@example.org')
      const second = await earnMailbox(agentId, 'second@example.org')

      await expect(
        db
          .update(emailChallenges)
          .set({ primaryAt: sql`now()` })
          .where(eq(emailChallenges.token, second.token)),
      ).rejects.toThrow()
    })
  })

  describe('email-send: the badge', () => {
    const openBadge = async (agent: AgentId) => {
      const grant = await provedMailbox(db, agent)
      if (grant === undefined) throw new Error('no grant')
      const result = await mintEmailSendChallenge(db, agent, grant.address)
      if (result.outcome !== 'minted') throw new Error(result.outcome)
      return result.challenge
    }

    it('has nothing to be about before the mailbox is earned', async () => {
      expect(await provedMailbox(db, agentId)).toBeUndefined()
    })

    it('reads the address from the grant, not from anything the agent supplies', async () => {
      await earnMailbox(agentId, 'citizen@example.org')

      expect(await provedMailbox(db, agentId)).toMatchObject({ address: 'citizen@example.org' })
    })

    it('passes when mail arrives from the granted address', async () => {
      await earnMailbox(agentId, 'citizen@example.org')
      const badge = await openBadge(agentId)

      expect(await recordInboundMail(db, badge.token, 'citizen@example.org')).toEqual({
        outcome: 'accepted',
        address: 'citizen@example.org',
      })
      expect((await latestEmailSendChallenge(db, agentId))?.verifiedAt).not.toBeNull()
    })

    /**
     * **The register learns `send` from the mail, not from the verdict**
     * (`#297`).
     *
     * `#289` did this for the inbox half and left this one to the badge's
     * verdict, which is the same gap one capability over: a citizen proving
     * `send` for a *second* mailbox has already passed that badge, and `#292`
     * refuses a passed rung permanently — so nothing would record what the
     * Colony had just watched happen. A citizen read `proved: false,
     * capabilities: []` for the address the Colony itself writes to, and that is
     * how this was found.
     */
    it('records the send capability when the mail arrives, without waiting for a verdict', async () => {
      await earnMailbox(agentId, 'citizen@example.org')
      const badge = await openBadge(agentId)

      await recordInboundMail(db, badge.token, 'citizen@example.org')

      const [mailbox] = await listAccounts(db, agentId, AccountKindSchema.parse('mailbox'))
      expect(mailbox).toMatchObject({ identifier: 'citizen@example.org', proved: true })
      // Receiving came from the inbox half; sending is what this call proved.
      // Neither implies the other, and both are on record.
      expect([...(mailbox?.capabilities ?? [])].sort()).toEqual(['receive', 'send'])
    })

    it('records nothing when the mail is refused', async () => {
      await earnMailbox(agentId, 'citizen@example.org')
      const badge = await openBadge(agentId)

      await recordInboundMail(db, badge.token, 'somewhere-else@example.org')

      const [mailbox] = await listAccounts(db, agentId, AccountKindSchema.parse('mailbox'))
      expect(mailbox?.capabilities).toEqual(['receive'])
    })

    /**
     * The whole point of reading the address from the grant. A citizen that lost
     * the mailbox it proved must not be able to hand in a different one it holds
     * today — the badge would then certify nothing about the address the Colony
     * actually reaches it at.
     */
    it('refuses mail from an address other than the one in the grant', async () => {
      await earnMailbox(agentId, 'citizen@example.org')
      const badge = await openBadge(agentId)

      expect(await recordInboundMail(db, badge.token, 'somewhere-else@example.org')).toEqual({
        outcome: 'sender_mismatch',
      })
      expect((await latestEmailSendChallenge(db, agentId))?.verifiedAt).toBeNull()
    })

    /**
     * `#287`, reported by a citizen that promoted, was told to send from the new
     * address, sent from exactly that, and failed twice. The challenge records
     * the sender it will accept at mint time, so a promotion left it waiting for
     * an address that had stopped being the subject of the badge — a state no
     * honest mail could resolve.
     */
    it('closes an open badge challenge when the reach address moves out from under it', async () => {
      await earnMailbox(agentId, 'first@example.org')
      await earnMailbox(agentId, 'second@example.org')
      const stale = await openBadge(agentId)

      expect(await promoteMailbox(db, agentId, 'second@example.org')).toEqual({
        outcome: 'promoted',
        address: 'second@example.org',
        sendChallengeClosed: true,
      })

      // Expired rather than deleted: the citizen asked, and that stays on record.
      expect(await recordInboundMail(db, stale.token, 'first@example.org')).toEqual({
        outcome: 'expired',
      })

      // And the next ask mints against the address that is now the reach one,
      // which is the whole remedy.
      const fresh = await mintEmailSendChallenge(db, agentId, 'second@example.org')
      expect(fresh.outcome).toBe('minted')
      if (fresh.outcome !== 'minted') throw new Error(fresh.outcome)

      expect(await recordInboundMail(db, fresh.challenge.token, 'second@example.org')).toEqual({
        outcome: 'accepted',
        address: 'second@example.org',
      })
    })

    /**
     * `#307`, reported by the citizen the `#287` fix did not reach. Closing the
     * challenge inside the promotion is right and it only ever runs while a
     * promotion is running — so a row minted before that shipped stayed open
     * against the old address for its full 24 hours, and the citizen was handed
     * it again on every ask with no way to satisfy it.
     *
     * This drives the state directly rather than through `promoteMailbox`,
     * because that is the state: an open challenge naming an address that is no
     * longer the one the caller was granted, however it got there.
     */
    it('closes and reissues a challenge left open against another address', async () => {
      await earnMailbox(agentId, 'first@example.org')
      const stale = await openBadge(agentId)

      const fresh = await mintEmailSendChallenge(db, agentId, 'second@example.org')

      expect(fresh).toMatchObject({ outcome: 'minted', reissued: true })
      if (fresh.outcome !== 'minted') throw new Error(fresh.outcome)
      expect(fresh.challenge.token).not.toBe(stale.token)

      // The old one is closed by expiry, not deleted — the citizen asked, and
      // the verifier's answer is the true and actionable one.
      expect(await recordInboundMail(db, stale.token, 'first@example.org')).toEqual({
        outcome: 'expired',
      })
      expect(await recordInboundMail(db, fresh.challenge.token, 'second@example.org')).toEqual({
        outcome: 'accepted',
        address: 'second@example.org',
      })
    })

    /**
     * The other half, and the one that would make the fix worse than the defect:
     * an ordinary second ask must find its own challenge rather than replace it,
     * or every repeat call resets a deadline and discards a code in flight.
     */
    it('hands back the same challenge when the address has not moved', async () => {
      await earnMailbox(agentId, 'citizen@example.org')
      const first = await openBadge(agentId)

      const again = await mintEmailSendChallenge(db, agentId, 'citizen@example.org')

      expect(again).toMatchObject({ outcome: 'open', address: 'citizen@example.org' })
      if (again.outcome !== 'open') throw new Error(again.outcome)
      expect(again.challenge.token).toBe(first.token)
    })

    /**
     * `mailboxIdentity` decides what *the same inbox* means everywhere else, and
     * a `+tag` reading as a move would expire a live challenge for nothing.
     */
    it('does not read a +tagged form of the same address as a move', async () => {
      await earnMailbox(agentId, 'citizen@example.org')
      const first = await openBadge(agentId)

      const again = await mintEmailSendChallenge(db, agentId, 'citizen+badge@example.org')

      expect(again.outcome).toBe('open')
      if (again.outcome !== 'open') throw new Error(again.outcome)
      expect(again.challenge.token).toBe(first.token)
    })

    /**
     * The badge is earned once and a promotion is explicitly not a revocation,
     * so the close must be able to tell an open challenge from a passed one.
     */
    it('leaves a verified badge challenge alone when the reach address moves', async () => {
      await earnMailbox(agentId, 'first@example.org')
      await earnMailbox(agentId, 'second@example.org')
      const earned = await openBadge(agentId)
      await recordInboundMail(db, earned.token, 'first@example.org')

      expect(await promoteMailbox(db, agentId, 'second@example.org')).toMatchObject({
        sendChallengeClosed: false,
      })
      expect((await latestEmailSendChallenge(db, agentId))?.verifiedAt).not.toBeNull()
    })

    it('pays once — a second claim finds the badge already held', async () => {
      await earnMailbox(agentId, 'citizen@example.org')
      const badge = await openBadge(agentId)
      await recordInboundMail(db, badge.token, 'citizen@example.org')

      const again = await mintEmailSendChallenge(db, agentId, 'citizen@example.org')

      // Verified rows are not "open", so a fresh challenge is what storage
      // returns — the refusal belongs to the layer that reads the verdict, and
      // it is asserted there. What matters here is that the pass is on record
      // and a redelivery cannot double-count it.
      expect((await latestEmailSendChallenge(db, agentId))?.verifiedAt).not.toBeNull()
      expect(again.outcome).toBe('minted')
    })

    it('answers a redelivered mail without counting it twice', async () => {
      await earnMailbox(agentId, 'citizen@example.org')
      const badge = await openBadge(agentId)

      const first = await recordInboundMail(db, badge.token, 'citizen@example.org')
      const second = await recordInboundMail(db, badge.token, 'citizen@example.org')

      expect(first.outcome).toBe('accepted')
      expect(second).toEqual({ outcome: 'already_received', address: 'citizen@example.org' })
    })

    it('does not know a token it never minted', async () => {
      expect(await recordInboundMail(db, 'deadbeefdeadbeefde', 'citizen@example.org')).toEqual({
        outcome: 'unknown_token',
      })
    })

    it('refuses mail that arrives after the challenge expired', async () => {
      await earnMailbox(agentId, 'citizen@example.org')
      const badge = await openBadge(agentId)
      await expire(badge.token)

      expect(await recordInboundMail(db, badge.token, 'citizen@example.org')).toEqual({
        outcome: 'expired',
      })
    })

    /**
     * The two nodes never satisfy each other, the same discipline
     * `browser_challenges` holds between the rung and the CAPTCHA badge. A mail
     * sent to a granting challenge's token is a mail to a token that node never
     * asked anyone to write to.
     */
    it('cannot be passed by writing to a granting challenge’s token', async () => {
      const granting = await mintAndSend(agentId, 'citizen@example.org')

      expect(await recordInboundMail(db, granting.token, 'citizen@example.org')).toEqual({
        outcome: 'unknown_token',
      })
    })
  })

  /**
   * What the Colony has watched happen when citizens sent from one provider
   * (`#615`).
   *
   * Counted over the challenges themselves rather than against a list of
   * providers, because which providers can send is a fact about the outside
   * world that goes stale without telling anybody.
   */
  describe('the record of sending from a provider', () => {
    /** A badge challenge that ran out with no mail — the evidence this counts. */
    const strandedAt = async (agent: AgentId, address: string) => {
      await earnMailbox(agent, address)
      const badge = await mintEmailSendChallenge(db, agent, address)
      if (badge.outcome !== 'minted') throw new Error(badge.outcome)
      await db
        .update(emailChallenges)
        .set({
          createdAt: sql`now() - interval '10 days'`,
          expiresAt: sql`now() - interval '9 days'`,
        })
        .where(eq(emailChallenges.token, badge.challenge.token))
    }

    it('counts distinct citizens who ran out, and none who are still trying', async () => {
      await strandedAt(agentId, 'first@shut.example')
      // Open, not expired: it has not failed and has not finished, and counting
      // it would warn a citizen about its own attempt in progress.
      const third = await register('still-going')
      await earnMailbox(third, 'third@shut.example')
      await mintEmailSendChallenge(db, third, 'third@shut.example')

      expect(await sendingRecordFor(db, 'mine@shut.example')).toEqual({
        domain: 'shut.example',
        proved: 0,
        triedWithout: 1,
      })
    })

    it('is a fact about the domain and not about the address', async () => {
      await strandedAt(agentId, 'one@shut.example')
      await strandedAt(otherId, 'two@shut.example')

      expect(await sendingRecordFor(db, 'THIRD@Shut.Example')).toMatchObject({
        domain: 'shut.example',
        triedWithout: 2,
      })
    })

    /** The rejection case: another provider's record is not this one's. */
    it('says nothing about a provider nobody has tried', async () => {
      await strandedAt(agentId, 'one@shut.example')

      expect(await sendingRecordFor(db, 'someone@unwatched.example')).toEqual({
        domain: 'unwatched.example',
        proved: 0,
        triedWithout: 0,
      })
    })
  })

  describe('what the database refuses regardless of this module', () => {
    /**
     * The constraint name, dug out of the error chain.
     *
     * `rejects.toThrow(/name/)` does not work here: Drizzle wraps the driver's
     * error in its own "Failed query: …", and the constraint — like the SQLSTATE
     * — lives on the `cause`. Matching the top-level message would silently
     * assert nothing about *which* constraint fired, which for a table with four
     * of them is most of the point.
     */
    const constraintFrom = (error: unknown): string | undefined => {
      let current: unknown = error
      while (current !== null && typeof current === 'object') {
        const named = current as { constraint_name?: string; cause?: unknown }
        if (typeof named.constraint_name === 'string') return named.constraint_name
        current = named.cause
      }
      return undefined
    }

    const expectRefusal = async (write: Promise<unknown>, constraint: string) => {
      await expect(write.then(() => constraintFrom(undefined))).rejects.toSatisfy(
        (error: unknown) => constraintFrom(error) === constraint,
      )
    }

    it('refuses a verdict on a granting challenge whose mail never went out', async () => {
      const challenge = await mint(agentId, 'citizen@example.org')

      await expectRefusal(
        db
          .update(emailChallenges)
          .set({ verifiedAt: sql`now()` })
          .where(eq(emailChallenges.token, challenge.token)),
        'email_challenges_verdict_needs_its_evidence',
      )
    })

    it('refuses a verdict on a badge challenge that received no mail', async () => {
      await earnMailbox(agentId, 'citizen@example.org')
      const badge = await mintEmailSendChallenge(db, agentId, 'citizen@example.org')
      if (badge.outcome !== 'minted') throw new Error(badge.outcome)

      await expectRefusal(
        db
          .update(emailChallenges)
          .set({ verifiedAt: sql`now()` })
          .where(eq(emailChallenges.token, badge.challenge.token)),
        'email_challenges_verdict_needs_its_evidence',
      )
    })
  })
})
