import { describe, expect, it } from 'vitest'
import { chooseStandingHint, STANDING_HINT_RANK, type StandingHintCode } from './standing.js'

/**
 * `#231`: one hint, never a list.
 *
 * The precedence rule is here rather than in the query that answers *what
 * applies*, so it can be asserted without a database — and so that the day a
 * second condition is added, the thing that decides which of the two a citizen
 * reads is a value somebody had to edit deliberately.
 */
describe('choosing between conditions that all apply', () => {
  it('answers nothing when nothing applies', () => {
    expect(chooseStandingHint([])).toBeUndefined()
  })

  it('answers the only applicable condition', () => {
    expect(chooseStandingHint(['rhythm-undeclared'])).toBe('rhythm-undeclared')
  })

  /**
   * The rule that keeps the channel from becoming an inbox, asserted against
   * whatever the rank happens to contain — so it keeps holding as conditions are
   * added rather than being a test about today's two.
   */
  it('answers exactly one, the highest ranked, whatever applies', () => {
    const everything = [...STANDING_HINT_RANK]
    const chosen = chooseStandingHint(everything)

    expect(chosen).toBe(STANDING_HINT_RANK[0])
    expect(everything.filter((code) => code === chosen)).toHaveLength(1)
  })

  /**
   * Rank order decides, and the order the caller happened to collect them in
   * does not. The query in `standing-hints.ts` builds its array by appending in
   * source order, which would otherwise be a second, accidental ranking.
   */
  it('ignores the order the conditions were collected in', () => {
    const reversed = [...STANDING_HINT_RANK].reverse()

    expect(chooseStandingHint(reversed)).toBe(STANDING_HINT_RANK[0])
  })

  it('ignores a condition that is not ranked', () => {
    const unranked = ['not-a-condition' as StandingHintCode]

    expect(chooseStandingHint(unranked)).toBeUndefined()
  })
})
