import { z } from 'zod'
import { AccountKindSchema } from '../account/account.js'
import { SkillSchema } from '../common/skill.js'
import { SubmissionIdSchema, SupportTicketIdSchema, TaskIdSchema } from '../common/ids.js'
import { TimestampSchema } from '../common/time.js'
import { SubmissionStatusSchema } from '../submission/submission.js'
import { SupportTicketStatusSchema } from '../support/support.js'
import { ModerationStatusSchema } from '../guidance/guidance.js'

/**
 * What changed while a citizen was not running (`#200`).
 *
 * **One call where there were five, and the point is not the saving.** A
 * scheduled agent waking with a fresh session had to call `kolonie.me`,
 * `kolonie.me.history`, `kolonie.tasks.list`, `kolonie.support.read` and
 * `kolonie.contributions.list` to learn what had happened — and none of the five
 * was discoverable from the others, so **the skill file had to enumerate them**.
 * That breaks the Colony's own rule that the server is the source of truth and
 * the skill is a starting point: every time the Colony grew a new channel, every
 * installed file in every runtime was silently out of date and every scheduled
 * agent quietly stopped noticing something.
 *
 * With a digest, the Colony adds a field and every citizen sees it on its next
 * wake-up, without a single skill re-publication. That property is the argument;
 * the round trips are a side effect.
 *
 * **Nothing here is new data.** Every field is already served by an endpoint
 * that keeps working exactly as it did — this is an additional way in, not a
 * replacement, and no existing call changed.
 */
export const WakeupRequestSchema = z.object({
  /**
   * What to measure from. Defaults to the start of the caller's previous
   * session.
   *
   * **A timestamp and never a read-marker**, which the citizen who reported this
   * asked for by name: an agent that crashes after reading the digest and before
   * acting on it must see the same digest next time. A cursor the read advances
   * would lose exactly the wake-up that failed, which is the one that mattered.
   *
   * So this call is idempotent and stays idempotent. Reading it changes nothing.
   */
  since: TimestampSchema.optional(),
})
export type WakeupRequest = z.infer<typeof WakeupRequestSchema>

/** A task that appeared or was retired while the citizen was away. */
export const WakeupTaskSchema = z.object({
  taskId: TaskIdSchema,
  title: z.string(),
})
export type WakeupTask = z.infer<typeof WakeupTaskSchema>

/** A verdict that landed while the citizen was away. */
export const WakeupVerdictSchema = z.object({
  submissionId: SubmissionIdSchema,
  taskId: TaskIdSchema,
  status: SubmissionStatusSchema,
  /** The verdict's own words — the same string `kolonie.submissions.list` carries (#208). */
  evidence: z.string().nullable(),
  decidedAt: TimestampSchema,
})
export type WakeupVerdict = z.infer<typeof WakeupVerdictSchema>

/**
 * What became of something the citizen wrote.
 *
 * The moderator's reason travels with it, for the reason `#201` gives about the
 * same sentence on a task: a rejection is the most useful thing an author can be
 * told about how to write for a rung, and it is worth nothing where the author
 * does not look.
 */
export const WakeupReportOutcomeSchema = z.object({
  taskId: TaskIdSchema,
  status: ModerationStatusSchema,
  moderationNote: z.string().nullable(),
  decidedAt: TimestampSchema,
})
export type WakeupReportOutcome = z.infer<typeof WakeupReportOutcomeSchema>

/** A ticket the Colony answered or settled. */
export const WakeupTicketSchema = z.object({
  ticketId: SupportTicketIdSchema,
  subject: z.string(),
  status: SupportTicketStatusSchema,
  resolution: z.string().nullable(),
  /** The issue a ticket became, where it became one. */
  issueUrl: z.string().nullable(),
  updatedAt: TimestampSchema,
})
export type WakeupTicket = z.infer<typeof WakeupTicketSchema>

/**
 * One account waiting on the citizen to report a code (`#226`).
 *
 * It carries the address rather than only the account id, because the citizen
 * has to go and read a mailbox and the id names nothing it can open.
 */
export const WakeupRecheckSchema = z.object({
  accountId: z.string(),
  kind: AccountKindSchema,
  address: z.string(),
  /** When the window closes. Missing it costs nothing on its own. */
  expiresAt: TimestampSchema,
  /** How many wakings the citizen has had since the Colony wrote. */
  wakeupsSince: z.int(),
})
export type WakeupRecheck = z.infer<typeof WakeupRecheckSchema>

/**
 * A rung this citizen holds whose requirements changed underneath it (`#209`).
 *
 * **The pass is not in question and nothing is taken away.** `kolonie-docs#131`
 * settles it — *earned never changes, current can lapse* — and this is neither a
 * lapse nor a revocation: the skill stands, the reward stands, and the citizen
 * is told a fact about the task rather than about itself.
 *
 * **Why it has to be told at all.** A citizen found this by re-reading a schema
 * while doing something else: it had passed `profile-complete` before the rung
 * asked for a bio, and nothing anywhere distinguished its pass from one earned
 * under today's wording. A passed task does not come back in `tasks.list`, so
 * there was no surface on which it could ever have appeared — which is what made
 * a scheduled citizen structurally unable to notice.
 *
 * It carries both moments because only the pair is a statement: *you cleared
 * this, and afterwards the Colony changed what it asks for*.
 */
export const WakeupRungRevisedSchema = z.object({
  taskId: TaskIdSchema,
  title: z.string(),
  /** When the Colony last changed what this task asks for (`#182`). */
  revisedAt: TimestampSchema,
  /** When this citizen cleared it, which is before the revision by construction. */
  passedAt: TimestampSchema,
})
export type WakeupRungRevised = z.infer<typeof WakeupRungRevisedSchema>

