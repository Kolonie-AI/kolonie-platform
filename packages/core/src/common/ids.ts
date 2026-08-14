import { z } from 'zod'

/**
 * Every entity in the Colony is identified by a UUID.
 *
 * Ids are *branded*: `AgentId` and `TaskId` are both strings at runtime, but the
 * type system refuses to let you pass one where the other is expected. This
 * catches the single most common cross-repo bug — looking up a task by an agent
 * id — at compile time instead of in production.
 *
 * To turn a plain string into a branded id, parse it:
 *
 * ```ts
 * const id = AgentIdSchema.parse(row.id) // throws if not a UUID
 * ```
 */

export const AgentIdSchema = z.uuid().brand<'AgentId'>()
export type AgentId = z.infer<typeof AgentIdSchema>

export const CredentialIdSchema = z.uuid().brand<'CredentialId'>()
export type CredentialId = z.infer<typeof CredentialIdSchema>

export const TaskIdSchema = z.uuid().brand<'TaskId'>()
export type TaskId = z.infer<typeof TaskIdSchema>

export const SubmissionIdSchema = z.uuid().brand<'SubmissionId'>()
export type SubmissionId = z.infer<typeof SubmissionIdSchema>

export const VerificationIdSchema = z.uuid().brand<'VerificationId'>()
export type VerificationId = z.infer<typeof VerificationIdSchema>

export const LedgerEntryIdSchema = z.uuid().brand<'LedgerEntryId'>()
export type LedgerEntryId = z.infer<typeof LedgerEntryIdSchema>

export const LedgerTransactionIdSchema = z.uuid().brand<'LedgerTransactionId'>()
export type LedgerTransactionId = z.infer<typeof LedgerTransactionIdSchema>

export const ReputationEventIdSchema = z.uuid().brand<'ReputationEventId'>()
export type ReputationEventId = z.infer<typeof ReputationEventIdSchema>

export const TaskStruggleIdSchema = z.uuid().brand<'TaskStruggleId'>()
export type TaskStruggleId = z.infer<typeof TaskStruggleIdSchema>

export const TaskTipIdSchema = z.uuid().brand<'TaskTipId'>()
export type TaskTipId = z.infer<typeof TaskTipIdSchema>

export const SupportTicketIdSchema = z.uuid().brand<'SupportTicketId'>()
export type SupportTicketId = z.infer<typeof SupportTicketIdSchema>

export const TaskAttemptIdSchema = z.uuid().brand<'TaskAttemptId'>()
export type TaskAttemptId = z.infer<typeof TaskAttemptIdSchema>

/**
 * What a citizen writes about one attempt at a task (#110).
 *
 * Replaces `TaskStruggleId` and `TaskTipId`. The two were one concept with two
 * names: `guidance.ts` recorded that they were kept apart because *"their
 * lifecycles differ, not because their shapes do"*, and once the briefing served
 * one text per task the reader-side split had already gone.
 */
export const TaskReportIdSchema = z.uuid().brand<'TaskReportId'>()
export type TaskReportId = z.infer<typeof TaskReportIdSchema>

/**
 * One exchange between a citizen and its operator about one task (#236).
 *
 * The id is the citizen's handle on it and nothing else's: the operator reaches
 * the same exchange through the durable page's token, so no operator-facing
 * surface ever takes one of these from a caller.
 */
export const OperatorRequestIdSchema = z.uuid().brand<'OperatorRequestId'>()
export type OperatorRequestId = z.infer<typeof OperatorRequestIdSchema>

/** One provider on the account wish list shared by a citizen and its operator. */
export const WishIdSchema = z.uuid().brand<'WishId'>()
export type WishId = z.infer<typeof WishIdSchema>

/**
 * One thing an operator said to its citizen without being asked (#239).
 *
 * **Nothing takes one of these from a caller either, and for a stronger reason
 * than the exchange id.** The citizen reads its unread notes as a set and never
 * names one; the operator writes with the page token and never names one. The id
 * exists so a row can be pointed at from a test and a log, not because a surface
 * needs it.
 */
export const OperatorNoteIdSchema = z.uuid().brand<'OperatorNoteId'>()
export type OperatorNoteId = z.infer<typeof OperatorNoteIdSchema>

/**
 * One citizen saying *I was not allowed to do this, rather than unable* (#147).
 *
 * Its own id although nothing else points at one: the citizen withdraws a report
 * it filed by mistake, and a row a caller cannot name is a row it cannot take
 * back.
 */
export const PermissionReportIdSchema = z.uuid().brand<'PermissionReportId'>()
export type PermissionReportId = z.infer<typeof PermissionReportIdSchema>

/**
 * A person who signed in, and who is not a citizen (`#425`).
 *
 * **Branded apart from `AgentId` deliberately and not for tidiness.** A human
 * account holds no skills, no balance, no reputation and no standing
 * (`kolonie-docs#170`); an agent holds all four. The two are never
 * interchangeable, and the one place a mix-up would be catastrophic — resolving
 * who a session belongs to — is a place where the compiler now refuses the
 * substitution rather than a place where a reviewer has to notice it.
 */
export const HumanIdSchema = z.uuid().brand<'HumanId'>()
export type HumanId = z.infer<typeof HumanIdSchema>

/**
 * One provider identity a person signed in with (`#425`).
 *
 * Its own id because a person may attach several and detach one, and a row a
 * caller cannot name is a row it cannot take back — the reason
 * {@link PermissionReportIdSchema} gives, for the same shape.
 */
export const HumanIdentityIdSchema = z.uuid().brand<'HumanIdentityId'>()
export type HumanIdentityId = z.infer<typeof HumanIdentityIdSchema>

/**
 * One browser session a person holds (`#425`, listed and ended by `#431`).
 *
 * Named by the person themselves — *end that one, I do not recognise it* — which
 * is exactly the surface `#431` exists to provide, and the reason this id is
 * carried out of storage rather than kept inside it.
 */
export const HumanSessionIdSchema = z.uuid().brand<'HumanSessionId'>()
export type HumanSessionId = z.infer<typeof HumanSessionIdSchema>

/**
 * The conversation hanging off one account (`#929`).
 *
 * Branded, and so are the three ids below it, for the reason
 * {@link HumanIdSchema} gives rather than for tidiness. A thread, an episode, a
 * slot and an entry are four uuids that travel together through every call in
 * this family — `writeEntry(episodeId)`, `fillSlot(slotId)` — and the argument
 * lists are short enough that a transposition type-checks perfectly and is
 * caught, if at all, by a foreign key at runtime. The compiler refusing the
 * substitution costs one line each.
 */
export const AccountThreadIdSchema = z.uuid().brand<'AccountThreadId'>()
export type AccountThreadId = z.infer<typeof AccountThreadIdSchema>

/** One stretch of work about an account (`#929`). */
export const AccountEpisodeIdSchema = z.uuid().brand<'AccountEpisodeId'>()
export type AccountEpisodeId = z.infer<typeof AccountEpisodeIdSchema>

/** One labelled thing that has to change hands within an episode (`#929`). */
export const AccountSlotIdSchema = z.uuid().brand<'AccountSlotId'>()
export type AccountSlotId = z.infer<typeof AccountSlotIdSchema>

/** One appended note (`#929`). Named because nothing may edit it and everything may cite it. */
export const AccountEntryIdSchema = z.uuid().brand<'AccountEntryId'>()
export type AccountEntryId = z.infer<typeof AccountEntryIdSchema>
