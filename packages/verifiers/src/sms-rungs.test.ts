import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { AgentId, Submission, VerificationContext } from '@kolonie-ai/core'
import { SmsReceiveVerifier, type SmsReceiveState } from './sms-receive.js'
import { nextSmsSendCheck, SmsSendVerifier, type SmsSendState } from './sms-send.js'

/**
 * The two phone rungs, judged (`#411`).
 *
 * **The cases here are the ones the issue names**, and each is a place where the
 * cheap implementation gets it wrong in a way nobody would notice: a refused
 * send charged to the citizen, an expired code read as a wrong one, a nonce that
 * never arrived treated as a failure. Every one of those is silent — the citizen
 * is simply told it did not pass.
 */

const agentId = randomUUID() as AgentId

const submission = { attempt: 1 } as unknown as Submission
const context = { agent: { id: agentId } } as unknown as VerificationContext

const inThreeDays = () => new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString()
const yesterday = () => new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

const receiving = (state: SmsReceiveState | null) =>
  new SmsReceiveVerifier({ challenges: { latestReceive: async () => state } }).verify(
    submission,
    context,
  )

const sending = (state: SmsSendState | null) =>
  new SmsSendVerifier({ challenges: { latestSend: async () => state } }).verify(submission, context)

describe('sms-receive', () => {
  it('passes a citizen that handed the code back', async () => {
    const result = await receiving({
      number: '+15005550006',
      expiresAt: inThreeDays(),
      sentAt: yesterday(),
      sendFailure: null,
      verifiedAt: yesterday(),
    })

    expect(result.status).toBe('pass')
    expect(result.evidence).toContain('+15005550006')
  })

  it('tells a citizen with no challenge how to open one, rather than only that it failed', async () => {
    const result = await receiving(null)

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('sms.challenge')
    expect(result.evidence).toContain('sms.code')
  })

  /**
   * **The acceptance criterion this file exists for.** A destination the Colony
   * will not send to, a cap it has reached, a vendor that was down — none of
   * those is the citizen's doing, and a `fail` here spends an attempt on the
   * Colony's own arrangement.
   */
  it('does not charge the citizen for a send the Colony could not make', async () => {
    const result = await receiving({
      number: '+15005550001',
      expiresAt: inThreeDays(),
      sentAt: null,
      sendFailure: 'The Colony does not send messages to that destination.',
      verifiedAt: null,
    })

    expect(result.status).toBe('pending')
    // The Colony named as the cause, in its own words rather than paraphrased.
    expect(result.evidence).toContain('The Colony does not send messages to that destination.')
    expect(result.evidence).toMatch(/not spent/i)
  })

  /**
   * **Ordered before the expiry check, and this is the test that pins it.** A
   * refused send that then sat until the challenge expired is *still* the
   * Colony's failure; checking expiry first would quietly reclassify it as the
   * citizen's after three days.
   */
  it('still calls a refused send the Colony’s failure after the challenge has expired', async () => {
    const result = await receiving({
      number: '+15005550001',
      expiresAt: yesterday(),
      sentAt: null,
      sendFailure: 'the vendor could not be reached',
      verifiedAt: null,
    })

    expect(result.status).toBe('pending')
    expect(result.evidence).toContain('the vendor could not be reached')
  })

  it('fails a code that expired, and says to open a new challenge', async () => {
    const result = await receiving({
      number: '+15005550006',
      expiresAt: yesterday(),
      sentAt: yesterday(),
      sendFailure: null,
      verifiedAt: null,
    })

    expect(result.status).toBe('fail')
    expect(result.evidence).toMatch(/expired/i)
    expect(result.evidence).toContain('sms.challenge')
  })

  it('fails a code that was sent and never handed back, naming the deadline', async () => {
    const expiresAt = inThreeDays()
    const result = await receiving({
      number: '+15005550006',
      expiresAt,
      sentAt: yesterday(),
      sendFailure: null,
      verifiedAt: null,
    })

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain(expiresAt)
    expect(result.evidence).toContain('sms.code')
  })
})

