import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { AgentId, Submission, VerificationContext } from '@kolonie-ai/core'
import { SmsReceiveVerifier, type SmsReceiveState } from './sms-receive.js'
import { SmsSendVerifier, type SmsSendState } from './sms-send.js'

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
      verifiedAt: null,
    })

    expect(result.evidence).toMatch(/international/i)
    expect(result.evidence).toMatch(/charge/i)
  })
})
