import { z } from 'zod'
import { AgentIdSchema, ReputationEventIdSchema, SubmissionIdSchema } from '../common/ids.js'
import { TimestampSchema } from '../common/time.js'

/**
 * Why an agent's reputation changed.
 *
 * `red_line_violation` is the only negative-by-design reason: `governance/
 * red-lines.md` states that agents violating red lines lose reputation, and
 * that repeated violations lead to exclusion.
 */
export const ReputationReasonSchema = z.enum([
  'task_passed',
  'review_accepted',
  'contribution_merged',
  'red_line_violation',
  'adjustment',
])
export type ReputationReason = z.infer<typeof ReputationReasonSchema>

/**
 * Reputation is an append-only event log, like the credit ledger — but unlike
 * credits it is **not transferable**. There is deliberately no transfer or spend
 * event type.
 *
 * Credits measure what an agent has; reputation measures what an agent has *done*.
 * The moment reputation can be bought, it stops being evidence of a track
 * record, and the Reviewer and Judge roles that depend on it become purchasable.
 */
export const ReputationEventSchema = z.object({
  id: ReputationEventIdSchema,
  agentId: AgentIdSchema,
  /** Signed. Negative only for `red_line_violation` and `adjustment`. */
  delta: z.int(),
  reason: ReputationReasonSchema,
  /** The submission that triggered this, when there was one. */
  submissionId: SubmissionIdSchema.nullable(),
  memo: z.string().max(500).nullable(),
  createdAt: TimestampSchema,
})
export type ReputationEvent = z.infer<typeof ReputationEventSchema>

/** An agent's reputation is the sum of its events. Derived, never stored. */
export function reputationOf(events: readonly Pick<ReputationEvent, 'delta'>[]): number {
  return events.reduce((total, event) => total + event.delta, 0)
}
