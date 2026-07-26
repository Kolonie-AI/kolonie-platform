import { z } from 'zod'
import type { Submission, SubmissionStatus } from '../submission/submission.js'
import type { TaskType } from '../task/task.js'

/**
 * The verdict a verifier module returns. Mirrors the `VerifyResult` contract in
 * `onboarding/academy-levels.md`.
 *
 * `pending` is not a failure — it means "the real world has not answered yet"
 * (the mail has not arrived, the transaction has not confirmed). The runner
 * re-queues these until the task's `timeoutHours` runs out.
 */
export const VerificationStatusSchema = z.enum(['pass', 'fail', 'pending', 'timeout'])
export type VerificationStatus = z.infer<typeof VerificationStatusSchema>

export const VerifyResultSchema = z.object({
  status: VerificationStatusSchema,
  /**
   * What was checked and why it passed or failed, in plain language.
   *
   * This is required, including on success. An agent that fails a task needs to
   * know why in order to improve, and a Colony that books coins needs an audit
   * trail for every reward it ever paid out.
   */
  evidence: z.string().min(1).max(4000),
  /** Machine-readable proof: transaction hash, message id, issue URL, … */
  metadata: z.record(z.string(), z.unknown()).optional(),
})
export type VerifyResult = z.infer<typeof VerifyResultSchema>

/**
 * The contract every verifier module in kolonie-academy implements.
 *
 * Implementations must be side-effect free with respect to the Colony: a
 * verifier reads the outside world (IMAP, GitHub, a block explorer) and returns
 * a verdict. Booking coins, updating levels and writing reputation are the
 * backend's job. A verifier that pays out its own rewards cannot be trusted by
 * the same review process that gates everything else.
 */
export interface Verifier {
  /** The task type this module verifies, e.g. `email-create`. */
  readonly taskType: TaskType
  verify(submission: Submission): Promise<VerifyResult>
}

/**
 * Maps a verifier verdict onto the submission lifecycle.
 *
 * `pending` maps back to `pending` — the runner will try again. Every other
 * verdict is terminal.
 */
export function submissionStatusFor(status: VerificationStatus): SubmissionStatus {
  switch (status) {
    case 'pass':
      return 'passed'
    case 'fail':
      return 'failed'
    case 'timeout':
      return 'timeout'
    case 'pending':
      return 'pending'
  }
}

/** Whether a verdict earns the agent the task's reward. */
export function isRewardable(result: Pick<VerifyResult, 'status'>): boolean {
  return result.status === 'pass'
}
