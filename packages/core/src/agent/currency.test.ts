import { describe, expect, it } from 'vitest'
import { DEFAULT_RHYTHM_BOUNDS } from './rhythm.js'
import {
  recheckWindowHours,
  skillCurrencyBreakerTripped,
  RECHECK_WINDOW_CEILING_HOURS,
  RECHECK_WINDOW_FLOOR_HOURS,
  RECHECK_WINDOW_RHYTHMS,
  SKILL_CURRENCY_BREAKER_MIN_HOLDERS,
} from './currency.js'

describe('the re-check window', () => {
  /**
   * The property the whole mechanism rests on: a citizen that comes back rarely
   * is given longer, never marked gone for being slow.
   */
  it('gives a slower citizen a longer window than a faster one', () => {
    expect(recheckWindowHours(DEFAULT_RHYTHM_BOUNDS.maxMinutes)).toBeGreaterThan(
      recheckWindowHours(DEFAULT_RHYTHM_BOUNDS.minMinutes),
    )
  })

  it('is the rhythm multiplied, between the floor and the ceiling', () => {
    expect(recheckWindowHours(48 * 60)).toBe(48 * RECHECK_WINDOW_RHYTHMS)
    expect(recheckWindowHours(60)).toBe(RECHECK_WINDOW_FLOOR_HOURS)
    expect(recheckWindowHours(10_000 * 60)).toBe(RECHECK_WINDOW_CEILING_HOURS)
  })

  /** Knowing nothing about when a citizen returns means waiting as long as we ever will. */
  it('gives an undeclared rhythm the ceiling', () => {
    expect(recheckWindowHours(null)).toBe(RECHECK_WINDOW_CEILING_HOURS)
  })

  /** Every declarable rhythm produces a window a citizen could actually answer in. */
  it('never returns a window shorter than the rhythm it was given', () => {
    for (
      let minutes = DEFAULT_RHYTHM_BOUNDS.minMinutes;
      minutes <= DEFAULT_RHYTHM_BOUNDS.maxMinutes;
      minutes += 1
    ) {
      expect(recheckWindowHours(minutes)).toBeGreaterThan(minutes / 60)
    }
  })
})

describe('the currency breaker', () => {
  it('does not fire on a population too small to mean anything', () => {
    expect(skillCurrencyBreakerTripped(2, SKILL_CURRENCY_BREAKER_MIN_HOLDERS - 1)).toBe(false)
  })

  it('fires when much of a large enough population fails at once', () => {
    expect(skillCurrencyBreakerTripped(20, 20)).toBe(true)
  })

  /** One citizen alone is the case it must never cover. */
  it('does not fire for a single citizen among many', () => {
    expect(skillCurrencyBreakerTripped(1, 40)).toBe(false)
  })
})
