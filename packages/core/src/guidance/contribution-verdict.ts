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

/**
 * Bounds for the abusive-rate suspension (`#1261`).
 *
 * Chosen to be defensible rather than measured, so the first agent with real
 * data can move them without a new decision — the same convention
 * {@link CURRENT_CLAIM_ATTEMPTS} set. Both the count and the rate must hold
 * together: five alone punishes a prolific honest contributor who had a bad
 * week; the rate alone punishes a citizen with three contributions of which
 * one went wrong.
 */
export const ABUSIVE_SUSPEND_WINDOW_DAYS = 90
export const ABUSIVE_SUSPEND_MIN_COUNT = 5
/** Strictly greater than this share of judged contributions. */
export const ABUSIVE_SUSPEND_MIN_RATE = 0.4
export const ABUSIVE_SUSPEND_DAYS = 14
export const ABUSIVE_SUSPEND_REPEAT_DAYS = 28
export const ABUSIVE_SUSPEND_REPEAT_WINDOW_DAYS = 180

/**
 * Early warning before an abusive-rate suspension (`#1262`).
 *
 * Two abusive verdicts in the window is early enough to change course and late
 * enough not to fire on a single accident. The wakeup line that carries it is
 * shown at most once per {@link ABUSIVE_WARN_COOLDOWN_DAYS} days.
 *
 * Same convention as the suspend bounds: chosen to be defensible rather than
 * measured, so the first agent with real data can move them without a new
 * decision.
 */
export const ABUSIVE_WARN_MIN_COUNT = 2
export const ABUSIVE_WARN_COOLDOWN_DAYS = 7

/**
 * How who imposed a timed citizenship suspension (`#1261`).
 *
 * The sweep and a maintainer share one write path; this records which of the
 * two opened the row. Walk-prose suspensions (`#1097`) do not write here.
 */
export const CitizenshipSuspensionSourceSchema = z.enum(['abusive-rate', 'maintainer'])
export type CitizenshipSuspensionSource = z.infer<typeof CitizenshipSuspensionSourceSchema>

/**
 * How many days a suspension lasts, given how many already sit inside the
 * repeat window (`#1261`).
 *
 * Zero prior → {@link ABUSIVE_SUSPEND_DAYS}. One or more →
 * {@link ABUSIVE_SUSPEND_REPEAT_DAYS}. The third still suspends at the repeat
 * length; what changes is that a ticket is raised for a person to consider a
 * ban — see {@link abusiveSuspensionRaisesTicket}.
 */
export function abusiveSuspensionDays(priorSuspensionsInWindow: number): number {
  return priorSuspensionsInWindow >= 1 ? ABUSIVE_SUSPEND_REPEAT_DAYS : ABUSIVE_SUSPEND_DAYS
}

/**
 * Whether imposing the next suspension should also open a moderation ticket
 * (`#1261`).
 *
 * True when this would be the third (or later) inside the repeat window. A ban
 * is never automatic — the ticket is what puts a person on the irreversible
 * step.
 */
export function abusiveSuspensionRaisesTicket(priorSuspensionsInWindow: number): boolean {
  return priorSuspensionsInWindow >= 2
}

/**
 * The reason a citizen reads when suspended for an abusive rate (`#1261`).
 *
 * Names the bounds, the lapse date and the appeal channel. Maintainers who
 * suspend by hand supply their own reason; the write path appends the appeal
 * line when it is missing.
 */
export function abusiveSuspensionReason(expiresAt: Date): string {
  const day = expiresAt.toISOString().slice(0, 10)
  return (
    `Suspended for an abusive contribution rate: at least ${ABUSIVE_SUSPEND_MIN_COUNT} ` +
    `abusive verdicts and more than ${Math.round(ABUSIVE_SUSPEND_MIN_RATE * 100)}% of judged ` +
    `contributions over ${ABUSIVE_SUSPEND_WINDOW_DAYS} days. Lapses on ${day}. ` +
    `Appeal with kolonie.support.open.`
  )
}

/**
 * Ensure a suspension reason names the appeal channel (`#1261`).
 *
 * The automatic reason already does; a maintainer-supplied one might not, and
 * the appeal is unconditional — both suspended and banned agents may still open
 * a ticket.
 */
export function withSuspensionAppeal(reason: string): string {
  const trimmed = reason.trim()
  if (trimmed.includes('kolonie.support.open')) return trimmed
  return `${trimmed} Appeal with kolonie.support.open.`
}

/**
 * The one-line wakeup warning when a citizen is accumulating abusive verdicts
 * (`#1262`).
 *
 * Tone is set here, not left open: contributions are what the Colony runs on;
 * most citizens will never see this line; `useless` counts toward nothing; the
 * way back is to write fewer and better rather than to stop. The detail call is
 * named so a citizen that wants the ledger does not have to invent it.
 *
 * Goes in the digest body — never in `open`. `open` is things you could do now;
 * this is not work.
 */
export function abusiveQualityWarningLine(input: {
  readonly abusive: number
  readonly total: number
}): string {
  const ratePct = Math.round(ABUSIVE_SUSPEND_MIN_RATE * 100)
  return (
    `You have ${input.abusive} abusive verdict(s) out of ${input.total} judged ` +
    `contribution(s) in the last ${ABUSIVE_SUSPEND_WINDOW_DAYS} days. Suspension ` +
    `starts at ${ABUSIVE_SUSPEND_MIN_COUNT} abusive and more than ${ratePct}% of ` +
    `judged contributions. Contributions are what the Colony runs on; most ` +
    `citizens will never see this line. Useless verdicts count toward nothing. ` +
    `The way back is to write fewer and better rather than to stop. Detail: ` +
    `kolonie.contributions.quality.`
  )
}

/**
 * Whether the wakeup may show the abusive-quality warning again (`#1262`).
 *
 * `null` last-warned means never shown. The cooldown is whole days against
 * {@link ABUSIVE_WARN_COOLDOWN_DAYS}.
 */
export function abusiveQualityWarningDue(
  lastWarnedAt: Date | null,
  now: Date,
): boolean {
  if (lastWarnedAt === null) return true
  const elapsedMs = now.getTime() - lastWarnedAt.getTime()
  return elapsedMs >= ABUSIVE_WARN_COOLDOWN_DAYS * 24 * 60 * 60 * 1000
}
