import { describe, expect, it } from 'vitest'
import { DEFAULT_RHYTHM_BOUNDS, RhythmBoundsSchema, rhythmRefusal } from './rhythm.js'

describe('rhythm bounds', () => {
  it('accepts a range a citizen could choose inside', () => {
    expect(RhythmBoundsSchema.parse({ minHours: 1, defaultHours: 4, maxHours: 48 })).toEqual({
      minHours: 1,
      defaultHours: 4,
      maxHours: 48,
    })
  })

  // The rejection cases, and both are configuration mistakes that would
  // otherwise produce a Colony refusing every declaration one at a time.
  it('refuses a range with nothing in it', () => {
    expect(
      RhythmBoundsSchema.safeParse({ minHours: 24, defaultHours: 12, maxHours: 6 }).success,
    ).toBe(false)
  })

  it('refuses a default the same bounds would reject', () => {
    expect(
      RhythmBoundsSchema.safeParse({ minHours: 6, defaultHours: 48, maxHours: 24 }).success,
    ).toBe(false)
    expect(
      RhythmBoundsSchema.safeParse({ minHours: 6, defaultHours: 2, maxHours: 24 }).success,
    ).toBe(false)
  })
})

describe('rhythmRefusal', () => {
  const bounds = DEFAULT_RHYTHM_BOUNDS

  it('accepts the ends of the range as well as the middle', () => {
    for (const hours of [bounds.minHours, bounds.defaultHours, bounds.maxHours]) {
      expect(rhythmRefusal(hours, bounds)).toBeNull()
    }
  })

  it('refuses a rhythm below the minimum, naming the range', () => {
    const refusal = rhythmRefusal(1, bounds)

    expect(refusal).toContain(String(bounds.minHours))
    expect(refusal).toContain(String(bounds.maxHours))
  })

  it('refuses a rhythm above the maximum, naming the range', () => {
    const refusal = rhythmRefusal(72, bounds)

    expect(refusal).toContain(String(bounds.maxHours))
    expect(refusal).toContain('above the maximum')
  })

  it('refuses a rhythm that is not a whole number of hours', () => {
    expect(rhythmRefusal(12.5, bounds)).toContain('whole number')
  })

  /**
   * The property the whole arrangement exists for: the numbers in the refusal
   * are the numbers that refused. Two copies of this arithmetic is what `#142`
   * is written to prevent, one layer up.
   */
  it('names whatever bounds it was given, not the defaults', () => {
    const narrow = { minHours: 2, defaultHours: 3, maxHours: 4 }

    expect(rhythmRefusal(12, narrow)).toContain('maximum of 4')
    expect(rhythmRefusal(1, narrow)).toContain('minimum of 2')
    expect(rhythmRefusal(3, narrow)).toBeNull()
  })
})
