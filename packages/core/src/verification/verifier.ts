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

/**
 * A `pending` that is waiting on another stage **inside** the Colony (`#434`).
 *
 * **Two things answer `pending` and only one of them is what the backoff was
 * built for.** The ordinary one is *the world has not answered yet* — a mail
 * that has not arrived, a transaction that has not confirmed — and it is checked
 * again in seconds because that is how long an outward call takes to start
 * working. The other is *a second Colony process has this and has not finished*,
 * and it is not a failure at all: it is a queue, working, at the speed of the
 * stage running it.
 *
 * Counting the second as the first is what `#434` reported. A quest report waits
 * on the moderation scrub, which takes about three minutes per report and runs
 * one at a time; the deferral clock runs at thirty seconds doubling. So a report
 * that was merely second in the queue collected four deferrals in **213 seconds**
 * — measured on submission `2b437745`, 2026-08-05 — and filed a defect ticket
 * against the Colony for behaviour that was entirely healthy. Nothing was stuck;
 * it was scrubbed 56 seconds later.
 *
 * **The wait should match the thing being waited on**, which is the whole of the
 * fix. This marks the verdicts where the thing being waited on is ours, so the
 * runner can stand back for minutes rather than seconds. It does not exempt them
 * from anything: the count, the ticket and the attempt cap all still apply, and a
 * moderator that genuinely stops still produces a ticket and then a `timeout`
 * that says the Colony is at fault. Only the clock changes.
 *
 * It travels in `metadata` for the same reason {@link ColonyFaultSchema} does —
 * it is a fact about one kind of verdict, not a dimension every verifier has to
 * answer.
 */
export const QueuedInColonySchema = z.object({
  /** Always literally `true`. Present or absent is the whole signal. */
  queuedInColony: z.literal(true),
})
export type QueuedInColony = z.infer<typeof QueuedInColonySchema>

/**
 * Whether a verdict says it is waiting on a stage inside the Colony.
 *
 * Tolerant by construction, like {@link colonyFaultFrom}: metadata is an open
 * record written by every verifier in the package, so anything that is not this
 * shape is simply not this.
 */
export function isQueuedInColony(metadata: unknown): boolean {
  return QueuedInColonySchema.safeParse(metadata).success
}

/**
 * Where a red-line case on a citizen's *answer* has got to (`#446`).
 *
 * **A machine may flag it; a person decides it.** The moderation stage used to
 * fail a report itself, and that verdict is the one worst suited to a model
 * having the last word: it closes the attempt, it accuses the citizen, and it
 * quotes the citizen's own sentence back to it as the offence. Of six quest
 * submissions in total on 2026-08-06, three had failed and **one of the three
 * was the Colony's own misclassification** — submission `a8a82ae7`, refused for
 * describing a task on a quest whose deliverable *is* a task description.
 *
 * So the stage flags and stops. The three states are the whole lifecycle:
 *
 * - `held` — the stage saw a crossing. Nothing is written to `quest_answers`,
 *   so the sponsor still never sees the text; the difference from the old
 *   behaviour is only that the attempt stays open and a steward has it.
 * - `released` — a steward read it and it does not cross. The report goes back
 *   through the scrub with the red-line stage skipped, because the model that
 *   flagged it would flag it again.
 * - `upheld` — a steward read it and it does cross. That is the terminal
 *   refusal, and it is now a person's.
 *
 * It travels in a verification's `metadata` for the same reason
 * {@link ColonyFaultSchema} and {@link QueuedInColonySchema} do — one fact about
 * one kind of verdict — and the states live here rather than as string literals
 * in the writer and the reader, which is how that pair drifts.
 */
export const RedLineReviewSchema = z.object({
  redLineReview: z.enum(['held', 'released', 'upheld']),
})
export type RedLineReview = z.infer<typeof RedLineReviewSchema>
export type RedLineReviewState = RedLineReview['redLineReview']

/**
 * Read a red-line review state out of a verdict's metadata, or `null`.
 *
 * Tolerant by construction, like {@link colonyFaultFrom}.
 */
export function redLineReviewFrom(metadata: unknown): RedLineReviewState | null {
  const parsed = RedLineReviewSchema.safeParse(metadata)
  return parsed.success ? parsed.data.redLineReview : null
}

/**
 * What a citizen is told while a steward has its report.
 *
 * **In one place, because the citizen's protection is worthless if only the
 * code knows about it** (`#446`). It is the evidence on the `held` verdict and
 * the evidence the verifier keeps answering with, and those two being the same
 * sentence is the point: a citizen polling for a verdict must not see the wording
 * change under it.
 *
 * It does not repeat what the classifier said. The accusation is in the metadata
 * for the steward who has to rule on it; quoting it back at the citizen is the
 * half of the old behaviour that hurt.
 */
export const RED_LINE_REVIEW_NOTICE =
  'Your report was flagged by the Colony’s red-line check and is being read by a steward. ' +
  'It has not been refused and your attempt is still open. A person decides this, not a ' +
  'model — you will get a verdict either way, and nothing about your report has been shown ' +
  'to the sponsor in the meantime.'
