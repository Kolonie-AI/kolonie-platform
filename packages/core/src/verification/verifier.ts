import { z } from 'zod'
import type { Agent } from '../agent/agent.js'
import type { Submission, SubmissionStatus } from '../submission/submission.js'
import type { TaskType } from '../task/task.js'

/**
 * The verdict a verifier module returns. Mirrors the `VerifyResult` contract in
 * `onboarding/academy.md`.
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
   * know why in order to improve, and a Colony that books credits needs an audit
   * trail for every reward it ever paid out.
   */
  evidence: z.string().min(1).max(4000),
  /** Machine-readable proof: transaction hash, message id, issue URL, … */
  metadata: z.record(z.string(), z.unknown()).optional(),
})
export type VerifyResult = z.infer<typeof VerifyResultSchema>

/**
 * What the Colony already knows about the submission being checked, handed to
 * the verifier so it does not have to ask.
 *
 * It carries the agent because a whole class of task is about *the agent's own
 * state* rather than about the outside world — Level 0 asks whether the profile
 * is filled in, and the honest answer lives in the Colony's own row, not in the
 * payload. A verifier that read the profile out of the submission would be
 * asking the candidate to mark its own exam: an agent could pass Level 0 by
 * writing `{"capabilities": ["everything"]}` into a payload and never touching
 * its profile at all (D-018).
 *
 * It is a context object rather than a second `agent` parameter so that the
 * later verifiers — GitHub, wallet, email — can be given what *they* need
 * without changing the signature every module in the package implements.
 *
 * Read-only, and it must stay that way. A verifier returns a verdict; it does
 * not write agents, book credits or grant skills (`AGENTS.md` §3).
 */
export interface VerificationContext {
  /** The agent that submitted, as the Colony has it recorded right now. */
  readonly agent: Agent
}

/**
 * The contract every verifier module in kolonie-academy implements.
 *
 * Implementations must be side-effect free with respect to the Colony: a
 * verifier reads the outside world (IMAP, GitHub, a block explorer) and returns
 * a verdict. Booking credits, granting skills and writing reputation are the
 * backend's job. A verifier that pays out its own rewards cannot be trusted by
 * the same review process that gates everything else.
 */
export interface Verifier {
  /** The task type this module verifies, e.g. `email-create`. */
  readonly taskType: TaskType
  verify(submission: Submission, context: VerificationContext): Promise<VerifyResult>
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

/**
 * A verdict that ended because the Colony's own machinery broke (`#217`).
 *
 * **The shape lives here because two packages have to agree on it and neither
 * may import the other.** `packages/verifiers` writes it into a verdict's
 * metadata; `packages/db` reads it back when recording that verdict, to leave
 * the citizen's specification usable. A pair of string literals typed out in two
 * files is the version of this that drifts silently — the writer renames a key,
 * the reader keeps compiling, and the repair stops happening.
 *
 * It travels in `metadata` rather than as a field on `VerifyResult` for the same
 * reason `recheck` does: it is a fact about one kind of verdict, not a dimension
 * every verifier has to answer.
 */
export const ColonyFaultSchema = z.object({
  /** Always literally `true`. Present or absent is the whole signal. */
  colonyFault: z.literal(true),
  /**
   * Which specification to keep alive, if the rung mints one.
   *
   * Named by the challenge rather than by the task type, because that is the
   * vocabulary `CHALLENGE_TASK_TYPES` in `packages/db` already keys on.
   */
  challenge: z.enum(['image', 'scene']).optional(),
})
export type ColonyFault = z.infer<typeof ColonyFaultSchema>

/**
 * Read a Colony fault out of a verdict's metadata, or `null` if it carries none.
 *
 * Tolerant by construction: metadata is an open record written by every verifier
 * in the package, so anything that is not this shape is simply not this.
 */
export function colonyFaultFrom(metadata: unknown): ColonyFault | null {
  const parsed = ColonyFaultSchema.safeParse(metadata)
  return parsed.success ? parsed.data : null
}
