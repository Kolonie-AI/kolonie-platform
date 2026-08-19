import { AgentIdSchema } from '@kolonie-ai/core'
import { describe, expect, it } from 'vitest'
import {
  MESSAGE_BURST_LIMIT,
  MESSAGE_IDENTICAL_BODY_LIMIT,
  messageBurstLimiter,
  messageIdenticalBodyLimiter,
  messagePerRecipientLimiter,
  messageRequestCreateLimiter,
  messageSendLimiter,
} from './rate-limit.js'
import { messagingAllowance } from './messaging.js'

const sender = AgentIdSchema.parse('00000000-0000-4000-a000-000000000001')
const other = AgentIdSchema.parse('00000000-0000-4000-a000-000000000002')

describe('messagingAllowance (#1290)', () => {
  it('refuses on the burst ceiling with retryAfterSeconds', () => {
    const allowance = messagingAllowance({
      send: messageSendLimiter(),
      perRecipient: messagePerRecipientLimiter(),
      burst: messageBurstLimiter(),
      identicalBody: messageIdenticalBodyLimiter(),
      requestCreate: messageRequestCreateLimiter(),
    })

    for (let i = 0; i < MESSAGE_BURST_LIMIT; i += 1) {
      expect(
        allowance.charge({
          senderId: sender,
          recipientKey: 'bob',
          body: `unique-${i}`,
          requestCreate: true,
        }).allowed,
      ).toBe(true)
    }

    const refused = allowance.charge({
      senderId: sender,
      recipientKey: 'bob',
      body: 'one-more',
      requestCreate: true,
    })
    expect(refused.allowed).toBe(false)
    if (refused.allowed) throw new Error('unreachable')
    expect(refused.retryAfterSeconds).toBeGreaterThan(0)
  })

  it('refuses identical-body fanout across recipients', () => {
    const allowance = messagingAllowance({
      send: messageSendLimiter(),
      perRecipient: messagePerRecipientLimiter(),
      burst: messageBurstLimiter(),
      identicalBody: messageIdenticalBodyLimiter(),
      requestCreate: messageRequestCreateLimiter(),
    })

    const body = 'Buy now — limited offer.'
    for (let i = 0; i < MESSAGE_IDENTICAL_BODY_LIMIT; i += 1) {
      expect(
        allowance.charge({
          senderId: sender,
          recipientKey: `recipient-${i}`,
          body,
          requestCreate: true,
        }).allowed,
      ).toBe(true)
    }

    expect(
      allowance.charge({
        senderId: sender,
        recipientKey: 'recipient-extra',
        body,
        requestCreate: true,
      }).allowed,
    ).toBe(false)

    // A different sender still has room.
    expect(
      allowance.charge({
        senderId: other,
        recipientKey: 'recipient-0',
        body,
        requestCreate: true,
      }).allowed,
    ).toBe(true)
  })
})
