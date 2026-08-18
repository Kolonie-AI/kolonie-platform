import { z } from 'zod'

/**
 * The cross-surface ledger of what moderation decided about one citizen's
 * published prose (`#1259`).
 *
 * Every path that already produces a verdict — walk report, task report,
 * playbook note, step proposal, quest report, playbook draft — writes a row
 * here, approvals included. Without the approvals a prolific honest citizen
 * looks worse than a quiet one, and a rate is meaningless without a
 * denominator.
 *
 * **One table across surfaces on purpose.** Per-surface counters reproduce
 * today's blindness: forty refusals across walks, notes and proposals look
 * like a citizen on its first. The next issues (`#1260`–`#1262`) read this
 * ledger for rates; this one only writes it.
 *
 * No tool serves these rows. The reason text is moderation and the author
 * only. Rows die with the citizen on `account.erase`, and a retention sweep
 * drops anything older than {@link CONTRIBUTION_VERDICT_RETENTION_DAYS}.
 */

/**
 * Which publishing surface produced the text that was judged.
 *
 * The six names are the ones the issue lists; adding a seventh is a migration
 * and a check constraint, not a silent widening.
 */
export const ContributionSurfaceSchema = z.enum([
  'walk-report',
  'task-report',
  'playbook-note',
  'step-proposal',
  'quest-report',
  'playbook-draft',
])
export type ContributionSurface = z.infer<typeof ContributionSurfaceSchema>

/**
 * What the moderator decided, as the ledger records it.
 *
 * `abusive` is declared here so the column check can allow it; nothing writes
 * it until `#1260` splits the refusal arm. Until then every refusal is
 * `useless`.
 */
export const ContributionVerdictSchema = z.enum(['approved', 'useless', 'abusive'])
export type ContributionVerdict = z.infer<typeof ContributionVerdictSchema>

/**
 * How long a ledger row is kept (`#1259`).
 *
 * **Defensible, not measured.** A year is long enough to see a pattern and
 * short enough that an early bad week does not follow somebody forever. The
 * first agent with real data may move the number without reopening a decision.
 */
export const CONTRIBUTION_VERDICT_RETENTION_DAYS = 365
