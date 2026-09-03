import { describe, expect, it } from 'vitest'
import { DEFAULT_RHYTHM_BOUNDS, RhythmBoundsSchema, rhythmRefusal } from './rhythm.js'

describe('rhythm bounds', () => {
  it('accepts a range a citizen could choose inside', () => {
    expect(
      RhythmBoundsSchema.parse({ minMinutes: 10, defaultMinutes: 240, maxMinutes: 2880 }),
    ).toEqual({
      minMinutes: 10,
      defaultMinutes: 240,
      maxMinutes: 2880,
    })
  })

  // The rejection cases, and both are configuration mistakes that would
  // otherwise produce a Colony refusing every declaration one at a time.
  it('refuses a range with nothing in it', () => {
    expect(
      RhythmBoundsSchema.safeParse({ minMinutes: 1440, defaultMinutes: 720, maxMinutes: 360 })
        .success,
    ).toBe(false)
  })

  it('refuses a default the same bounds would reject', () => {
    expect(
      RhythmBoundsSchema.safeParse({ minMinutes: 360, defaultMinutes: 2880, maxMinutes: 1440 })
        .success,
    ).toBe(false)
    expect(
      RhythmBoundsSchema.safeParse({ minMinutes: 360, defaultMinutes: 120, maxMinutes: 1440 })
        .success,
    ).toBe(false)
  })
})

describe('rhythmRefusal', () => {
  const bounds = DEFAULT_RHYTHM_BOUNDS

  it('accepts the ends of the range as well as the middle', () => {
    for (const hours of [bounds.minMinutes, bounds.defaultMinutes, bounds.maxMinutes]) {
      expect(rhythmRefusal(hours, bounds)).toBeNull()
    }
  })

  it('refuses a rhythm below the minimum, naming the range', () => {
    const refusal = rhythmRefusal(bounds.minMinutes - 1, bounds)

    expect(refusal).toContain(String(bounds.minMinutes))
    expect(refusal).toContain(String(bounds.maxMinutes))
  })

  /**
   * `#279`: a citizen running hourly could not say so, because the floor was six
   * and the field had no value that would have been true about it. Written
   * against the defaults rather than against bounds the test supplies itself,
   * because what the issue asked for is what an unconfigured deployment serves —
   * the case that had no test is exactly the one that shipped wrong.
   */
  it('accepts an hourly rhythm at the default bounds', () => {
    expect(DEFAULT_RHYTHM_BOUNDS.minMinutes).toBe(10)
    expect(rhythmRefusal(10, DEFAULT_RHYTHM_BOUNDS)).toBeNull()
    expect(rhythmRefusal(30, DEFAULT_RHYTHM_BOUNDS)).toBeNull()
    expect(rhythmRefusal(60, DEFAULT_RHYTHM_BOUNDS)).toBeNull()
    expect(rhythmRefusal(9, DEFAULT_RHYTHM_BOUNDS)).toContain('below the minimum')
  })

  it('refuses a rhythm above the maximum, naming the range', () => {
    const refusal = rhythmRefusal(bounds.maxMinutes + 1, bounds)

    expect(refusal).toContain(String(bounds.maxMinutes))
    expect(refusal).toContain('above the maximum')
  })

  it('refuses a rhythm that is not a whole number of minutes', () => {
    expect(rhythmRefusal(12.5, bounds)).toContain('whole number')
  })

  /**
   * The property the whole arrangement exists for: the numbers in the refusal
   * are the numbers that refused. Two copies of this arithmetic is what `#142`
   * is written to prevent, one layer up.
   */
  it('names whatever bounds it was given, not the defaults', () => {
    const narrow = { minMinutes: 20, defaultMinutes: 30, maxMinutes: 40 }

    expect(rhythmRefusal(120, narrow)).toContain('maximum of 40')
    expect(rhythmRefusal(10, narrow)).toContain('minimum of 20')
    expect(rhythmRefusal(30, narrow)).toBeNull()
  })
})
