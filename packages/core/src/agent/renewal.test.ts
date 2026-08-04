import { describe, expect, it } from 'vitest'
import { KNOWN_SKILLS } from '../common/skill.js'
import { rhythmAllowanceHours } from './rhythm.js'
import { DORMANT_AFTER_HOURS, isDormant, SKILL_RENEWAL_HOURS } from './renewal.js'

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString()

describe('skills that fall due', () => {
  it('names only skills that exist', () => {
    for (const skill of Object.keys(SKILL_RENEWAL_HOURS)) {
      expect(KNOWN_SKILLS).toContain(skill)
    }
  })

  /**
   * The rule this mechanism must not break: most skills certify something that
   * happened, and asking again would be the calendar farming
   * `domain-persistence` refuses. Only a claim about *now* falls due — the
   * rhythm a citizen keeps (`#143`), and the memory it carries across a session
   * boundary (`#159`), which is configuration and can be switched off under it.
   *
   * The list is pinned rather than merely checked for shape, so that adding a
   * third is a decision somebody has to make here, in front of this comment.
   */
  it('leaves every skill but the two claims about now alone', () => {
    expect(Object.keys(SKILL_RENEWAL_HOURS).sort()).toEqual(['memory', 'rhythm'])
  })

  it('gives a claim about now longer than any rhythm it could be measured against', () => {
    // The renewal interval must sit clear of the widest declarable rhythm plus
    // tolerance, or a citizen keeping its promise would meet renewal while
    // still inside its own interval.
    for (const skill of Object.keys(SKILL_RENEWAL_HOURS)) {
      expect(SKILL_RENEWAL_HOURS[skill as 'rhythm']!).toBeGreaterThan(rhythmAllowanceHours(24) * 5)
    }
  })
})

describe('dormancy', () => {
  it('is not reached by a citizen that called recently', () => {
    expect(isDormant(hoursAgo(1), hoursAgo(10_000))).toBe(false)
  })

  it('is reached by a citizen that has not called in a long time', () => {
    expect(isDormant(hoursAgo(DORMANT_AFTER_HOURS + 1), hoursAgo(10_000))).toBe(true)
  })

  /**
   * The hole the fallback closes: contact history is pruned, so a citizen absent
   * for longer than the retention bound has no rows at all — and reading *no
   * rows* as *not dormant* would make the longest-absent citizens look present.
   */
  it('falls back to when the citizen registered, rather than reading silence as presence', () => {
    expect(isDormant(null, hoursAgo(DORMANT_AFTER_HOURS + 1))).toBe(true)
    expect(isDormant(null, hoursAgo(1))).toBe(false)
  })

  /**
   * The two measurements must never be confusable: a citizen can be late
   * against its declared rhythm without being anywhere near dormant.
   */
  it('is an order of magnitude beyond a missed rhythm', () => {
    expect(DORMANT_AFTER_HOURS).toBeGreaterThan(rhythmAllowanceHours(24) * 5)
    // A citizen a day late on the widest rhythm there is, is not dormant.
    expect(isDormant(hoursAgo(rhythmAllowanceHours(24) + 24), hoursAgo(10_000))).toBe(false)
  })
})
