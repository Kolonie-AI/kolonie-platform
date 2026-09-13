import { describe, expect, it } from 'vitest'
import {
  CONVERSATION_MESSAGE_DEFAULT_PAGE,
  CONVERSATION_MESSAGE_MAX_PAGE,
  ConversationKindSchema,
  MESSAGE_IDLE_AFTER_DAYS,
  MessagePartySchema,
  MessageSchema,
  ThreadPageRequestSchema,
} from './message.js'

describe('message tombstones (#1958)', () => {
  const base = {
    id: '00000000-0000-4000-a000-000000000001',
    conversationId: '00000000-0000-4000-a000-000000000002',
    sender: {
      participantId: '00000000-0000-4000-a000-000000000003',
      party: 'citizen',
      label: 'sender',
    },
    createdAt: '2026-09-13T09:00:00.000Z',
  }

  it('accepts active messages and strict retracted tombstones', () => {
    expect(MessageSchema.parse({ ...base, body: 'Still active.' })).toEqual({
      ...base,
      body: 'Still active.',
    })
    expect(MessageSchema.parse({ ...base, retractedAt: '2026-09-13T09:05:00.000Z' })).toEqual({
      ...base,
      retractedAt: '2026-09-13T09:05:00.000Z',
    })
  })

  it('rejects a tombstone carrying body-derived semantics', () => {
    const forbidden = [
      { body: 'The erased words.' },
      { answerKind: 'permission' },
      { priority: 'critical' },
      { actionRequired: false },
      { nextAction: 'kolonie.tasks.list' },
      { acknowledgedAt: '2026-09-13T09:04:00.000Z' },
    ]

    for (const field of forbidden) {
      expect(
        MessageSchema.safeParse({
          ...base,
          retractedAt: '2026-09-13T09:05:00.000Z',
          ...field,
        }).success,
      ).toBe(false)
    }
  })

  it('rejects active messages without a bounded body', () => {
    expect(MessageSchema.safeParse(base).success).toBe(false)
    expect(MessageSchema.safeParse({ ...base, body: '' }).success).toBe(false)
  })

  it('accepts the timestamp wire format the database emits', () => {
    expect(
      MessageSchema.safeParse({ ...base, retractedAt: '2026-09-13 09:05:00.123456+00' }).success,
    ).toBe(true)
    expect(MessageSchema.safeParse({ ...base, retractedAt: 42 }).success).toBe(false)
  })
})

describe('thread pagination (#1886)', () => {
  it('defaults below the maximum and rejects requests above the documented ceiling', () => {
    expect(CONVERSATION_MESSAGE_DEFAULT_PAGE).toBeLessThan(CONVERSATION_MESSAGE_MAX_PAGE)
    expect(ThreadPageRequestSchema.parse({}).limit).toBe(CONVERSATION_MESSAGE_DEFAULT_PAGE)
    expect(
      ThreadPageRequestSchema.safeParse({ limit: CONVERSATION_MESSAGE_MAX_PAGE }).success,
    ).toBe(true)
    expect(
      ThreadPageRequestSchema.safeParse({ limit: CONVERSATION_MESSAGE_MAX_PAGE + 1 }).success,
    ).toBe(false)
    expect(ThreadPageRequestSchema.safeParse({ limit: 0 }).success).toBe(false)
  })
})

describe('citizen operator vocabulary (#1793)', () => {
  it('keeps agent operators as citizens rather than forgeable human or entity parties', () => {
    expect(MessagePartySchema.options).toEqual(['citizen', 'operator-human', 'system-role'])
    expect(ConversationKindSchema.options).toEqual(['citizen', 'operator-human', 'system-role'])
    expect(MessagePartySchema.safeParse('operator-agent').success).toBe(false)
    expect(ConversationKindSchema.safeParse('operator-agent').success).toBe(false)
  })
})

describe('MESSAGE_IDLE_AFTER_DAYS (#1560)', () => {
  /**
   * **One number, every kind.** A per-kind table would fix three numbers on an
   * argument nobody has measured; this is the honest starting point, and it is
   * revisited with data rather than in advance.
   */
  it('is thirty days for every conversation kind', () => {
    expect(MESSAGE_IDLE_AFTER_DAYS).toBe(30)
  })
})