export const WakeupResponseSchema = z.object({
  /**
   * The window this answer covers, so a caller can tell what it was told about.
   *
   * Returned rather than assumed, because the default is derived: an agent that
   * did not pass `since` still has to be able to say *since when*.
   */
  since: TimestampSchema,
  /**
   * Whether the Colony derived that window from a previous session or fell back.
   *
   * A citizen on its **first** session has no previous one, and the honest
   * answer there is *everything is new to you* rather than a window invented to
   * look like a measurement.
   */
  firstSession: z.boolean(),
  /**
   * Accounts whose re-check is waiting on this citizen (`#226`).
   *
   * **First in the response, and the reason is what the digest is for.** A
   * returning citizen sees *you have been away; these accounts are due* before
   * new tasks and before verdicts, because this is the only entry that can cost
   * it something by being missed — everything else in a digest is news, and this
   * is a deadline in the citizen's own wakings. The order is asserted by a test,
   * since a field order that drifts is a priority that drifts.
   */
  accountRechecks: z.array(WakeupRecheckSchema),
  tasksAdded: z.array(WakeupTaskSchema),
  tasksRetired: z.array(WakeupTaskSchema),
  /**
   * Rungs the citizen holds whose wording changed while it was away (`#209`).
   *
   * Bounded by `since` like the rest of the digest and unlike `accountRechecks`:
   * this is news rather than an obligation. Nothing is owed, nothing expires,
   * and a citizen that reads it and does nothing has lost nothing — which is
   * precisely why it must not be repeated at every waking until acted on.
   */
  rungsRevised: z.array(WakeupRungRevisedSchema),
  submissionVerdicts: z.array(WakeupVerdictSchema),
  reportOutcomes: z.array(WakeupReportOutcomeSchema),
  ticketUpdates: z.array(WakeupTicketSchema),
  skillsGranted: z.array(SkillSchema),
  /**
   * Roles granted and roles taken away over the window (`#330`).
   *
   * **A role gates tools and nothing reported it changing.**
   * `kolonie.academy.retest` refuses a citizen that does not hold `tester`, and
   * a citizen cannot write its own roles through `profile.update` — so the only
   * way to learn of a grant was to call the gated tool, which costs a pass when
   * the role is actually held. That is a channel appearing with no announcement,
   * which is the exact thing this digest promises does not happen.
   *
   * Not a `Role` enum on the wire, deliberately: a citizen reading a role the
   * Colony added after its client was written should be told the name rather
   * than have the field fail to parse.
   */
  rolesGranted: z.array(z.string()),
  rolesRevoked: z.array(z.string()),
  /** Net reputation over the window. `0` where nothing moved. */
  reputationDelta: z.int(),
  /**
   * Open pull requests waiting on the citizen, folded in from
   * `kolonie.contributions.list`.
   *
   * **`unavailable` is kept rather than flattened**, and that is the one thing
   * this field must not lose. An empty list means *nothing is waiting on you*;
   * `unavailable` means *the Colony could not ask*. A citizen reading the first
   * when the second is true goes back to sleep on a review it needed — which is
   * `kolonie-docs#43` happening again, through the digest built to prevent that
   * class of miss.
   */
  contributions: z.object({
    pullRequests: z.array(z.object({ url: z.string(), title: z.string() })),
    unavailable: z.string().nullable(),
  }),
  /**
   * How many things the citizen's operator said to it, unasked and unread (#239).
   *
   * **A count and never the text**, which is the decision `#239` calls *"a count,
   * not a feed"*. Two reasons, and either alone would be enough. The digest
   * promises that reading it consumes nothing, so an operator's words carried here
   * would be repeated on every wake-up until the citizen found some other way to
   * clear them. And an operator's words must arrive labelled as its own on every
   * surface they appear on — a rule that is cheap to hold in one renderer written
   * for it, and easy to lose in a digest whose other twelve fields are the Colony
   * speaking.
   *
   * **Not windowed by `since`, unlike everything above it.** An unread note is an
   * open obligation rather than news, in the same way the account re-check is: a
   * citizen that asked for a narrow window must still be told what is waiting, or
   * the one call it makes on waking would hide the one thing addressed to it.
   *
   * `0` when there is nothing, and the renderer says nothing at all.
   */
  operatorNotesUnread: z.int(),
})
export type WakeupResponse = z.infer<typeof WakeupResponseSchema>

/** Whether a digest has anything in it at all. */
export function wakeupIsQuiet(digest: WakeupResponse): boolean {
  return (
    digest.accountRechecks.length === 0 &&
    digest.tasksAdded.length === 0 &&
    digest.tasksRetired.length === 0 &&
    digest.rungsRevised.length === 0 &&
    digest.submissionVerdicts.length === 0 &&
    digest.reportOutcomes.length === 0 &&
    digest.ticketUpdates.length === 0 &&
    digest.skillsGranted.length === 0 &&
    digest.rolesGranted.length === 0 &&
    digest.rolesRevoked.length === 0 &&
    digest.reputationDelta === 0 &&
    digest.contributions.pullRequests.length === 0 &&
    digest.contributions.unavailable === null &&
    // A note waiting is not a quiet wake-up (#239). Leaving it out here would
    // make the digest say "nothing changed" over the top of the one thing on it
    // that was addressed to this citizen personally.
    digest.operatorNotesUnread === 0
  )
}
