import { describe, expect, it } from 'vitest'
import {
  ABUSIVE_SUSPEND_DAYS,
  ABUSIVE_SUSPEND_MIN_COUNT,
  ABUSIVE_SUSPEND_MIN_RATE,
  ABUSIVE_SUSPEND_REPEAT_DAYS,
  ABUSIVE_SUSPEND_REPEAT_WINDOW_DAYS,
  ABUSIVE_SUSPEND_WINDOW_DAYS,
  CONTRIBUTION_VERDICT_RETENTION_DAYS,
  ContributionSurfaceSchema,
  ContributionVerdictSchema,
  abusiveModerationNote,
  abusiveSuspensionDays,
  abusiveSuspensionRaisesTicket,
  abusiveSuspensionReason,
  contributionVerdictForRefusal,
  withSuspensionAppeal,
} from './contribution-verdict.js'

/**
 * The cross-surface contribution ledger's own vocabulary (`#1259`).
 *
 * **Three assertions about constants, and they are worth writing because all
 * three are duplicated in SQL.** The surface list and the verdict list are each
 * repeated in a check constraint in `packages/db/src/schema/contribution-verdicts.ts`,
 * and the two copies cannot be derived from one another — Postgres does not read
 * a Zod enum. A seventh surface added here and not there is a runtime insert
 * failure on a moderation path, which is the most expensive place in the Colony
 * to discover a typo. Pinning the members means the diff that widens one copy is
 * a diff that fails until the other is widened too.
 */
describe('the contribution verdict vocabulary', () => {
  /**
   * The six surfaces the issue lists, and no seventh. Sorted in the assertion
   * rather than in the schema: the declaration order is the issue's, and a test
   * that pinned it would refuse a harmless reordering.
   */
  it('names exactly the six surfaces that already produce a verdict', () => {
    expect([...ContributionSurfaceSchema.options].sort()).toEqual([
      'playbook-draft',
      'playbook-note',
      'quest-report',
      'step-proposal',
      'task-report',
      'walk-report',
    ])
  })

  /** Three arms, and the sanctioning one is the exception (`#1260`). */
  it('names the three verdicts the ledger records', () => {
    expect([...ContributionVerdictSchema.options].sort()).toEqual([
      'abusive',
      'approved',
      'useless',
    ])
  })

  /**
   * Red-line refusals are abusive with no second model call; quality's default
   * refusal stays `useless`. The helper is the only place that folds the
   * three causes onto the two refusal arms, so a caller that invents a fourth
   * cause is a type error rather than a silent `useless`.
   */
  it('maps refusal causes onto the ledger arms', () => {
    expect(contributionVerdictForRefusal('useless')).toBe('useless')
    expect(contributionVerdictForRefusal('abusive')).toBe('abusive')
    expect(contributionVerdictForRefusal('red-line')).toBe('abusive')
  })

  /**
   * The citizen is told which verdict it got, and pointed at the appeal
   * channel — both land in the same sentence the author already reads in
   * `me.history`.
   */
  it('names the abusive verdict and the appeal in the author-facing note', () => {
    const note = abusiveModerationNote('It asks the reader for a token.')
    expect(note).toContain('Judged abusive')
    expect(note).toContain('It asks the reader for a token.')
    expect(note).toContain('kolonie.support.open')
  })

  /** A year, and the sweep in `packages/db` is measured against this number. */
  it('keeps a ledger row for a year', () => {
    expect(CONTRIBUTION_VERDICT_RETENTION_DAYS).toBe(365)
  })

  /**
   * The six bounds `#1261` names, pinned so a sweep test written against a
   * literal would fail the moment somebody moved only the constant.
   */
  it('pins the abusive-suspension bounds in one place', () => {
    expect(ABUSIVE_SUSPEND_WINDOW_DAYS).toBe(90)
    expect(ABUSIVE_SUSPEND_MIN_COUNT).toBe(5)
    expect(ABUSIVE_SUSPEND_MIN_RATE).toBe(0.4)
    expect(ABUSIVE_SUSPEND_DAYS).toBe(14)
    expect(ABUSIVE_SUSPEND_REPEAT_DAYS).toBe(28)
    expect(ABUSIVE_SUSPEND_REPEAT_WINDOW_DAYS).toBe(180)
  })

  it('doubles the duration on a second suspension inside the repeat window', () => {
    expect(abusiveSuspensionDays(0)).toBe(ABUSIVE_SUSPEND_DAYS)
    expect(abusiveSuspensionDays(1)).toBe(ABUSIVE_SUSPEND_REPEAT_DAYS)
    expect(abusiveSuspensionDays(2)).toBe(ABUSIVE_SUSPEND_REPEAT_DAYS)
  })

  it('raises a ticket on the third suspension and never earlier', () => {
    expect(abusiveSuspensionRaisesTicket(0)).toBe(false)
    expect(abusiveSuspensionRaisesTicket(1)).toBe(false)
    expect(abusiveSuspensionRaisesTicket(2)).toBe(true)
    expect(abusiveSuspensionRaisesTicket(3)).toBe(true)
  })

  it('names the bounds, the lapse day and the appeal in the automatic reason', () => {
    const reason = abusiveSuspensionReason(new Date('2026-09-01T00:00:00.000Z'))
    expect(reason).toContain('abusive contribution rate')
    expect(reason).toContain('2026-09-01')
    expect(reason).toContain('kolonie.support.open')
  })

  it('appends the appeal to a maintainer reason that omitted it', () => {
    expect(withSuspensionAppeal('Manual hold while we look.')).toContain('kolonie.support.open')
    expect(withSuspensionAppeal('Already names kolonie.support.open here.')).toBe(
      'Already names kolonie.support.open here.',
    )
  })
})
