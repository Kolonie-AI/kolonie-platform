import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { RegisterAgentRequestSchema, type AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { emailChallenges } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import {
  latestEmailChallenge,
  mintEmailChallenge,
  recordInboundMail,
  redeemEmailCode,
} from './email.js'

const target = databaseTestTarget()

if (!target.available) {
  console.warn(`\n${target.reason}\n`)
}

describe.skipIf(!target.available)('email round trip', () => {
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

  const mint = async (agent: AgentId, address: string) => {
    const result = await mintEmailChallenge(db, agent, address)
    if (result.outcome !== 'minted') throw new Error(result.outcome)
    return result.challenge
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

  /** The whole rung, start to finish. Used wherever a *passed* agent is needed. */
  const completeRoundTrip = async (agent: AgentId, address: string) => {
    const challenge = await mint(agent, address)
    const inbound = await recordInboundMail(db, challenge.token, address)
    if (inbound.outcome !== 'accepted') throw new Error(inbound.outcome)
    const redeemed = await redeemEmailCode(db, agent, inbound.code)
    if (redeemed.outcome !== 'verified') throw new Error(redeemed.outcome)
    return { challenge, code: inbound.code }
  }

  describe('the happy path', () => {
    it('passes only after both halves — sending and reading', async () => {
      const challenge = await mint(agentId, 'citizen@example.org')

      // Minted, nothing proved yet.
      expect(await latestEmailChallenge(db, agentId)).toMatchObject({
        address: 'citizen@example.org',
        inboundAt: null,
        verifiedAt: null,
      })

      const inbound = await recordInboundMail(db, challenge.token, 'citizen@example.org')
      expect(inbound.outcome).toBe('accepted')

      // The send half is proved; the receive half is not.
      const afterSending = await latestEmailChallenge(db, agentId)
      expect(afterSending?.inboundAt).not.toBeNull()
      expect(afterSending?.verifiedAt).toBeNull()

      if (inbound.outcome !== 'accepted') throw new Error('unreachable')
      expect(await redeemEmailCode(db, agentId, inbound.code)).toEqual({
        outcome: 'verified',
        address: 'citizen@example.org',
      })

      expect((await latestEmailChallenge(db, agentId))?.verifiedAt).not.toBeNull()
    })

    it('replies to the address that wrote in, not to some other field', async () => {
      const challenge = await mint(agentId, 'citizen@example.org')
      const inbound = await recordInboundMail(db, challenge.token, 'citizen@example.org')

      if (inbound.outcome !== 'accepted') throw new Error(inbound.outcome)
      expect(inbound.replyTo).toBe('citizen@example.org')
    })

    it('keeps a pass permanent when a later attempt is abandoned', async () => {
      await completeRoundTrip(agentId, 'citizen@example.org')
      await mint(agentId, 'second@example.org')

      // The newer row is unverified. Reading "the latest" naively would report
      // this citizen as having never passed the rung it did pass.
      expect((await latestEmailChallenge(db, agentId))?.verifiedAt).not.toBeNull()
    })
  })

  describe('proving you can send', () => {
    it('refuses mail from an address other than the one claimed', async () => {
      const challenge = await mint(agentId, 'citizen@example.org')

      expect(await recordInboundMail(db, challenge.token, 'somebody-else@example.org')).toEqual({
        outcome: 'sender_mismatch',
      })
      expect((await latestEmailChallenge(db, agentId))?.inboundAt).toBeNull()
    })

    it('ignores the case a mail client applied to the sender', async () => {
      const challenge = await mint(agentId, 'citizen@example.org')

      expect((await recordInboundMail(db, challenge.token, 'Citizen@Example.ORG')).outcome).toBe(
        'accepted',
      )
    })

    it('does not know a token it never minted', async () => {
      expect(await recordInboundMail(db, 'deadbeefdeadbeefde', 'citizen@example.org')).toEqual({
        outcome: 'unknown_token',
      })
    })

    it('refuses mail that arrives after the challenge expired', async () => {
      const challenge = await mint(agentId, 'citizen@example.org')
      await expire(challenge.token)

      expect(await recordInboundMail(db, challenge.token, 'citizen@example.org')).toEqual({
        outcome: 'expired',
      })
    })

    /**
     * SMTP retries. A second delivery of the same message must not mint a second
     * code — the agent has already read the first one, and replying with a new
     * one would invalidate the code it is holding.
     */
    it('answers a redelivered mail with the same code', async () => {
      const challenge = await mint(agentId, 'citizen@example.org')

      const first = await recordInboundMail(db, challenge.token, 'citizen@example.org')
      const second = await recordInboundMail(db, challenge.token, 'citizen@example.org')

      if (first.outcome !== 'accepted') throw new Error(first.outcome)
      expect(second).toEqual({
        outcome: 'already_received',
        code: first.code,
        replyTo: 'citizen@example.org',
      })
    })
  })

  describe('proving you can read', () => {
    it('refuses a wrong code', async () => {
      const challenge = await mint(agentId, 'citizen@example.org')
      await recordInboundMail(db, challenge.token, 'citizen@example.org')

      expect(await redeemEmailCode(db, agentId, 'AAAAAAAAAAAA')).toEqual({ outcome: 'wrong_code' })
      expect((await latestEmailChallenge(db, agentId))?.verifiedAt).toBeNull()
    })

    /**
     * The distinction that decides what the agent should do next. "No mail has
     * arrived" means send one; "wrong code" means read more carefully. Collapsing
     * both into a failure is how an agent spends an hour on the wrong problem.
     */
    it('separates "nothing has arrived yet" from "that code is wrong"', async () => {
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
      const challenge = await mint(agentId, 'citizen@example.org')
      const inbound = await recordInboundMail(db, challenge.token, 'citizen@example.org')
      await expire(challenge.token)

      if (inbound.outcome !== 'accepted') throw new Error(inbound.outcome)
      expect(await redeemEmailCode(db, agentId, inbound.code)).toEqual({ outcome: 'expired' })
    })

    it('accepts the code as the agent read it, whitespace and case included', async () => {
      const challenge = await mint(agentId, 'citizen@example.org')
      const inbound = await recordInboundMail(db, challenge.token, 'citizen@example.org')

      if (inbound.outcome !== 'accepted') throw new Error(inbound.outcome)
      expect((await redeemEmailCode(db, agentId, `  ${inbound.code.toLowerCase()} `)).outcome).toBe(
        'verified',
      )
    })

    /**
     * A code is twelve characters. Looked up by code alone, anyone holding one
     * could close somebody else's rung — so the agent id is half of the check,
     * not context.
     */
    it('will not let one agent redeem another agent’s code', async () => {
      const challenge = await mint(agentId, 'citizen@example.org')
      const inbound = await recordInboundMail(db, challenge.token, 'citizen@example.org')

      // The other agent is taken all the way to its own open code, so this
      // reaches the comparison rather than being turned away earlier for having
      // sent nothing. Otherwise the test would pass without exercising the rule.
      const theirs = await mint(otherId, 'other@example.org')
      await recordInboundMail(db, theirs.token, 'other@example.org')

      if (inbound.outcome !== 'accepted') throw new Error(inbound.outcome)
      expect(await redeemEmailCode(db, otherId, inbound.code)).toEqual({ outcome: 'wrong_code' })
      expect((await latestEmailChallenge(db, agentId))?.verifiedAt).toBeNull()
    })

    it('is single use — a code cannot close two challenges', async () => {
      const { code } = await completeRoundTrip(agentId, 'citizen@example.org')

      // Already verified, so the second call reports the settled state rather
      // than passing anything a second time.
      expect(await redeemEmailCode(db, agentId, code)).toEqual({
        outcome: 'verified',
        address: 'citizen@example.org',
      })
    })
  })

  describe('one mailbox, one citizen', () => {
    it('refuses to mint against an address another citizen has proved', async () => {
      await completeRoundTrip(agentId, 'shared@example.org')

      expect(await mintEmailChallenge(db, otherId, 'shared@example.org')).toEqual({
        outcome: 'address_taken',
      })
    })

    it('sees through a change of case', async () => {
      await completeRoundTrip(agentId, 'shared@example.org')

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
      const mine = await mint(agentId, 'shared@example.org')
      const theirs = await mint(otherId, 'shared@example.org')

      const first = await recordInboundMail(db, mine.token, 'shared@example.org')
      const second = await recordInboundMail(db, theirs.token, 'shared@example.org')
      if (first.outcome !== 'accepted' || second.outcome !== 'accepted') throw new Error('setup')

      expect((await redeemEmailCode(db, agentId, first.code)).outcome).toBe('verified')
      expect(await redeemEmailCode(db, otherId, second.code)).toEqual({ outcome: 'address_taken' })
    })

    it('lets the same citizen re-prove its own address', async () => {
      await completeRoundTrip(agentId, 'mine@example.org')

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
     * check written for a different reason, and `#92` removes the send half
     * entirely.
     *
     * So the assertion is deliberately made **at the mint**, with no inbound mail
     * anywhere in it. Nothing here depends on the sender comparison, and the day
     * that comparison goes, this test does not change.
     */
    it('refuses a +tagged variant of a proved address, before any mail is involved', async () => {
      await completeRoundTrip(agentId, 'citizen@example.org')

      expect(await mintEmailChallenge(db, otherId, 'citizen+kolonie@example.org')).toEqual({
        outcome: 'address_taken',
      })
    })

    it('sees through a tag and a change of case together', async () => {
      await completeRoundTrip(agentId, 'Citizen+one@Example.ORG')

      expect(await mintEmailChallenge(db, otherId, 'citizen+two@example.org')).toEqual({
        outcome: 'address_taken',
      })
    })

    /**
     * The index carries the rule; the early refusal is only the courteous half.
     * The pair above proves the courteous half sees a tag — this proves the
     * enforcing half does, which is the one that matters when two agents both
     * minted before either finished.
     */
    it('holds against a tag when two agents raced past the early check', async () => {
      const mine = await mint(agentId, 'racer@example.org')
      const theirs = await mint(otherId, 'racer+second@example.org')

      const first = await recordInboundMail(db, mine.token, 'racer@example.org')
      const second = await recordInboundMail(db, theirs.token, 'racer+second@example.org')
      if (first.outcome !== 'accepted' || second.outcome !== 'accepted') throw new Error('setup')

      expect((await redeemEmailCode(db, agentId, first.code)).outcome).toBe('verified')
      expect(await redeemEmailCode(db, otherId, second.code)).toEqual({ outcome: 'address_taken' })
    })

    it('does not merge two different local parts at the same domain', async () => {
      await completeRoundTrip(agentId, 'first@example.org')

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
      await completeRoundTrip(agentId, 'gregor@gmail.example')

      expect((await mintEmailChallenge(db, otherId, 'g.regor@gmail.example')).outcome).toBe(
        'minted',
      )
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
    const constraintViolatedBy = async (run: Promise<unknown>): Promise<string> => {
      try {
        await run
        return 'nothing was refused'
      } catch (error) {
        for (let current: unknown = error; current != null; current = cause(current)) {
          // `constraint_name` is what postgres.js calls it; `constraint` is what
          // node-postgres calls it. Reading only one of them finds nothing, and
          // the helper then reports "no constraint named" for a violation that
          // fired perfectly well — which asserts the opposite of the truth.
          const named = current as { constraint_name?: unknown; constraint?: unknown }
          if (typeof named.constraint_name === 'string') return named.constraint_name
          if (typeof named.constraint === 'string') return named.constraint
        }
        return `no constraint named in: ${String(error)}`
      }
    }

    const cause = (error: unknown): unknown =>
      typeof error === 'object' && error !== null && 'cause' in error
        ? (error as { cause?: unknown }).cause
        : undefined

    /**
     * The constraint the whole rung rests on. If anything ever sets `verified_at`
     * without an inbound mail, a two-way proof silently becomes no proof — and
     * the row would look exactly like a passed one.
     */
    it('will not record a pass without a mail having arrived', async () => {
      const challenge = await mint(agentId, 'citizen@example.org')

      expect(
        await constraintViolatedBy(
          db
            .update(emailChallenges)
            .set({ verifiedAt: sql`now()` })
            .where(eq(emailChallenges.token, challenge.token)),
        ),
      ).toBe('email_challenges_verified_needs_inbound')
    })

    it('will not hold a code for a mail that never arrived', async () => {
      const challenge = await mint(agentId, 'citizen@example.org')

      expect(
        await constraintViolatedBy(
          db
            .update(emailChallenges)
            .set({ code: 'AAAAAAAAAAAA' })
            .where(eq(emailChallenges.token, challenge.token)),
        ),
      ).toBe('email_challenges_code_needs_inbound')
    })

    it('will not record a pass after the challenge expired', async () => {
      const challenge = await mint(agentId, 'citizen@example.org')
      await recordInboundMail(db, challenge.token, 'citizen@example.org')
      await db
        .update(emailChallenges)
        .set({
          createdAt: sql`now() - interval '48 hours'`,
          expiresAt: sql`now() - interval '1 hour'`,
        })
        .where(eq(emailChallenges.token, challenge.token))

      expect(
        await constraintViolatedBy(
          db
            .update(emailChallenges)
            .set({ verifiedAt: sql`now()` })
            .where(eq(emailChallenges.token, challenge.token)),
        ),
      ).toBe('email_challenges_verified_before_expiry')
    })
  })
})
