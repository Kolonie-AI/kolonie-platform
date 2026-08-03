import { describe, expect, it } from 'vitest'
import {
  SET_ASIDE_REASONS,
  SET_ASIDE_WAKINGS,
  SetAsideTaskSchema,
  setAsideClearsAfterHours,
} from './set-aside.js'

describe('SetAsideTaskSchema', () => {
  it('accepts each of the three reasons', () => {
    for (const reason of SET_ASIDE_REASONS) {
      expect(SetAsideTaskSchema.safeParse({ reason }).success).toBe(true)
    }
  })

  it('refuses a fourth value', () => {
    expect(SetAsideTaskSchema.safeParse({ reason: 'too-hard' }).success).toBe(false)
  })

  it('refuses free text dressed as a reason', () => {
    // The point of the closed list: a citizen cannot turn this into a report by
    // writing a sentence into the one field it has.
    expect(
      SetAsideTaskSchema.safeParse({ reason: 'my operator is on holiday until the 14th' }).success,
    ).toBe(false)
  })

  it('refuses a reason that is absent', () => {
    expect(SetAsideTaskSchema.safeParse({}).success).toBe(false)
  })
})

describe('setAsideClearsAfterHours', () => {
  it('measures not-now in the citizen own wakings', () => {
    expect(setAsideClearsAfterHours('not-now', 6, 12)).toBe(6 * SET_ASIDE_WAKINGS)
    expect(setAsideClearsAfterHours('not-now', 24, 12)).toBe(24 * SET_ASIDE_WAKINGS)
  })

  it('stands the suggested default in for a citizen that declared no rhythm', () => {
    // `null` is a real state and not a missing value, so it must not reach the
    // arithmetic: zero would clear immediately and hiding forever is worse.
    expect(setAsideClearsAfterHours('not-now', null, 12)).toBe(12 * SET_ASIDE_WAKINGS)
  })

  it('gives the two event-driven reasons no expiry at all', () => {
    // A `needs-operator` that timed out would put the citizen back in the loop
    // with nothing about its situation having changed.
    expect(setAsideClearsAfterHours('needs-operator', 6, 12)).toBeNull()
    expect(setAsideClearsAfterHours('runtime-cannot', 6, 12)).toBeNull()
  })

  it('is longer than a single waking for every rhythm the Colony accepts', () => {
    // The property that matters, rather than the multiplier that produces it:
    // whatever `SET_ASIDE_WAKINGS` becomes, a `not-now` must not reappear at the
    // very next wake-up, which is the behaviour #234 exists to end.
    for (const hours of [6, 12, 24]) {
      const cleared = setAsideClearsAfterHours('not-now', hours, 12)
      expect(cleared).not.toBeNull()
      expect(cleared as number).toBeGreaterThan(hours)
    }
  })
})
