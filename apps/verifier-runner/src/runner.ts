import {
  canTransition,
  submissionStatusFor,
  type Submission,
  type TaskType,
} from '@kolonie-ai/core'
import { verifierFor } from '@kolonie-ai/verifiers'

/**
 * What the runner decided about one submission.
 *
 * `skipped` is not a failure — it means the submission stays as it is and will
 * be picked up again later.
 */
export type Verdict =
  | { readonly outcome: 'verified'; readonly submission: Submission; readonly evidence: string }
  | { readonly outcome: 'skipped'; readonly reason: string }

/**
 * Verify a single submission.
 *
 * Deliberately pure: it takes a submission and the type of the task it belongs
 * to, returns what should be written, and touches neither the database nor the
 * clock. This is the code path that pays out coins, so it has to be testable
 * without a running Postgres — the storage loop around it is the easy half.
 *
 * `taskType` is passed in rather than read off the submission because a
 * submission only carries its `taskId`; the runner joins the task when it picks
 * the row up.
 */
export async function verifySubmission(
  submission: Submission,
  taskType: TaskType,
): Promise<Verdict> {
  if (submission.status !== 'verifying') {
    return {
      outcome: 'skipped',
      reason: `Submission is '${submission.status}'; only 'verifying' submissions are picked up.`,
    }
  }

  const verifier = verifierFor(taskType)

  if (!verifier) {
    // Not an error. A verifier may be deployed after its task type exists, and a
    // correct submission must not fail just because the runner was late.
    return {
      outcome: 'skipped',
      reason: `No verifier deployed for task type '${taskType}'.`,
    }
  }

  const result = await verifier.verify(submission)
  const next = submissionStatusFor(result.status)

  if (!canTransition(submission.status, next)) {
    return {
      outcome: 'skipped',
      reason: `Verifier returned '${result.status}', an illegal transition from '${submission.status}'.`,
    }
  }

  return {
    outcome: 'verified',
    evidence: result.evidence,
    submission: { ...submission, status: next },
  }
}
