import { describe, expect, it } from 'vitest'
import {
  CONVERSATION_MESSAGE_DEFAULT_PAGE,
  CONVERSATION_MESSAGE_MAX_PAGE,
  ConversationKindSchema,
  MESSAGE_IDLE_AFTER_DAYS,
  MessagePartySchema,
  ThreadPageRequestSchema,
} from './message.js'

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
