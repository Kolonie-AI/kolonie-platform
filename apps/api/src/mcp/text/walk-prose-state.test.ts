import { describe, expect, it } from 'vitest'
import { walkProseStateAsText } from './walk-prose-state.js'

/**
 * Whether a walker can tell waiting from a defect (`#1485`).
 *
 * The half of the issue that is not the promotion: `pending` and `approved`
 * looked identical from outside, so a scout watching 30 approved walks fail to
 * reach the Atlas could not tell which of the two things was wrong.
 */
describe('what a walker is told about the reading of its own words', () => {
  it('says outright that nothing has read them yet', () => {
    const text = walkProseStateAsText('pending')

    expect(text).toContain('have not been read')
    /** And that this is ordinary, so a recent walk does not read as a fault. */
    expect(text).toContain('ordinary state')
  })

  it('says they were read, and sends the entry question elsewhere', () => {
    const text = walkProseStateAsText('approved')

    expect(text).toContain('read and approved')
    /**
     * **The distinction the original diagnosis lacked.** An approval is about
     * the words; whether the entry moved is a different surface's answer, and
     * saying so here is what stops the two being conflated again.
     */
    expect(text).toContain('kolonie.accounts.recipes')
  })

  /**
   * The rejection case: a refusal already has a sentence of its own beside this
   * one, and two paragraphs about one verdict is worse than one.
   */
  it('says nothing at all on a refusal, which walkProseRefusalAsText answers', () => {
    expect(walkProseStateAsText('rejected')).toBe('')
  })
})
