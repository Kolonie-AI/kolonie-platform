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
