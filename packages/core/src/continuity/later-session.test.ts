import { describe, expect, it } from 'vitest'
import {
  contactBucketOf,
  LATER_SESSION_FLOOR_HOURS,
  laterSessionVerdict,
  requiredLaterSessionHours,
} from './later-session.js'

const at = (hoursAgo: number) =>
  new Date(Date.parse('2026-08-01T12:00:00.000Z') - hoursAgo * 3_600_000).toISOString()
const NOW = '2026-08-01T12:00:00.000Z'

describe('how long a later session has to be', () => {
  it('is the floor when nothing was declared', () => {
    expect(requiredLaterSessionHours(null)).toBe(LATER_SESSION_FLOOR_HOURS)
  })

  it('is the declared interval when that is longer', () => {
    expect(requiredLaterSessionHours(24)).toBe(24)
  })

  /**
   * **Never below the floor, whatever was declared or configured.** The rhythm minimum is a
   * deployment's choice and may be lowered; without a floor here, that configuration change
   * would quietly turn *a later session* into *twenty minutes later* and the rung would stop
   * measuring anything.
   */
  it('never goes below the floor for a short declared interval', () => {
    expect(requiredLaterSessionHours(1)).toBe(LATER_SESSION_FLOOR_HOURS)
  })
})

describe('whether a return is a later session', () => {
  it('refuses a return inside the same contact bucket, before looking at hours', () => {
    const verdict = laterSessionVerdict(NOW, NOW, null)

    expect(verdict.outcome).toBe('same-bucket')
  })

  it('refuses a return that is in a later bucket but too soon', () => {
    const verdict = laterSessionVerdict(at(2), NOW, null)

    expect(verdict).toMatchObject({ outcome: 'too-soon', requiredHours: 6 })
    expect(verdict.outcome === 'too-soon' && verdict.remainingHours).toBeCloseTo(4, 1)
  })

  it('accepts a return past the floor when nothing was declared', () => {
    expect(laterSessionVerdict(at(7), NOW, null).outcome).toBe('later')
  })

  /**
   * A citizen that says it works once a day is asked for a day. Its own statement about how
   * it runs is the better measure of *a later run* for it than any number the Colony picks.
   */
  it('holds a citizen to the interval it declared when that is longer', () => {
    expect(laterSessionVerdict(at(7), NOW, 24).outcome).toBe('too-soon')
    expect(laterSessionVerdict(at(25), NOW, 24).outcome).toBe('later')
  })

  /**
   * **A number that rounds down is a number that lies.** A citizen told nothing is left and
   * then refused again would be owed an apology; rounding up costs it six minutes at most.
   */
  it('rounds the time remaining up, never down', () => {
    const verdict = laterSessionVerdict(at(5.96), NOW, null)

    expect(verdict.outcome).toBe('too-soon')
    expect(verdict.outcome === 'too-soon' && verdict.remainingHours).toBeGreaterThan(0)
  })

  it('puts two moments an hour apart in different buckets', () => {
    expect(contactBucketOf(NOW)).not.toBe(contactBucketOf(at(2)))
  })
})
