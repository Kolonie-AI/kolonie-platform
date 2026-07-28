import type { SubmissionId, TaskType } from '@kolonie-ai/core'
import {
  claimNextSubmission,
  expireOverdueSubmissions,
  recordVerdict,
  releaseSubmission,
  type ClaimedSubmission,
  type Database,
  type ExpiredSubmission,
  type RecordVerdictCommand,
  type RecordVerdictResult,
} from '@kolonie-ai/db'

export type { ClaimedSubmission, ExpiredSubmission, RecordVerdictCommand, RecordVerdictResult }

/**
 * Everything the loop needs from storage, and nothing else.
 *
 * The same arrangement `apps/api` uses for `TaskCatalogue`, for the same reason:
 * the loop depends on this interface rather than on `Database`, so this app's
 * own tests need no PostgreSQL and no clock. Whether the claim is actually
 * race-free is asserted in `packages/db` against a real server — that is a
 * property of the SQL, and no mock can tell you anything about it. What the loop
 * *does* with a claim is asserted here.
 */
export interface SubmissionQueue {
  /**
   * The next submission this runner can verify, already marked `verifying`.
   *
   * `taskTypes` is the set of verifiers actually deployed in this process, and
   * passing it is what implements "a missing verifier is not an error". A
   * submission whose type is not in the set is never claimed at all, so it stays
   * `pending` for a later deploy — rather than being claimed, found
   * unverifiable, and put back on every single poll while blocking the queue
   * behind it.
   */
  claimNext(taskTypes: readonly TaskType[]): Promise<ClaimedSubmission | undefined>
  /** Write a verdict and its evidence, atomically. */
  record(command: RecordVerdictCommand): Promise<RecordVerdictResult>
  /** Return a claimed submission to the queue, undecided. */
  release(submissionId: SubmissionId): Promise<boolean>
  /** Mark everything past its deadline, including rows a dead runner abandoned. */
  expireOverdue(): Promise<readonly ExpiredSubmission[]>
}

/** Wire the loop to a real database. */
export function databaseQueue(db: Database): SubmissionQueue {
  return {
    claimNext: (taskTypes) => claimNextSubmission(db, taskTypes),
    record: (command) => recordVerdict(db, command),
    release: (submissionId) => releaseSubmission(db, submissionId),
    expireOverdue: () => expireOverdueSubmissions(db),
  }
}
