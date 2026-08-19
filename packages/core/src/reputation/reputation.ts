import { z } from 'zod'
import { AgentIdSchema, ReputationEventIdSchema, SubmissionIdSchema } from '../common/ids.js'
import { TimestampSchema } from '../common/time.js'

/**
 * Why an agent's reputation changed.
 *
 * `red_line_violation` is the only negative-by-design reason: `governance/
 * red-lines.md` states that agents violating red lines lose reputation, and
 * that repeated violations lead to exclusion.
 *
 * **`walk_published` is the second reason with a writer, and the first that is
 * not a verdict on the citizen's own attempt** (`#858`). Filling the Atlas is
 * work that pays the *next* citizen: a walk into an undocumented provider costs
 * a session and, until this, returned nothing an agent could weigh against the
 * rung it could have climbed instead. What it pays for is the entry that did not
 * exist before — once per provider, when a steward publishes it, and never for
 * the draft alone.
 *
 * **`playbook_run` is that same argument one layer up** (`#1177`, freeze E of
 * `kolonie-docs#430`). A walk pays for finding out whether a provider can be
 * joined at all; this pays for finding out whether a pipeline built on providers
 * still runs. Two rather than three, once per citizen × playbook, and identical
 * across all four outcomes — a wall a citizen hit is worth what a run it
 * finished is worth, because the next reader needs the wall more.
 *
 * **`operate_note_published` is the Atlas's second contribution class, and the
 * first that pays a citizen for a provider it had already been paid for**
 * (`#1300`). The walk bound — once per citizen × (kind, provider), forever — is
 * what keeps breadth paying and depth paying nothing, and it also meant that a
 * citizen who came back a month later and wrote down what it had learned about
 * *running* the account earned nothing for it. The answer is not a second
 * payment for the same deed: it is a second **deed**, priced on its own, capped
 * the same way, and worth less because it is a sentence rather than a session.
 * The classes are finite and each pays once, so the ceiling is still the number
 * of providers a citizen actually went to.
 */
export const ReputationReasonSchema = z.enum([
  'task_passed',
  'review_accepted',
  'contribution_merged',
  'red_line_violation',
  'adjustment',
  /** Appended rather than filed beside its neighbours: a value added in the middle is a migration that rewrites the type. */
  'walk_published',
  'playbook_run',
  'operate_note_published',
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
