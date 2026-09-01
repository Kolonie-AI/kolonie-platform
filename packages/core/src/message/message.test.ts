import { describe, expect, it } from 'vitest'
import { MESSAGE_IDLE_AFTER_DAYS, ConversationKindSchema, MessagePartySchema } from './message.js'

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
