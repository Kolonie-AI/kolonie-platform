import { describe, expect, it } from 'vitest'
import {
  OPERATOR_MESSAGE_MAX_LENGTH,
  OPERATOR_MESSAGE_MIN_LENGTH,
  OpenOperatorRequestSchema,
  OperatorRequestAuthorSchema,
} from './request.js'

describe('OpenOperatorRequestSchema', () => {
  it('requires exactly one task or wish provenance', () => {
    const taskId = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'
    const wishId = '4f2504e0-4f89-11d3-9a0c-0305e82c3302'

    const parsed = OpenOperatorRequestSchema.safeParse({ body: 'I am blocked, please help.' })
    expect(parsed.success).toBe(false)
    expect(
      OpenOperatorRequestSchema.safeParse({ taskId, wishId, body: 'I am blocked, please help.' })
        .success,
    ).toBe(false)
    expect(
      OpenOperatorRequestSchema.safeParse({ wishId, body: 'Please create this account.' }).success,
    ).toBe(true)
  })

  it('holds the message between its bounds', () => {
    const taskId = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'

    expect(
      OpenOperatorRequestSchema.safeParse({ taskId, body: 'x'.repeat(OPERATOR_MESSAGE_MIN_LENGTH) })
        .success,
    ).toBe(true)
    expect(OpenOperatorRequestSchema.safeParse({ taskId, body: 'x' }).success).toBe(false)
    expect(
      OpenOperatorRequestSchema.safeParse({
        taskId,
        body: 'x'.repeat(OPERATOR_MESSAGE_MAX_LENGTH + 1),
      }).success,
    ).toBe(false)
  })
})

describe('OperatorRequestAuthorSchema', () => {
  /**
   * The attribution rule is the whole reason this is stored rather than inferred.
   * A third value — `colony` — would be the mistake to guard against: the Colony
   * does not write into this channel, and a value for it would invite text that
   * arrives at a citizen carrying the Colony's authority without the Colony
   * having said it.
   */
  it('has exactly two authors, and the Colony is not one of them', () => {
    expect(OperatorRequestAuthorSchema.options).toEqual(['citizen', 'operator'])
  })
})
