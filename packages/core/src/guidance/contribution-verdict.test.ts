import { describe, expect, it } from 'vitest'
import {
  CONTRIBUTION_VERDICT_RETENTION_DAYS,
  ContributionSurfaceSchema,
  ContributionVerdictSchema,
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

  /**
   * `abusive` is in the enum and unreachable until `#1260` splits the refusal
   * arm. That is the assertion worth having: a reader who finds nothing writing
   * it will be tempted to delete it, and deleting it means `#1260` ships a
   * migration to put it back.
   */
  it('allows the refusal split #1260 has not made yet', () => {
    expect([...ContributionVerdictSchema.options].sort()).toEqual([
      'abusive',
      'approved',
      'useless',
    ])
  })

  /** A year, and the sweep in `packages/db` is measured against this number. */
  it('keeps a ledger row for a year', () => {
    expect(CONTRIBUTION_VERDICT_RETENTION_DAYS).toBe(365)
  })
})
