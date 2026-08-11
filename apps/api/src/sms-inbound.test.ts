import { describe, expect, it } from 'vitest'
import type { AgentId } from '@kolonie-ai/core'
import type { SmsMessage, SmsReceiveResult } from '@kolonie-ai/verifiers'
import { FAKE_CITIZEN_NUMBER, FAKE_OTHER_NUMBER, fakeSmsStore } from './__fixtures__/sms.js'
import { collectInboundSms, INBOUND_SMS_LOOKBACK_MS } from './sms-inbound.js'

/**
 * `#690`: the badge's inbound half, which did not exist.
 *
 * The test that would have caught it is the first one — a citizen texts its
 * nonce, and something on the Colony's side has to be the thing that notices.
 */

const AGENT = '00000000-0000-4000-8000-0000000000aa' as AgentId

function silentLog(): {
  readonly info: (message: string, fields?: Record<string, unknown>) => void
  readonly error: (message: string, detail?: unknown, fields?: Record<string, unknown>) => void
  readonly errors: () => readonly { message: string; fields?: Record<string, unknown> }[]
} {
  const errors: { message: string; fields?: Record<string, unknown> }[] = []
  return {
    info: () => undefined,
    error: (message, _detail, fields) => {
      errors.push({ message, ...(fields === undefined ? {} : { fields }) })
    },
    errors: () => errors,
  }
}

function message(overrides: Partial<SmsMessage> = {}): SmsMessage {
  return {
    from: FAKE_CITIZEN_NUMBER,
    to: '+15005550000',
    body: 'nothing in particular',
    receivedAt: new Date(),
    vendorId: 'SM0000',
    ...overrides,
  }
}

function adapterReturning(...answers: readonly SmsReceiveResult[]): {
  readonly received: (since: Date) => Promise<SmsReceiveResult>
  readonly asked: () => readonly Date[]
} {
  const asked: Date[] = []
  let index = 0
  return {
    received: async (since) => {
      asked.push(since)
      const answer = answers[Math.min(index, answers.length - 1)]
      index += 1
      return answer ?? { outcome: 'ok', messages: [] }
    },
    asked: () => asked,
  }
}

describe('collectInboundSms', () => {
  it('settles the badge for a citizen whose nonce arrived', async () => {
    const challenges = fakeSmsStore()
    const minted = await challenges.mintSend(AGENT)
    const log = silentLog()

    const pass = await collectInboundSms({
      adapter: adapterReturning({
        outcome: 'ok',
        messages: [message({ body: `here you go: ${minted.nonce}` })],
      }),
      challenges,
      log,
    })

    expect(pass).toEqual({ outcome: 'read', read: 1, matched: 1 })
    expect((await challenges.latest(AGENT, 'send'))?.verifiedAt).not.toBeNull()
  })

  /**
   * The property the badge is *for* (D-018): the number it certifies is the one
   * the network reported, and there is no argument anywhere on this path that a
   * citizen could have put it in through.
   */
  it('certifies the number the vendor reported and not one anybody claimed', async () => {
    const challenges = fakeSmsStore()
    const minted = await challenges.mintSend(AGENT)

    await collectInboundSms({
      adapter: adapterReturning({
        outcome: 'ok',
        messages: [message({ from: FAKE_OTHER_NUMBER, body: minted.nonce })],
      }),
      challenges,
      log: silentLog(),
    })

    expect((await challenges.latest(AGENT, 'send'))?.inboundFrom).toBe(FAKE_OTHER_NUMBER)
  })

  /**
   * What lets the window overlap on every pass. Nothing dedupes, because a
   * settled challenge is no longer matchable and the second look finds nothing.
   */
  it('is safe to run twice over the same message', async () => {
    const challenges = fakeSmsStore()
    const minted = await challenges.mintSend(AGENT)
    const arrived: SmsReceiveResult = {
      outcome: 'ok',
      messages: [message({ body: minted.nonce })],
    }
    const deps = { adapter: adapterReturning(arrived), challenges, log: silentLog() }

    expect((await collectInboundSms(deps)).matched).toBe(1)
    expect((await collectInboundSms(deps)).matched).toBe(0)
  })

  it('asks for everything a live challenge could still be settled by', async () => {
    const adapter = adapterReturning({ outcome: 'ok', messages: [] })
    const at = Date.parse('2026-08-11T12:00:00.000Z')

    await collectInboundSms({
      adapter,
      challenges: fakeSmsStore(),
      log: silentLog(),
      clock: () => at,
    })

    expect(adapter.asked()[0]?.getTime()).toBe(at - INBOUND_SMS_LOOKBACK_MS)
  })

  /**
   * The single most important line in the adapter, asserted from this side: a
   * vendor the Colony cannot reach is said out loud, because a citizen deferring
   * at a rung it has passed looks identical to one that has not sent anything.
   */
  it('reports a vendor it could not reach rather than an empty pass', async () => {
    const log = silentLog()

    const pass = await collectInboundSms({
      adapter: adapterReturning({ outcome: 'unavailable', reason: 'Twilio answered 503.' }),
      challenges: fakeSmsStore(),
      log,
    })

    expect(pass).toEqual({ outcome: 'unavailable', read: 0, matched: 0 })
    expect(log.errors()).toHaveLength(1)
    expect(log.errors()[0]?.fields?.['event']).toBe('sms.inbound.unavailable')
  })

  it('carries on past a message it could not record', async () => {
    const challenges = fakeSmsStore()
    const minted = await challenges.mintSend(AGENT)
    const log = silentLog()

    const pass = await collectInboundSms({
      adapter: adapterReturning({
        outcome: 'ok',
        messages: [message({ vendorId: 'SM-broken' }), message({ body: minted.nonce })],
      }),
      challenges: {
        recordInbound: async (inbound) => {
          if (!inbound.body.includes(minted.nonce)) throw new Error('storage said no')
          return challenges.recordInbound(inbound)
        },
      },
      log,
    })

    expect(pass).toEqual({ outcome: 'read', read: 2, matched: 1 })
    expect(log.errors()[0]?.fields?.['vendorId']).toBe('SM-broken')
  })

  it('leaves a message carrying nobody’s nonce alone', async () => {
    const challenges = fakeSmsStore()
    await challenges.mintSend(AGENT)

    const pass = await collectInboundSms({
      adapter: adapterReturning({ outcome: 'ok', messages: [message({ body: 'STOP' })] }),
      challenges,
      log: silentLog(),
    })

    expect(pass).toEqual({ outcome: 'read', read: 1, matched: 0 })
    expect((await challenges.latest(AGENT, 'send'))?.verifiedAt).toBeNull()
  })
})
