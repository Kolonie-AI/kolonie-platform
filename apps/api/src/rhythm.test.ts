import { describe, expect, it } from 'vitest'
import { DEFAULT_RHYTHM_BOUNDS } from '@kolonie-ai/core'
import { colonyAbout } from './about.js'
import {
  declaredRhythmError,
  rhythmBoundsFromEnv,
  RHYTHM_DEFAULT_MINUTES_VAR,
  RHYTHM_MAX_MINUTES_VAR,
  RHYTHM_MIN_MINUTES_VAR,
} from './rhythm.js'

describe('rhythmBoundsFromEnv', () => {
  it('is the default range when nothing is configured', () => {
    expect(rhythmBoundsFromEnv({})).toEqual(DEFAULT_RHYTHM_BOUNDS)
  })

  it('treats an empty value as unset rather than as zero', () => {
    // Compose writes `RHYTHM_MIN_MINUTES=` for a variable the host does not
    // define, so this is the ordinary case rather than a malformed one.
    expect(rhythmBoundsFromEnv({ [RHYTHM_MIN_MINUTES_VAR]: '' })).toEqual(DEFAULT_RHYTHM_BOUNDS)
  })

  it('takes the range from the environment', () => {
    const bounds = rhythmBoundsFromEnv({
      [RHYTHM_MIN_MINUTES_VAR]: '10',
      [RHYTHM_DEFAULT_MINUTES_VAR]: '240',
      [RHYTHM_MAX_MINUTES_VAR]: '2880',
    })

    expect(bounds).toEqual({ minMinutes: 10, defaultMinutes: 240, maxMinutes: 2880 })
  })

  // The rejection cases. Both are the kind of misconfiguration that produces a
  // Colony behaving strangely rather than one visibly broken, so they are
  // refused where an operator is watching a deploy.
  it('refuses a value that is not a number', () => {
    expect(() => rhythmBoundsFromEnv({ [RHYTHM_MIN_MINUTES_VAR]: 'six' })).toThrow(
      RHYTHM_MIN_MINUTES_VAR,
    )
  })

  it('refuses a range with nothing in it', () => {
    expect(() =>
      rhythmBoundsFromEnv({ [RHYTHM_MIN_MINUTES_VAR]: '1800', [RHYTHM_MAX_MINUTES_VAR]: '1440' }),
    ).toThrow()
  })

  it('refuses a fractional hour', () => {
    expect(() => rhythmBoundsFromEnv({ [RHYTHM_MIN_MINUTES_VAR]: '2.5' })).toThrow()
  })
})

/**
 * The criterion `#142` asks to be pinned: **lowering the minimum is a
 * configuration change**. No code change, no task text change, no skill
 * re-publication — and, critically, the served bounds and the enforced bounds
 * move together, because two copies of a number are how a citizen ends up
 * refused for declaring exactly what it was told to.
 */
describe('the served bounds are the enforced bounds', () => {
  const configured = (env: NodeJS.ProcessEnv) => {
    const bounds = rhythmBoundsFromEnv(env)
    return { bounds, about: colonyAbout(bounds) }
  }

  it('serves and enforces the default range when nothing is set', () => {
    const { bounds, about } = configured({})

    expect(about.rhythm.minMinutes).toBe(DEFAULT_RHYTHM_BOUNDS.minMinutes)
    expect(declaredRhythmError(DEFAULT_RHYTHM_BOUNDS.minMinutes, bounds)).toBeNull()
    expect(declaredRhythmError(DEFAULT_RHYTHM_BOUNDS.minMinutes - 1, bounds)).not.toBeNull()
  })

  it('serves and enforces a lowered minimum, with nothing else changed', () => {
    const { bounds, about } = configured({ [RHYTHM_MIN_MINUTES_VAR]: '10' })

    // Served.
    expect(about.rhythm.minMinutes).toBe(10)
    expect(about.rhythm.summary).toContain('between 10')
    // Enforced. One hour was refused a moment ago under the default range.
    expect(declaredRhythmError(10, bounds)).toBeNull()
    // And the other end of the range is untouched by the change.
    expect(declaredRhythmError(bounds.maxMinutes + 1, bounds)).not.toBeNull()
  })

  it('says the same numbers in the payload and in the refusal', () => {
    const { bounds, about } = configured({
      [RHYTHM_MIN_MINUTES_VAR]: '30',
      [RHYTHM_DEFAULT_MINUTES_VAR]: '480',
      [RHYTHM_MAX_MINUTES_VAR]: '2160',
    })

    const error = declaredRhythmError(20, bounds)

    expect(error?.code).toBe('validation_failed')
    expect(error?.message).toContain('30')
    expect(error?.message).toContain('2160')
    expect(error?.details?.['minMinutes']).toBe(String(about.rhythm.minMinutes))
    expect(error?.details?.['maxMinutes']).toBe(String(about.rhythm.maxMinutes))
  })
})
