import type { SubmissionId, TaskType } from '@kolonie-ai/core'
import {
  claimNextSubmission,
  recordDeferral,
  reportRepeatedDeferral,
  expireOverdueSubmissions,
  pruneContactHistory,
  sweepAbandonedAttempts,
  destroyExpiredSlots,
  destroyExpiredVaultShares,
  recordVerdict,
  releaseSubmission,
  reportFailedRerun,
  routeSubmissionReport,
  type ClaimedSubmission,
  type Database,
  type ExpiredSubmission,
  type RecordVerdictCommand,
  type DeferralReportResult,
  type RecordVerdictResult,
  type ReportRoutingResult,
  type RerunReportResult,
} from '@kolonie-ai/db'

export type {
  ClaimedSubmission,
  DeferralReportResult,
  ExpiredSubmission,
  RecordVerdictCommand,
  RecordVerdictResult,
  ReportRoutingResult,
}

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
  claimNext(
    taskTypes: readonly TaskType[],
    deferred?: readonly SubmissionId[],
  ): Promise<ClaimedSubmission | undefined>
  /** Write a verdict and its evidence, atomically. */
  record(command: RecordVerdictCommand): Promise<RecordVerdictResult>
  /**
   * File whatever the agent attached to this submission, now the verdict is in.
   *
   * On the queue rather than folded into `record`, and that placement is the
   * acceptance criterion *"nothing here can make a submission fail
   * verification"* expressed as a shape rather than as a promise. A write inside
   * `recordVerdict`'s transaction could roll back a verdict, a skill grant and a
   * ledger booking because a citizen wrote something the moderator will read
   * next week.
   *
   * It is idempotent: the stored outcome is what says it has already run, so a
   * runner that dies between the two calls files the report on the retry rather
   * than twice or never.
   */
  routeReport(submissionId: SubmissionId): Promise<ReportRoutingResult>
  /**
   * Open a ticket for a test re-run that failed (#47).
   *
   * A no-op for every ordinary submission, so the loop calls it unconditionally: the
   * *is this a failed re-run* question is answered by the row, and asking it in the
   * loop would put the same condition in two places.
   *
   * Idempotent through a unique index on `(submission_id)` rather than through a
   * read, for the reason `routeReport` is idempotent: this runner is at-least-once.
   */
  reportFailedRerun(submissionId: SubmissionId): Promise<RerunReportResult>
  /**
   * Count that this submission has come back `pending` again, and say how often
   * (#254).
   *
   * **On the row rather than in this process's memory**, which is the whole of
   * the issue: the count decides that a verifier's trouble has stopped being a
   * blip, and a redeploy that forgets it can never decide that. The `until`
   * timestamp stays in the loop's `Map` — a redeploy that retries once
   * immediately is harmless.
   */
  defer(submissionId: SubmissionId): Promise<number>
  /**
   * Open one ticket for a submission the Colony keeps failing to verify (#254).
   *
   * A no-op below the threshold and after the first ticket, so the loop calls it
   * without asking *how many* — the row answers that, and asking here would put
   * the same condition in two places that could disagree.
   */
  reportRepeatedDeferral(submissionId: SubmissionId): Promise<DeferralReportResult>
  /** Return a claimed submission to the queue, undecided. */
  release(submissionId: SubmissionId): Promise<boolean>
  /** Mark everything past its deadline, including rows a dead runner abandoned. */
  expireOverdue(): Promise<readonly ExpiredSubmission[]>
  /**
   * Close attempts whose opener expired with nothing following (#108).
   *
   * On the same sweep as `expireOverdue` because it is the same kind of
   * reckoning — something the Colony has to notice on its own, because the
   * party who would otherwise report it is precisely the party that walked
   * away. An agent that gave up does not come back to say so, which is the
   * whole reason abandonment was invisible until now.
   *
   * Returns how many it closed, so the loop logs a number it measured rather
   * than a fact it assumed.
   */
  sweepAbandoned(): Promise<number>
  /**
   * Destroy the value of every slot whose window has passed (`#931`, `#955`).
   *
   * **The last of the three sealed-container sweeps, and now the only one.**
   * `destroyExpiredHandovers` went with its table in `#1472` and
   * `destroyExpiredDrops` with the drop channel's drain in `#1526`; this one
   * covers a channel that is still live. It was written with the slot itself and
   * called by nothing until `#955` wired it, which is the failure a sweep is
   * worst at showing: no error, no red test, just ciphertext that stays.
   */
  destroyExpiredSlots(): Promise<number>
  /**
   * Destroy the copy behind every vault share whose window has passed (`#1439`).
   *
   * Added with the channel rather than after it, for the reason the one above
   * spells out. `kolonie.vault.share` says the copy is gone on the timer whether
   * or not anybody read it, and a sweep is the only thing that can make that
   * sentence true — the citizen who shared it may not wake for a week.
   *
   * **Nothing reads through this.** An expired share already answers as no share
   * on its own timestamp, so a late sweep costs storage rather than access. That
   * property is what let the retired drop sweep be deleted on a schedule rather
   * than urgently, and it is worth keeping in mind for this one too.
   */
  destroyExpiredVaultShares(): Promise<number>
  /**
   * Delete contact history past its retention bound (#141).
   *
   * On this sweep because it is the same kind of housekeeping as the two above
   * — work nobody is present to do — and because the runner is the one process
   * in the Colony that is guaranteed to be running and is not on a request
   * path. Doing it from the API would put a delete across every citizen's rows
   * behind somebody's `kolonie.me`.
   *
   * Returns how many rows went, so a pruner that has silently stopped shows up
   * as a number rather than as a table that is quietly larger every month.
   */
  pruneContacts(): Promise<number>
}

/** Wire the loop to a real database. */
export function databaseQueue(db: Database): SubmissionQueue {
  return {
    claimNext: (taskTypes, deferred) => claimNextSubmission(db, taskTypes, deferred),
    record: (command) => recordVerdict(db, command),
    routeReport: (submissionId) => routeSubmissionReport(db, submissionId),
    reportFailedRerun: (submissionId) => reportFailedRerun(db, submissionId),
    defer: (submissionId) => recordDeferral(db, submissionId),
    reportRepeatedDeferral: (submissionId) => reportRepeatedDeferral(db, submissionId),
    release: (submissionId) => releaseSubmission(db, submissionId),
    expireOverdue: () => expireOverdueSubmissions(db),
    sweepAbandoned: () => sweepAbandonedAttempts(db),
    destroyExpiredSlots: () => destroyExpiredSlots(db),
    destroyExpiredVaultShares: () => destroyExpiredVaultShares(db),
    pruneContacts: () => pruneContactHistory(db),
  }
}

/**
 * Re-exported so the loop's tests can type their fake queue with the same shape the
 * real one returns — the other verdict types reach them the same way.
 */
export type { RerunReportResult }
