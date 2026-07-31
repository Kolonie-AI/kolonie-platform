import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { and, eq, sql } from 'drizzle-orm'
import { RegisterAgentRequestSchema, type AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { emailChallenges } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import {
  EMAIL_CHALLENGE_LIFETIME_CAP,
  latestEmailChallenge,
  latestEmailSendChallenge,
  markEmailSent,
  mintEmailChallenge,
  mintEmailSendChallenge,
  provedMailbox,
  recordInboundMail,
  redeemEmailCode,
} from './email.js'

const target = databaseTestTarget()

if (!target.available) {
  console.warn(`\n${target.reason}\n`)
}

describe.skipIf(!target.available)('the mailbox nodes', () => {
  let db: Database
  let agentId: AgentId
  let otherId: AgentId

  beforeAll(async () => {
    if (!target.available) return
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
     * **The ceiling that is per-agent rather than per-unit-time.** Counted across
     * every address ever named and never reset — a citizen that cannot prove an
     * inbox in five tries has a problem a sixth mail does not solve.
     */
    it('refuses past the lifetime cap, counting every address ever named', async () => {
      for (let index = 0; index < EMAIL_CHALLENGE_LIFETIME_CAP; index += 1) {
        const challenge = await mintAndSend(agentId, `try-${index}@example.org`)
        await expire(challenge.token)
      }

      expect(await mintEmailChallenge(db, agentId, 'one-more@example.org')).toEqual({
        outcome: 'cap_reached',
        cap: EMAIL_CHALLENGE_LIFETIME_CAP,
      })
    })

    it('bounds each citizen separately', async () => {
      for (let index = 0; index < EMAIL_CHALLENGE_LIFETIME_CAP; index += 1) {
        const challenge = await mintAndSend(agentId, `try-${index}@example.org`)
        await expire(challenge.token)
      }

      expect((await mintEmailChallenge(db, otherId, 'fresh@example.org')).outcome).toBe('minted')
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
