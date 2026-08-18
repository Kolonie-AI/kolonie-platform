import { describe, expect, it } from 'vitest'
import {
  CONTRIBUTION_VERDICT_RETENTION_DAYS,
  ContributionSurfaceSchema,
  ContributionVerdictSchema,
  abusiveModerationNote,
  contributionVerdictForRefusal,
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
})
