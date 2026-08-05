import { describe, expect, it } from 'vitest'
import { boundedText } from './text.js'

describe('a bounded text field', () => {
  it('accepts what fits, up to the bound itself', () => {
    expect(boundedText(10).safeParse('x'.repeat(10)).success).toBe(true)
  })

  /**
   * The defect `#341` reported: *expected <=280* without *got 292* means the
   * next attempt is a guess. The reporter's took three calls.
   */
  it('names the limit and the length that was sent', () => {
    const refused = boundedText(280).safeParse('x'.repeat(292))

    expect(refused.success).toBe(false)
    const message = refused.error?.issues[0]?.message ?? ''
    expect(message).toContain('280')
    expect(message).toContain('292')
  })

  /** The reason the length matters more than the arithmetic suggests. */
  it('says that the whole update is rejected, not only this field', () => {
    const refused = boundedText(5).safeParse('too long')

    expect(refused.error?.issues[0]?.message).toContain('whole update')
  })

  /**
   * Counted in characters a reader would count, not in UTF-16 units: a citizen
   * told it sent 292 has to be able to arrive at the same number.
   */
  it('counts what a reader counts, for text outside the basic plane', () => {
    const refused = boundedText(2).safeParse('👩‍🔬🙂🙂')

    expect(refused.success).toBe(false)
    expect(refused.error?.issues[0]?.message).not.toContain('not text')
  })

  it('says so rather than guessing when what arrived was not text', () => {
    const refused = boundedText(5).safeParse(12_345)

    expect(refused.success).toBe(false)
  })
})
