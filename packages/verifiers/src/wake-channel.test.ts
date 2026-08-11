import { describe, expect, it } from 'vitest'
import {
  WAKE_KNOCK_HEADER,
  WAKE_SIGNATURE_HEADER,
  WAKE_TIMESTAMP_HEADER,
  wakeSignatureMatches,
  type AgentId,
  type WakeDeliveryOutcome,
  type WakeEvent,
} from '@kolonie-ai/core'
import { noWake, wakeSender, type WakeDesk } from './wake-channel.js'

/**
 * The delivery half of the wake channel (`#518`).
 *
 * **The test that matters most is the one about an agent without the rung**, and
 * it is first: `#518` requires that an unreachable agent is exactly as well
 * served as it was before the channel existed, and nothing else in this file
 * would catch a regression that quietly made the channel load-bearing.
 */
describe('the wake channel', () => {
  const agentId = '11111111-1111-4111-8111-111111111111' as AgentId
  const secret = 'a'.repeat(64)

  interface Recorded {
    readonly agentId: AgentId
    readonly event: WakeEvent
    readonly outcome: WakeDeliveryOutcome
    readonly status?: number | undefined
    readonly challengeId?: string | undefined
  }

  const deskWith = (
    options: {
      readonly address?: {
        readonly url: string
        readonly secret: string
        readonly challengeId?: string
        readonly knockNonce?: string
      }
      readonly sentThisHour?: number
      readonly ceiling?: number
      readonly throws?: boolean
    } = {},
  ): { desk: WakeDesk; recorded: Recorded[] } => {
    const recorded: Recorded[] = []

    return {
      recorded,
      desk: {
        addressFor: async () => {
          if (options.throws === true) throw new Error('the database is down')
          return options.address
        },
        deliveriesSince: async () => options.sentThisHour ?? 0,
        record: async (input) => {
          recorded.push(input)
        },
        maxPerHour: async () => options.ceiling ?? 12,
      },
    }
  }

  describe('an agent that has not cleared the rung', () => {
    it('is not knocked on, and the sender does not fail', async () => {
      const { desk, recorded } = deskWith()
      let called = false

      const sender = wakeSender(desk, {
        fetch: async () => {
          called = true
          return new Response('', { status: 200 })
        },
      })

      await expect(sender.wake(agentId, 'operator-answer')).resolves.toBeUndefined()

      expect(called).toBe(false)
      expect(recorded).toEqual([{ agentId, event: 'operator-answer', outcome: 'no-address' }])
    })
  })

  describe('an agent that has', () => {
    it('is sent a signed, content-free POST and the delivery is recorded', async () => {
      const { desk, recorded } = deskWith({ address: { url: 'https://example.org/wake', secret } })

      let seen: { url: string; init: RequestInit } | undefined
      const sender = wakeSender(desk, {
        fetch: async (url, init) => {
          seen = { url, init }
          return new Response(null, { status: 204 })
        },
      })

      await sender.wake(agentId, 'verdict')

      expect(seen?.url).toBe('https://example.org/wake')
      expect(seen?.init.method).toBe('POST')

      // The body is the whole payload, and it says nothing. Three properties in
      // `#518` rest on this staying true, so it is asserted rather than assumed.
      expect(seen?.init.body).toBe('{}')

      const headers = seen?.init.headers as Record<string, string>
      const timestamp = headers[WAKE_TIMESTAMP_HEADER] as string
      expect(
        wakeSignatureMatches(secret, timestamp, headers[WAKE_SIGNATURE_HEADER] as string),
      ).toBe(true)

      // The rung's own header, and only the rung's.
      expect(headers[WAKE_KNOCK_HEADER]).toBeUndefined()

      // Nothing about the event travels. The Colony knows why it knocked; the
      // agent finds out by asking.
      expect(JSON.stringify(headers)).not.toContain('verdict')

      expect(recorded).toEqual([{ agentId, event: 'verdict', outcome: 'answered', status: 204 }])
    })

    it('proves an open replacement challenge with the wake event', async () => {
      const challengeId = '22222222-2222-4222-8222-222222222222'
      const knockNonce = 'b'.repeat(32)
      const { desk, recorded } = deskWith({
        address: {
          url: 'https://example.org/replacement',
          secret,
          challengeId,
          knockNonce,
        },
      })

      let headers: Record<string, string> | undefined
      const sender = wakeSender(desk, {
        fetch: async (_url, init) => {
          headers = init.headers as Record<string, string>
          return new Response(`received ${knockNonce}`, { status: 200 })
        },
      })

      await sender.wake(agentId, 'operator-answer')

      expect(headers?.[WAKE_KNOCK_HEADER]).toBe(knockNonce)
      expect(recorded).toEqual([
        {
          agentId,
          event: 'operator-answer',
          outcome: 'answered',
          status: 200,
          challengeId,
        },
      ])
    })

    it('does not prove a replacement challenge that fails to echo the nonce', async () => {
      const { desk, recorded } = deskWith({
        address: {
          url: 'https://example.org/replacement',
          secret,
          challengeId: '22222222-2222-4222-8222-222222222222',
          knockNonce: 'b'.repeat(32),
        },
      })
      const sender = wakeSender(desk, {
        fetch: async () => new Response('not the nonce', { status: 200 }),
      })

      await sender.wake(agentId, 'operator-answer')

      expect(recorded).toEqual([
        {
          agentId,
          event: 'operator-answer',
          outcome: 'failed',
          challengeId: '22222222-2222-4222-8222-222222222222',
        },
      ])
    })

    it('is not knocked on past the hourly ceiling, and the refusal is a row', async () => {
      const { desk, recorded } = deskWith({
        address: { url: 'https://example.org/wake', secret },
        sentThisHour: 12,
        ceiling: 12,
      })

      let called = false
      const sender = wakeSender(desk, {
        fetch: async () => {
          called = true
          return new Response('', { status: 200 })
        },
      })

      await sender.wake(agentId, 'quest-opened')

      expect(called).toBe(false)
      expect(recorded).toEqual([{ agentId, event: 'quest-opened', outcome: 'capped' }])
    })

    it('is never knocked on at an address that resolves privately', async () => {
      const { desk, recorded } = deskWith({
        address: { url: 'https://localhost/wake', secret },
      })

      let called = false
      const sender = wakeSender(desk, {
        fetch: async () => {
          called = true
          return new Response('', { status: 200 })
        },
      })

      await sender.wake(agentId, 'operator-answer')

      expect(called).toBe(false)
      expect(recorded[0]?.outcome).toBe('not-public')
    })
  })

  describe('when the endpoint has stopped answering', () => {
    it('costs the agent nothing and is recorded as what it was', async () => {
      const { desk, recorded } = deskWith({ address: { url: 'https://example.org/wake', secret } })

      const sender = wakeSender(desk, {
        fetch: async () => {
          throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
        },
      })

      await expect(sender.wake(agentId, 'operator-answer')).resolves.toBeUndefined()
      expect(recorded[0]?.outcome).toBe('refused')
    })

    /**
     * The caller is recording an operator's answer or a verdict — work the
     * citizen is owed. A wake that threw would roll that back, which is the one
     * way this feature could take something from a citizen rather than give it
     * something.
     */
    it('never throws, even when the record itself cannot be written', async () => {
      const { desk } = deskWith({ throws: true })
      const sender = wakeSender(desk, { fetch: async () => new Response('', { status: 200 }) })

      await expect(sender.wake(agentId, 'verdict')).resolves.toBeUndefined()
    })
  })

  describe('a deployment with no channel', () => {
    it('takes the call and does nothing', async () => {
      await expect(noWake.wake(agentId, 'operator-answer')).resolves.toBeUndefined()
    })
  })
})