describe('sms-send', () => {
  /**
   * **The one assertion this badge exists for.** The number in the verdict came
   * from what the vendor reported, and the verdict says so — a reviewer asking
   * *where did this number come from* should not have to read the storage layer
   * to answer it.
   */
  it('certifies the number the carrier reported, and records that that is where it came from', async () => {
    const result = await sending({
      expiresAt: inThreeDays(),
      inboundAt: yesterday(),
      inboundFrom: '+491701234567',
      ownsSendingNumber: true,
      verifiedAt: yesterday(),
    })

    expect(result.status).toBe('pass')
    expect(result.evidence).toContain('+491701234567')
    expect(result.evidence).toMatch(/not from anything you submitted/i)
    expect(result.metadata).toMatchObject({
      sender: '+491701234567',
      senderSource: 'vendor-response',
    })
  })

  /**
   * **A nonce that never arrived is `pending` and never `fail`.** Not every
   * carrier delivers to a US long code, none of them reports the drop, and the
   * Colony picked that number — so a `fail` would be the Colony charging a
   * citizen for its own route.
   */
  it('leaves a nonce that never arrived open, with the Colony named as a possible cause', async () => {
    const result = await sending({
      expiresAt: inThreeDays(),
      inboundAt: null,
      inboundFrom: null,
      ownsSendingNumber: false,
      verifiedAt: null,
    })

    expect(result.status).toBe('pending')
    expect(result.evidence).toMatch(/long code/i)
    expect(result.evidence).toMatch(/not a failure|deliberately not a failure/i)
  })

  it('tells a citizen with no challenge how to open one', async () => {
    const result = await sending(null)

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('sms-send')
  })

  /**
   * **The disclosure is on the rung's own evidence and not only in the task
   * text.** A citizen that reaches this verdict without having read the task —
   * a resubmission on a later waking, say — is about to be asked to send an
   * international message, and being told what that costs is the point.
   */
  it('says the message costs the sender something, where a citizen deciding will read it', async () => {
    const result = await sending({
      expiresAt: inThreeDays(),
      inboundAt: null,
      inboundFrom: null,
      ownsSendingNumber: false,
      verifiedAt: null,
    })

    expect(result.evidence).toMatch(/international/i)
    expect(result.evidence).toMatch(/charge/i)
  })
  /**
   * The two facts, said apart (`#579`).
   *
   * A citizen reported that the rung fused *a message left at your instruction*
   * with *the originating number is yours*, so every pooled route was a false
   * claim rather than a hard one — the cheap routes were exactly the dishonest
   * ones. Both wordings below are a pass; what differs is what the Colony says
   * it knows.
   */
  it('claims nothing about a number the citizen has not proved it can be reached at', async () => {
    const result = await sending({
      expiresAt: inThreeDays(),
      inboundAt: yesterday(),
      inboundFrom: '+15005550008',
      ownsSendingNumber: false,
      verifiedAt: yesterday(),
    })

    expect(result.status).toBe('pass')
    expect(result.evidence).toMatch(/nothing has been recorded about who it belongs to/i)
    expect(result.evidence).toMatch(/shared or pooled/i)
    expect(result.metadata).toMatchObject({ certifies: 'message-sent', ownershipRecorded: false })
  })

  it('records the number as the citizen’s when both proofs meet on it', async () => {
    const result = await sending({
      expiresAt: inThreeDays(),
      inboundAt: yesterday(),
      inboundFrom: '+491701234567',
      ownsSendingNumber: true,
      verifiedAt: yesterday(),
    })

    expect(result.status).toBe('pass')
    expect(result.evidence).toMatch(/recorded it as yours/i)
    expect(result.evidence).toMatch(/it receives and it sends/i)
    expect(result.metadata).toMatchObject({ certifies: 'message-sent', ownershipRecorded: true })
  })

  /**
   * The window the Colony looks over is the window it says is open (`#709`).
   *
   * Without a declared wait the retry ceiling ended these submissions after five
   * checks — about seven and a half minutes against a challenge open for a day,
   * so an ordinary carrier delay was guaranteed to be missed while the citizen
   * was still being told to send.
   */
  it('keeps looking for as long as the challenge it says is open', async () => {
    const expiresAt = inThreeDays()
    const result = await sending({
      expiresAt,
      inboundAt: null,
      inboundFrom: null,
      ownsSendingNumber: false,
      verifiedAt: null,
    })

    expect(result.status).toBe('pending')
    const until = (result.metadata as { expectedWaitUntil?: string }).expectedWaitUntil
    expect(until).toBeDefined()
    expect(Date.parse(until as string)).toBeGreaterThan(Date.now())
    expect(Date.parse(until as string)).toBeLessThanOrEqual(Date.parse(expiresAt))
    // The citizen is told it does not have to hand the task in again.
    expect(result.evidence).toMatch(/do not need to hand this in again/i)
  })

  /**
   * **And stops when it closes**, which is what turns the poll off: with no
   * declared wait the ceiling applies again and the submission reaches `timeout`
   * — the Colony gave up, which by then is what happened. Never `fail`.
   */
  it('stops looking once the challenge has closed, without failing the citizen', async () => {
    const result = await sending({
      expiresAt: yesterday(),
      inboundAt: null,
      inboundFrom: null,
      ownsSendingNumber: false,
      verifiedAt: null,
    })

    expect(result.status).toBe('pending')
    expect(result.metadata).not.toHaveProperty('expectedWaitUntil')
    expect(result.evidence).toMatch(/stopped looking/i)
    expect(result.evidence).toMatch(/cost you nothing/i)
  })

  /**
   * The cadence itself, asserted directly rather than through a verdict: the
   * minutes are the trade between noticing a message quickly and writing a day
   * of polling into the verdict trail, and a later reader changing one should
   * see which one they changed.
   */
  describe('nextSmsSendCheck', () => {
    const now = Date.parse('2026-08-11T12:00:00.000Z')
    const ago = (ms: number) => new Date(now - ms).toISOString()
    const at = (ms: number) => new Date(now + ms).toISOString()
    const minutes = (n: number) => n * 60 * 1000

    it('checks every three minutes while the message could still be in a carrier queue', () => {
      expect(nextSmsSendCheck(now, ago(minutes(1)), at(minutes(2000)))).toBe(at(minutes(3)))
    })

    it('stands further back once the first quarter of an hour has passed', () => {
      expect(nextSmsSendCheck(now, ago(minutes(30)), at(minutes(2000)))).toBe(at(minutes(15)))
    })

    it('falls to hourly for the rest of the day', () => {
      expect(nextSmsSendCheck(now, ago(minutes(300)), at(minutes(2000)))).toBe(at(minutes(60)))
    })

    it('never names an instant past the challenge’s own expiry', () => {
      expect(nextSmsSendCheck(now, ago(minutes(300)), at(minutes(10)))).toBe(at(minutes(10)))
    })

    it('gives up once the challenge has expired', () => {
      expect(nextSmsSendCheck(now, ago(minutes(300)), ago(minutes(1)))).toBeNull()
    })

    /**
     * **The exact measurement in `#715`.** Reporter 1 recorded three attempts
     * stopping at 7m33.7s, 7m36.2s and 7m35.6s, each with the challenge open
     * until the following afternoon. At that moment the Colony must still be
     * declaring a next check, because that declaration is what exempts the
     * verdict from the retry ceiling in `recordVerdict` — a `pending` with no
     * `expectedWaitUntil` becomes a `timeout` at the fifth check, which is the
     * behaviour they measured.
     */
    it('is still looking at 7m35s, with the challenge open until tomorrow', () => {
      const sevenAndAHalf = minutes(7) + 35_000

      // Non-null is the assertion that matters — that is what exempts the
      // verdict from the ceiling. Three minutes because 7m35s is still inside
      // the first quarter of an hour, which is where a carrier queue lives.
      expect(nextSmsSendCheck(now, ago(sevenAndAHalf), at(minutes(890)))).toBe(at(minutes(3)))
    })

    /** The shortest step, because checking too often is the lesser fault here. */
    it('assumes a fresh submission when it has no submission time to read', () => {
      expect(nextSmsSendCheck(now, undefined, at(minutes(2000)))).toBe(at(minutes(3)))
      expect(nextSmsSendCheck(now, 'not a timestamp', at(minutes(2000)))).toBe(at(minutes(3)))
    })
  })

  /** A pooled sender is not told to go away: it is told what would ground it. */
  it('names the route to an ownership claim rather than leaving it unexplained', async () => {
    const result = await sending({
      expiresAt: inThreeDays(),
      inboundAt: yesterday(),
      inboundFrom: '+15005550008',
      ownsSendingNumber: false,
      verifiedAt: yesterday(),
    })

    expect(result.evidence).toMatch(/prove the same number on the phone rung/i)
  })
})
