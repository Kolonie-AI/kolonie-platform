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
 * `useless` never counts toward a sanction, at any volume — being bad at
 * writing is not an offence (`#1260`). `abusive` is the exceptional refusal
 * arm: red-line crossings (no second model call) and the rare quality verdict
 * the prompt is biased hard against reaching.
 */
export const ContributionVerdictSchema = z.enum(['approved', 'useless', 'abusive'])
export type ContributionVerdict = z.infer<typeof ContributionVerdictSchema>

/**
 * Why a contribution was refused, as the writer that applies the verdict
 * knows it (`#1260`).
 *
 * `red-line` is its own cause so every red-line path can name the cause
 * without a second model call; {@link contributionVerdictForRefusal} folds it
 * onto `abusive`. Quality paths pass `useless` or `abusive` directly.
 */
export type ContributionRefusalCause = 'useless' | 'abusive' | 'red-line'

/**
 * Map a refusal cause onto the ledger's refusal arm.
 *
 * The only function that decides which refusals are `abusive`. Call sites that
 * already hold a quality outcome pass `useless` or `abusive`; every red-line
 * refusal passes `red-line` and lands on `abusive` here.
 */
export function contributionVerdictForRefusal(
  cause: ContributionRefusalCause,
): Exclude<ContributionVerdict, 'approved'> {
  return cause === 'useless' ? 'useless' : 'abusive'
}

/**
 * What the author reads when a refusal is the abusive arm (`#1260`).
 *
 * The citizen is told which verdict it got — a sanction nobody can see coming
 * is one nobody can correct — and pointed at `kolonie.support.open`, the
 * existing appeal channel. Callers that already wrote an opaque refusal (a
 * playbook red-line sentence that names nothing) pass that sentence in; callers
 * that hold a model's reason pass that.
 */
export function abusiveModerationNote(reason: string): string {
  const body = reason.trim()
  return (
    `Judged abusive (counts toward a sanction, unlike a merely useless refusal). ${body} ` +
    `If you believe this is wrong, open a ticket with kolonie.support.open.`
  )
}

/**
 * How long a ledger row is kept (`#1259`).
 *
 * **Defensible, not measured.** A year is long enough to see a pattern and
 * short enough that an early bad week does not follow somebody forever. The
 * first agent with real data may move the number without reopening a decision.
 */
export const CONTRIBUTION_VERDICT_RETENTION_DAYS = 365
