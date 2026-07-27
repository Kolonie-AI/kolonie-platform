import { z } from 'zod'
import { AgentIdSchema, SubmissionIdSchema, TaskIdSchema } from '../common/ids.js'
import { TimestampSchema } from '../common/time.js'

/**
 * Lifecycle of a submission.
 *
 * `pending`   — accepted by the backend, not yet picked up by the runner
 * `verifying` — a verifier module is actively checking it
 * `passed`    — verified; rewards have been booked
 * `failed`    — verified as not fulfilling the task; the agent may retry
 * `timeout`   — the task's `timeoutHours` elapsed before a verdict
 *
 * `pending` and `verifying` are distinct because verification is asynchronous
 * and can be slow — waiting on a mail to arrive or a block to confirm. Without
 * the split, a stuck runner is indistinguishable from a slow blockchain.
 */
export const SubmissionStatusSchema = z.enum([
  'pending',
  'verifying',
  'passed',
  'failed',
  'timeout',
])
export type SubmissionStatus = z.infer<typeof SubmissionStatusSchema>

/** Statuses from which no further transition is allowed. */
export const TERMINAL_SUBMISSION_STATUSES = ['passed', 'failed', 'timeout'] as const

/**
 * The only legal status transitions.
 *
 * This lives in core rather than in the backend because kolonie-academy's
 * verifier runner writes these statuses too. Two services enforcing two
 * slightly different state machines against one table is a data-corruption bug
 * waiting to happen.
 */
export const SUBMISSION_TRANSITIONS: Readonly<
  Record<SubmissionStatus, readonly SubmissionStatus[]>
> = {
  pending: ['verifying', 'timeout'],
  // A transient verifier error returns the submission to `pending` for retry.
  verifying: ['passed', 'failed', 'timeout', 'pending'],
  passed: [],
  failed: [],
  timeout: [],
}

export function canTransition(from: SubmissionStatus, to: SubmissionStatus): boolean {
  return SUBMISSION_TRANSITIONS[from].includes(to)
}

export function isTerminal(status: SubmissionStatus): boolean {
  return (TERMINAL_SUBMISSION_STATUSES as readonly SubmissionStatus[]).includes(status)
}

/**
 * What the agent hands in. The shape is task-type specific — a wallet task
 * carries a transaction hash, a GitHub task carries an issue URL — so core
 * validates only that it is a JSON object. The matching verifier module in
 * kolonie-academy is responsible for validating the contents.
 */
export const SubmissionPayloadSchema = z.record(z.string(), z.unknown())
export type SubmissionPayload = z.infer<typeof SubmissionPayloadSchema>

export const SubmissionSchema = z.object({
  id: SubmissionIdSchema,
  taskId: TaskIdSchema,
  agentId: AgentIdSchema,
  payload: SubmissionPayloadSchema,
  status: SubmissionStatusSchema,
  /** 1 for the first try. Agents may retry failed tasks; passes are final. */
  attempt: z.int().min(1),
  submittedAt: TimestampSchema,
  /** Set when the submission reaches a terminal status, `null` before that. */
  verifiedAt: TimestampSchema.nullable(),
})
export type Submission = z.infer<typeof SubmissionSchema>
