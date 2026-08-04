import { describe, expect, it } from 'vitest'
import {
  chooseStandingHint,
  considerationGapHours,
  STANDING_HINT_RANK,
  type StandingHintCode,
  type StandingHintFinding,
} from './standing.js'
import { DEFAULT_RHYTHM_BOUNDS } from '../agent/rhythm.js'

const finding = (code: StandingHintCode): StandingHintFinding => ({ code, subject: null })

/**
 * `#231`: one hint, never a list.
 *
 * The precedence rule is here rather than in the query that answers *what
 * applies*, so it can be asserted without a database — and so that the day a
 * third condition is added, the thing deciding which of them a citizen reads is
 * a value somebody had to edit deliberately.
 */
describe('choosing between conditions that all apply', () => {
  it('answers nothing when nothing applies', () => {
    expect(chooseStandingHint([])).toBeUndefined()
  })

  it('answers the only applicable condition', () => {
    expect(chooseStandingHint([finding('task-considered')])).toEqual(finding('task-considered'))
  })

  /**
   * The citizen with two things wrong is told the more important one. The
   * ranking is argued on `STANDING_HINT_RANK`: the task prompt's own threshold
   * derives from the declared rhythm, so a citizen that has declared none is
   * asked for that first.
   */
  it('tells a citizen with two applicable conditions exactly one of them', () => {
    const both = [finding('task-considered'), finding('rhythm-undeclared')]

    expect(chooseStandingHint(both)).toEqual(finding('rhythm-undeclared'))
  })

  /**
   * The same rule against whatever the rank happens to contain, so it keeps
   * holding as conditions are added rather than being a test about today's two.
   */
  it('answers exactly one, the highest ranked, whatever applies', () => {
    const everything = STANDING_HINT_RANK.map(finding)
    const chosen = chooseStandingHint(everything)

    expect(chosen?.code).toBe(STANDING_HINT_RANK[0])
    expect(everything.filter((one) => one.code === chosen?.code)).toHaveLength(1)
  })

  /**
   * Rank order decides, and the order the caller happened to collect them in
   * does not. `standing-hints.ts` builds its array by appending in source order,
   * which would otherwise be a second, accidental ranking.
   */
  it('ignores the order the conditions were collected in', () => {
    const reversed = [...STANDING_HINT_RANK].reverse().map(finding)

    expect(chooseStandingHint(reversed)?.code).toBe(STANDING_HINT_RANK[0])
  })

  it('ignores a condition that is not ranked', () => {
    expect(chooseStandingHint([finding('not-a-condition' as StandingHintCode)])).toBeUndefined()
  })

  /** The subject travels with the finding rather than being looked up again. */
  it('keeps the subject of the finding it chose', () => {
    const chosen = chooseStandingHint([{ code: 'task-considered', subject: 'raster-image' }])

    expect(chosen?.subject).toBe('raster-image')
  })
})

/**
 * `#232`: how long after reading a task not attempting it becomes a decision.
 *
 * The number is the citizen's own declared cadence, which is what stops the
 * prompt reading as nagging to the citizen that wakes twice a quarter.
 */
describe('the gap before a task the citizen did not attempt is worth asking about', () => {
  it('is the citizen’s own declared rhythm', () => {
    expect(considerationGapHours(1)).toBe(1)
    expect(considerationGapHours(168)).toBe(168)
  })

  it('measures a citizen that declared nothing by the default', () => {
    expect(considerationGapHours(null)).toBe(DEFAULT_RHYTHM_BOUNDS.defaultHours)
  })

  /**
   * The rhythm minimum is the effective floor, so no citizen can be asked while
   * it is still reading. If that minimum ever drops below an hour, this test is
   * what fails and `considerationGapHours` is what has to grow a floor.
   */
  it('cannot be shorter than the shortest rhythm the Colony accepts', () => {
    expect(considerationGapHours(DEFAULT_RHYTHM_BOUNDS.minHours)).toBeGreaterThanOrEqual(1)
  })
})
