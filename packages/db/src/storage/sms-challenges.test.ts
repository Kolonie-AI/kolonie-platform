import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { now as currentTime, RegisterAgentRequestSchema, type AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { smsChallenges } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { listAccounts } from './accounts.js'
import { registerAgent } from './agents.js'
import {
  latestSmsChallenge,
  markSmsSendFailed,
  markSmsSent,
  mintSmsReceiveChallenge,
  mintSmsSendChallenge,
  recordInboundSms,
  redeemSmsCode,
} from './sms-challenges.js'

const target = databaseTestTarget()

/**
 * The two phone nodes against a real PostgreSQL (`#411`).
 *
 * **Every number here is invented.** `+1500555xxxx` is Twilio's documented
 * magic range and reaches nobody; the German-looking numbers are inside
 * `+4915` ranges that are not allocated. The Definition of Done says no number
 * belonging to a person appears in a fixture, and that is a rule about this
 * file more than any other — it is the one somebody will copy a number out of.
 *
 * The cases are the ones the issue names, and each is a place where a plausible
 * implementation is silently wrong: a code redeemed after expiry, a code
 * redeemed twice, a code redeemed by the citizen it was not issued to, a nonce
 * from a number that already certifies somebody else.
 */
describe('the phone nodes', () => {
  let db: Database
  let agentId: AgentId
  let otherId: AgentId

  const CITIZEN_NUMBER = '+15005550006'
  const OTHER_NUMBER = '+15005550007'

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
    agentId = await register('dialtone')
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

  /** Mint, without pretending the message went out. */
  const mint = async (agent: AgentId, number: string) => {
    const result = await mintSmsReceiveChallenge(db, agent, number)
    if (result.outcome !== 'minted') throw new Error(result.outcome)
    return result.challenge
  }

  /** Mint and record delivery — what the API does when the vendor accepts. */
  const mintAndSend = async (agent: AgentId, number: string) => {
    const challenge = await mint(agent, number)
    await markSmsSent(db, challenge.id)
    return challenge
  }

  const expire = async (challengeId: string) => {
    await db
      .update(smsChallenges)
      .set({
        createdAt: sql`now() - interval '96 hours'`,
        expiresAt: sql`now() - interval '1 hour'`,
      })
      .where(eq(smsChallenges.id, challengeId))
  }

  describe('sms-receive', () => {
    it('records a proved number in the register, with receive and not send', async () => {
      const challenge = await mintAndSend(agentId, CITIZEN_NUMBER)

      expect(await redeemSmsCode(db, agentId, challenge.code)).toEqual({
        outcome: 'verified',
        number: CITIZEN_NUMBER,
      })

      const accounts = await listAccounts(db, agentId)
      const phone = accounts.find((account) => account.kind === 'phone')

      expect(phone?.identifier).toBe(CITIZEN_NUMBER)
      expect(phone?.proved).toBe(true)
      // **`send` is never claimed here**, which is the acceptance criterion that
      // *can send* is set by passing the badge and never by the citizen.
      expect(phone?.capabilities).toEqual(['receive'])
    })

    it('refuses a code reported after the challenge expired', async () => {
      const challenge = await mintAndSend(agentId, CITIZEN_NUMBER)
      await expire(challenge.id)

      // No open challenge is left, so the citizen is told the window closed
      // rather than that its code was wrong — those need opposite next actions.
      expect(await redeemSmsCode(db, agentId, challenge.code)).toEqual({ outcome: 'expired' })
    })

    it('refuses a code reported twice, and says the first one already passed', async () => {
      const challenge = await mintAndSend(agentId, CITIZEN_NUMBER)
      await redeemSmsCode(db, agentId, challenge.code)

      // Not an error: a citizen that submits its code again has no open
      // challenge and is told it already passed, which is the friendlier and
      // the more accurate answer.
      expect(await redeemSmsCode(db, agentId, challenge.code)).toEqual({
        outcome: 'verified',
        number: CITIZEN_NUMBER,
      })
    })

    it('refuses a code reported by the citizen it was not issued to', async () => {
      const challenge = await mintAndSend(agentId, CITIZEN_NUMBER)

      // The other citizen has never opened one, so there is nothing of its own
      // to redeem against — and the code it is holding is not a way in.
      expect(await redeemSmsCode(db, otherId, challenge.code)).toEqual({
        outcome: 'no_open_challenge',
      })

      // And the real holder is unaffected.
      expect(await redeemSmsCode(db, agentId, challenge.code)).toMatchObject({
        outcome: 'verified',
      })
    })

    it('refuses a code before the Colony has sent anything', async () => {
      const challenge = await mint(agentId, CITIZEN_NUMBER)

      expect(await redeemSmsCode(db, agentId, challenge.code)).toEqual({
        outcome: 'nothing_sent_yet',
      })
    })

    /**
     * **A repeat request returns the challenge and does not mint a second**,
     * which is what makes the Colony's spend a function of the number of
     * citizens rather than of the number of requests.
     */
    it('hands back the open challenge rather than opening another', async () => {
      const first = await mintAndSend(agentId, CITIZEN_NUMBER)
      const again = await mintSmsReceiveChallenge(db, agentId, CITIZEN_NUMBER)

      expect(again.outcome).toBe('open')
      if (again.outcome !== 'open') throw new Error('expected an open challenge')
      expect(again.challenge.id).toBe(first.id)
      expect(again.sent).toBe(true)
      expect(again.matchesRequested).toBe(true)
    })

    /**
     * **A refused send leaves the challenge standing**, so asking again retries
     * it. A citizen holding an undeliverable challenge it cannot replace is a
     * citizen that can never pass the rung.
     */
    it('leaves a challenge whose send was refused open, and says why', async () => {
      const challenge = await mint(agentId, CITIZEN_NUMBER)
      await markSmsSendFailed(db, challenge.id, 'the destination is not on the allowlist')

      const state = await latestSmsChallenge(db, agentId, 'receive')
      expect(state?.sendFailure).toBe('the destination is not on the allowlist')
      expect(state?.sentAt).toBeNull()

      const again = await mintSmsReceiveChallenge(db, agentId, CITIZEN_NUMBER)
      expect(again.outcome).toBe('open')
      if (again.outcome !== 'open') throw new Error('expected an open challenge')
      // Not sent, so the caller knows to try the send again rather than to wait.
      expect(again.sent).toBe(false)
    })

    it('keeps an unsent challenge until replacement is explicit', async () => {
      const first = await mint(agentId, CITIZEN_NUMBER)

      const again = await mintSmsReceiveChallenge(db, agentId, OTHER_NUMBER)

      expect(again.outcome).toBe('open')
      if (again.outcome !== 'open') throw new Error('expected an open challenge')
      expect(again.challenge.id).toBe(first.id)
      expect(again.matchesRequested).toBe(false)
      expect(again.sent).toBe(false)
    })

    it('replaces an unsent challenge with one for the newly requested number', async () => {
      const first = await mint(agentId, CITIZEN_NUMBER)
      await markSmsSendFailed(db, first.id, 'the destination is not on the allowlist')

      const replacement = await mintSmsReceiveChallenge(db, agentId, OTHER_NUMBER, true)

      expect(replacement.outcome).toBe('minted')
      if (replacement.outcome !== 'minted') throw new Error('expected a minted challenge')
      expect(replacement.challenge.id).not.toBe(first.id)
      expect(replacement.challenge.number).toBe(OTHER_NUMBER)

      const rows = await db
        .select({ id: smsChallenges.id, expiresAt: smsChallenges.expiresAt })
        .from(smsChallenges)
        .where(eq(smsChallenges.agentId, agentId))
      expect(rows).toHaveLength(2)
      expect(
        new Date(rows.find((row) => row.id === first.id)?.expiresAt ?? 0).getTime(),
      ).toBeLessThanOrEqual(Date.now())
    })

    /**
     * **A delivered challenge is replaceable too** (`#702`).
     *
     * `#634` stopped at the undelivered case, which left the expensive one
     * unfixed: a code texted to a number the citizen turns out not to hold — a
     * public free-inbox number, a handset nobody will read — locked the rung for
     * the challenge's full three days. The spend argument for refusing belongs
     * to `DEFAULT_SMS_LIMITS`, which caps a citizen at five messages a day
     * whichever challenge they are on, so this clause was costing the citizen
     * without saving the Colony anything.
     */
    it('replaces a challenge whose message was already delivered', async () => {
      const first = await mintAndSend(agentId, CITIZEN_NUMBER)

      const replacement = await mintSmsReceiveChallenge(db, agentId, OTHER_NUMBER, true)

      expect(replacement.outcome).toBe('minted')
      if (replacement.outcome !== 'minted') throw new Error('expected a minted challenge')
      expect(replacement.challenge.id).not.toBe(first.id)
      expect(replacement.challenge.number).toBe(OTHER_NUMBER)
      // The abandoned one is closed rather than deleted: what was texted stays
      // on the record, which is what the spend ledger is reconciled against.
      const abandoned = await db
        .select({ expiresAt: smsChallenges.expiresAt })
        .from(smsChallenges)
        .where(eq(smsChallenges.id, first.id))
      expect(new Date(abandoned[0]?.expiresAt ?? 0).getTime()).toBeLessThanOrEqual(Date.now())
    })

    /** And only when it is asked for: `replace` stays explicit on both routes. */
    it('keeps a delivered challenge when replacement was not asked for', async () => {
      const first = await mintAndSend(agentId, CITIZEN_NUMBER)

      const again = await mintSmsReceiveChallenge(db, agentId, OTHER_NUMBER)

      expect(again.outcome).toBe('open')
      if (again.outcome !== 'open') throw new Error('expected an open challenge')
      expect(again.challenge.id).toBe(first.id)
      expect(again.matchesRequested).toBe(false)
      expect(again.sent).toBe(true)
    })

    /**
     * The number check runs before the abandonment on this route as well: a
     * replacement that cannot succeed must leave the citizen holding what it
     * had, rather than exchanging a delivered challenge for nothing.
     */
    it('leaves a delivered challenge standing when the new number is another citizen’s', async () => {
      await mintAndSend(agentId, CITIZEN_NUMBER)
      const theirs = await mintAndSend(otherId, OTHER_NUMBER)
      await redeemSmsCode(db, otherId, theirs.code)

      expect(await mintSmsReceiveChallenge(db, agentId, OTHER_NUMBER, true)).toEqual({
        outcome: 'number_taken',
      })

      const state = await latestSmsChallenge(db, agentId, 'receive')
      expect(state?.number).toBe(CITIZEN_NUMBER)
      expect(new Date(state?.expiresAt ?? 0).getTime()).toBeGreaterThan(Date.now())
      expect(state?.sentAt).not.toBeNull()
    })

    it('refuses a number that already certifies another citizen', async () => {
      const theirs = await mintAndSend(otherId, CITIZEN_NUMBER)
      await redeemSmsCode(db, otherId, theirs.code)

      expect(await mintSmsReceiveChallenge(db, agentId, CITIZEN_NUMBER)).toEqual({
        outcome: 'number_taken',
      })
    })

    /**
     * **Two citizens may hold open challenges for one number**, and the first to
     * prove it takes it. Refusing at mint time on a claim nobody has proved
     * would let a citizen reserve a number it does not hold.
     */
    it('lets two citizens ask about one number, and gives it to whoever proves it', async () => {
      const mine = await mintAndSend(agentId, CITIZEN_NUMBER)
      const theirs = await mintAndSend(otherId, CITIZEN_NUMBER)

      expect(await redeemSmsCode(db, agentId, mine.code)).toMatchObject({ outcome: 'verified' })
      expect(await redeemSmsCode(db, otherId, theirs.code)).toEqual({ outcome: 'number_taken' })
    })

    it('treats a number written with spaces and hyphens as the same number', async () => {
      const theirs = await mintAndSend(otherId, '+15005550006')
      await redeemSmsCode(db, otherId, theirs.code)

      expect(await mintSmsReceiveChallenge(db, agentId, '+1 500-555 0006')).toEqual({
        outcome: 'number_taken',
      })
    })
  })

  describe('sms-send', () => {
    /**
     * **The one assertion the badge exists for.** The number recorded is the one
     * the message arrived from, and there is no argument anywhere in this path
     * through which a citizen could name a different one.
     */
    it('takes the sending number from the message and not from anything submitted', async () => {
      const { nonce } = await mintSmsSendChallenge(db, agentId)

      const result = await recordInboundSms(db, {
        body: `here you go: ${nonce}`,
        from: '+15005550008',
        receivedAt: currentTime(),
      })

      expect(result).toEqual({
        outcome: 'matched',
        agentId,
        from: '+15005550008',
        // Not the citizen's own proved number, so the send is certified and
        // nothing is claimed about who the number belongs to (`#579`).
        claimsOwnership: false,
      })

      const state = await latestSmsChallenge(db, agentId, 'send')
      expect(state?.inboundFrom).toBe('+15005550008')
      expect(state?.verifiedAt).not.toBeNull()
      // Nothing was ever claimed, so there is nothing to have believed.
      expect(state?.number).toBeNull()
      expect(state?.ownsSendingNumber).toBe(false)
    })

    /**
     * The separation `#579` was filed for, from the citizen's side.
     *
     * A pooled or shared gateway sends on behalf of everybody who pays for it.
     * Certifying the send is honest; recording the number as the sender's is
     * not, and until this the rung did both in one motion — so the cheap routes
     * were exactly the dishonest ones, and an agent that had thought about it
     * could not pass while one that had not could.
     */
    it('certifies a send from a number it cannot vouch for, and claims nothing about it', async () => {
      const { nonce } = await mintSmsSendChallenge(db, agentId)

      await recordInboundSms(db, {
        body: nonce,
        from: '+15005550008',
        receivedAt: currentTime(),
      })

      const state = await latestSmsChallenge(db, agentId, 'send')
      expect(state?.verifiedAt).not.toBeNull()

      // The badge is earned and the account register is untouched.
      expect(
        (await listAccounts(db, agentId)).find((account) => account.kind === 'phone'),
      ).toBeUndefined()
    })

    it('adds send to a number that already proved receive, rather than replacing it', async () => {
      const challenge = await mintAndSend(agentId, CITIZEN_NUMBER)
      await redeemSmsCode(db, agentId, challenge.code)

      const { nonce } = await mintSmsSendChallenge(db, agentId)
      await recordInboundSms(db, {
        body: nonce,
        from: CITIZEN_NUMBER,
        receivedAt: currentTime(),
      })

      const phone = (await listAccounts(db, agentId)).find((account) => account.kind === 'phone')
      expect([...(phone?.capabilities ?? [])].toSorted()).toEqual(['receive', 'send'])
    })

    it('ignores a message carrying no nonce it is holding', async () => {
      await mintSmsSendChallenge(db, agentId)

      expect(
        await recordInboundSms(db, {
          body: 'hello?',
          from: CITIZEN_NUMBER,
          receivedAt: currentTime(),
        }),
      ).toEqual({ outcome: 'unmatched' })
    })

    it('reads a nonce whatever case it comes back in', async () => {
      const { nonce } = await mintSmsSendChallenge(db, agentId)

      expect(
        await recordInboundSms(db, {
          body: `KOLONIE ${nonce.toUpperCase()} thanks`,
          from: CITIZEN_NUMBER,
          receivedAt: currentTime(),
        }),
      ).toMatchObject({ outcome: 'matched' })
    })

    /**
     * **This used to refuse, and refusing was the defect** (`#579`).
     *
     * Under the old rule a send *was* an ownership claim, so the first citizen
     * to text from a pooled gateway took the number and every later one was
     * locked out of the badge by somebody else's route. Now the send claims
     * nothing, so there is nothing to collide with: the badge is earned, and the
     * citizen who genuinely proved that number keeps it, untouched.
     */
    it('lets a citizen send from a number that certifies somebody else, and takes nothing from them', async () => {
      const theirs = await mintAndSend(otherId, OTHER_NUMBER)
      await redeemSmsCode(db, otherId, theirs.code)

      const { nonce } = await mintSmsSendChallenge(db, agentId)

      expect(
        await recordInboundSms(db, {
          body: nonce,
          from: OTHER_NUMBER,
          receivedAt: currentTime(),
        }),
      ).toEqual({ outcome: 'matched', agentId, from: OTHER_NUMBER, claimsOwnership: false })

      // The sender got the badge and no account.
      expect((await latestSmsChallenge(db, agentId, 'send'))?.verifiedAt).not.toBeNull()
      expect(
        (await listAccounts(db, agentId)).find((account) => account.kind === 'phone'),
      ).toBeUndefined()

      // And the citizen that actually proved the number still holds it.
      const theirPhone = (await listAccounts(db, otherId)).find(
        (account) => account.kind === 'phone',
      )
      expect(theirPhone?.identifier).toBe(OTHER_NUMBER)
      expect(theirPhone?.capabilities).toEqual(['receive'])
    })

    /**
     * The other half: when the two proofs meet on one number, the claim is
     * grounded and is written exactly as it was before.
     */
    it('records the number as the citizen’s when it is the one it proved it can be reached at', async () => {
      const challenge = await mintAndSend(agentId, CITIZEN_NUMBER)
      await redeemSmsCode(db, agentId, challenge.code)

      const { nonce } = await mintSmsSendChallenge(db, agentId)
      const result = await recordInboundSms(db, {
        body: nonce,
        from: CITIZEN_NUMBER,
        receivedAt: currentTime(),
      })

      expect(result).toMatchObject({ outcome: 'matched', claimsOwnership: true })
      expect((await latestSmsChallenge(db, agentId, 'send'))?.ownsSendingNumber).toBe(true)
    })

    it('hands back the open nonce rather than minting a second', async () => {
      const first = await mintSmsSendChallenge(db, agentId)
      const again = await mintSmsSendChallenge(db, agentId)

      expect(again.nonce).toBe(first.nonce)
      expect(again.reused).toBe(true)
    })

    it('ignores a nonce whose challenge has expired', async () => {
      const { nonce } = await mintSmsSendChallenge(db, agentId)
      const [row] = await db
        .select({ id: smsChallenges.id })
        .from(smsChallenges)
        .where(eq(smsChallenges.agentId, agentId))
      await expire(row?.id ?? '')

      expect(
        await recordInboundSms(db, {
          body: nonce,
          from: CITIZEN_NUMBER,
          receivedAt: currentTime(),
        }),
      ).toEqual({ outcome: 'unmatched' })
    })
  })

  it('keeps the two nodes apart, so one never answers with the other’s evidence', async () => {
    await mintAndSend(agentId, CITIZEN_NUMBER)
    await mintSmsSendChallenge(db, agentId)

    const receive = await latestSmsChallenge(db, agentId, 'receive')
    const send = await latestSmsChallenge(db, agentId, 'send')

    expect(receive?.purpose).toBe('receive')
    expect(receive?.number).toBe(CITIZEN_NUMBER)
    expect(send?.purpose).toBe('send')
    expect(send?.number).toBeNull()
  })
})
