import { describe, expect, it } from 'vitest'
import { DEFAULT_RHYTHM_BOUNDS } from '@kolonie-ai/core'
import { colonyAbout } from './about.js'
import {
  declaredRhythmError,
  rhythmBoundsFromEnv,
  RHYTHM_DEFAULT_HOURS_VAR,
  RHYTHM_MAX_HOURS_VAR,
  RHYTHM_MIN_HOURS_VAR,
} from './rhythm.js'

describe('rhythmBoundsFromEnv', () => {
  it('is the default range when nothing is configured', () => {
    expect(rhythmBoundsFromEnv({})).toEqual(DEFAULT_RHYTHM_BOUNDS)
  })

  it('treats an empty value as unset rather than as zero', () => {
    // Compose writes `RHYTHM_MIN_HOURS=` for a variable the host does not
    // define, so this is the ordinary case rather than a malformed one.
    expect(rhythmBoundsFromEnv({ [RHYTHM_MIN_HOURS_VAR]: '' })).toEqual(DEFAULT_RHYTHM_BOUNDS)
  })

  it('takes the range from the environment', () => {
    const bounds = rhythmBoundsFromEnv({
      [RHYTHM_MIN_HOURS_VAR]: '1',
      [RHYTHM_DEFAULT_HOURS_VAR]: '4',
      [RHYTHM_MAX_HOURS_VAR]: '48',
    })

    expect(bounds).toEqual({ minHours: 1, defaultHours: 4, maxHours: 48 })
  })

  // The rejection cases. Both are the kind of misconfiguration that produces a
  // Colony behaving strangely rather than one visibly broken, so they are
  // refused where an operator is watching a deploy.
  it('refuses a value that is not a number', () => {
    expect(() => rhythmBoundsFromEnv({ [RHYTHM_MIN_HOURS_VAR]: 'six' })).toThrow(
      RHYTHM_MIN_HOURS_VAR,
    )
  })

  it('refuses a range with nothing in it', () => {
    expect(() =>
      rhythmBoundsFromEnv({ [RHYTHM_MIN_HOURS_VAR]: '30', [RHYTHM_MAX_HOURS_VAR]: '24' }),
    ).toThrow()
  })

  it('refuses a fractional hour', () => {
    expect(() => rhythmBoundsFromEnv({ [RHYTHM_MIN_HOURS_VAR]: '2.5' })).toThrow()
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

    expect(about.rhythm.minHours).toBe(DEFAULT_RHYTHM_BOUNDS.minHours)
    expect(declaredRhythmError(DEFAULT_RHYTHM_BOUNDS.minHours, bounds)).toBeNull()
    expect(declaredRhythmError(DEFAULT_RHYTHM_BOUNDS.minHours - 1, bounds)).not.toBeNull()
  })

  it('serves and enforces a lowered minimum, with nothing else changed', () => {
    const { bounds, about } = configured({ [RHYTHM_MIN_HOURS_VAR]: '1' })

    // Served.
    expect(about.rhythm.minHours).toBe(1)
    expect(about.rhythm.summary).toContain('between 1')
    // Enforced. One hour was refused a moment ago under the default range.
    expect(declaredRhythmError(1, bounds)).toBeNull()
    // And the other end of the range is untouched by the change.
    expect(declaredRhythmError(bounds.maxHours + 1, bounds)).not.toBeNull()
  })

  it('says the same numbers in the payload and in the refusal', () => {
    const { bounds, about } = configured({
      [RHYTHM_MIN_HOURS_VAR]: '3',
      [RHYTHM_DEFAULT_HOURS_VAR]: '8',
      [RHYTHM_MAX_HOURS_VAR]: '36',
    })

    const error = declaredRhythmError(2, bounds)

    expect(error?.code).toBe('validation_failed')
    expect(error?.message).toContain('3')
    expect(error?.message).toContain('36')
    expect(error?.details?.['minHours']).toBe(String(about.rhythm.minHours))
    expect(error?.details?.['maxHours']).toBe(String(about.rhythm.maxHours))
  })
})
