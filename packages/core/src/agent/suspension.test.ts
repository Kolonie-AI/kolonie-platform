import { describe, expect, it } from 'vitest'
import { abusiveSuspensionReason, withSuspensionAppeal } from '../guidance/contribution-verdict.js'
import {
  SuspensionStandingSchema,
  suspensionStandingLine,
  unrecordedSuspensionReason,
  unrecordedSuspensionStanding,
} from './suspension.js'

describe('a suspension a citizen can read (#1291)', () => {
  it('carries the appeal channel however the reason was written', () => {
    expect(unrecordedSuspensionReason()).toContain('kolonie.support.open')
    expect(abusiveSuspensionReason(new Date('2026-09-01T00:00:00.000Z'))).toContain(
      'kolonie.support.open',
    )
    expect(withSuspensionAppeal('Suspended by a maintainer.')).toContain('kolonie.support.open')
  })

  it('says a walk-prose suspension will not lapse, because waiting is not a strategy there', () => {
    const standing = SuspensionStandingSchema.parse({
      reason: unrecordedSuspensionReason(),
      source: 'unrecorded',
      startedAt: null,
      expiresAt: null,
    })
    expect(suspensionStandingLine(standing)).toContain('does not lapse on its own')
  })

  it('adds the lapse day to a maintainer reason that never named one', () => {
    const standing = SuspensionStandingSchema.parse({
      reason: withSuspensionAppeal('Suspended by a maintainer.'),
      source: 'maintainer',
      startedAt: '2026-08-01T00:00:00.000Z',
      expiresAt: '2026-08-15T00:00:00.000Z',
    })
    expect(suspensionStandingLine(standing)).toContain('Lapses on 2026-08-15.')
  })

  it('does not say the lapse twice when the reason already carries it', () => {
    const reason = abusiveSuspensionReason(new Date('2026-09-01T00:00:00.000Z'))
    const standing = SuspensionStandingSchema.parse({
      reason,
      source: 'abusive-rate',
      startedAt: '2026-08-18T00:00:00.000Z',
      expiresAt: '2026-09-01T00:00:00.000Z',
    })
    const line = suspensionStandingLine(standing)
    expect(line).toBe(reason)
    expect(line.match(/lapse/gi)).toHaveLength(1)
  })

  it('hands three surfaces one standing rather than three literals (#1341)', () => {
    const standing = unrecordedSuspensionStanding()
    expect(SuspensionStandingSchema.parse(standing)).toEqual(standing)
    expect(standing.source).toBe('unrecorded')
    expect(standing.startedAt).toBeNull()
    expect(standing.expiresAt).toBeNull()
    expect(standing.reason).toBe(unrecordedSuspensionReason())
  })

  it('names the surface that cannot see a walk-prose suspension (#1341)', () => {
    // The citizen in #1341 read `contributions.quality` as evidence against the
    // walk-prose cause. The reason has to say why that ledger is silent on it.
    expect(unrecordedSuspensionReason()).toContain('kolonie.contributions.quality')
  })

  it('refuses a source the write paths cannot produce', () => {
    expect(
      SuspensionStandingSchema.safeParse({
        reason: 'x',
        source: 'rhythm',
        startedAt: null,
        expiresAt: null,
      }).success,
    ).toBe(false)
  })
})
