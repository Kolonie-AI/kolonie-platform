import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import {
  canTransition,
  isTerminal,
  now as currentTime,
  submissionStatusFor,
  AgentIdSchema,
  SubmissionIdSchema,
  TaskTypeSchema,
  type Agent,
  type AgentId,
  type Submission,
  type SubmissionId,
  type SubmissionStatus,
  type TaskType,
  type Timestamp,
  type Verification,
  type VerifyResult,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agents, submissions, tasks, verifications } from '../schema/index.js'
import { bookTaskReward, type BookedReward } from './rewards.js'
import { toAgent, toSubmission, toVerification } from './rows.js'

/** Statuses a submission can sit in while it still awaits a verdict. */
const OPEN_STATUSES = ['pending', 'verifying'] as const

/**
 * The Academy Level 2 task type, named here because one query has to filter on
 * it. It is a string rather than an import from `packages/verifiers` on purpose:
 * this package must not depend on that one, and a task type is a slug in the
 * data either way (`TaskTypeSchema` in core is a shape, never a list).
 */
const GITHUB_CONTRIBUTION_TASK_TYPE = 'github-contribution'

/** A submission the runner now owns, together with what it needs to check it. */
export interface ClaimedSubmission {
  /** Already moved to `verifying` in the same transaction that handed it over. */
  readonly submission: Submission
  /** The type of the joined task — which verifier module has to run. */
  readonly taskType: TaskType
  /**
   * The agent that submitted, as `VerificationContext` requires it (D-018).
   *
   * Joined here rather than looked up by the runner so that it is read inside
   * the claiming transaction, alongside the row it describes. A verifier that
   * checks the profile is deciding whether *this* agent had *that* profile at
   * the moment its work was taken up; fetching it separately afterwards would
   * let an edit land in between and be checked instead.
   */
  readonly agent: Agent
}

/**
 * Hand the runner the next submission to check, and mark it as taken.
 *
 * The claim and the status change are one statement's worth of work in one
 * transaction, which is the whole point: `FOR UPDATE … SKIP LOCKED` means a
 * second runner reading at the same instant walks straight past this row instead
 * of blocking on it or — far worse — picking it up as well. Two runners paying
 * out one submission twice is the failure this line prevents, and it is cheaper
 * to prevent here than to detect in the ledger.
 *
 * `OF submissions`: the task is joined for its type and is not locked. Locking
 * it would serialise every runner behind whichever one happened to claim a
 * submission of the same task type.
 *
 * Only `pending` rows are claimed. A row already in `verifying` belongs to
 * another runner — or to one that died holding it, which is what
 * {@link expireOverdueSubmissions} is for, not this function. Claiming those
 * back on a timer here would race the runner that is still working on it.
 *
 * `taskTypes` is the set of verifiers the calling runner actually has, and it is
 * a filter rather than a check afterwards for a reason that only shows up in
 * production. A submission whose verifier is not deployed yet must stay pending
 * (`AGENTS.md` §6). Claiming it first and discovering that second would mean
 * putting it straight back on every poll — and since the queue is served oldest
 * first, that one undeployable row would sit at the head of the line and starve
 * everything behind it until its deadline. Not selecting it at all leaves it
 * exactly as pending as the rule requires, and invisible to the queue.
 *
 * An empty set claims nothing, which is the honest answer for a runner that
 * ships no verifiers.
 */
export async function claimNextSubmission(
  db: Database,
  taskTypes: readonly TaskType[],
): Promise<ClaimedSubmission | undefined> {
  if (taskTypes.length === 0) return undefined

  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ submission: submissions, taskType: tasks.type, agent: agents })
      .from(submissions)
      .innerJoin(tasks, eq(tasks.id, submissions.taskId))
      // Inner, not left: a submission whose agent has vanished is not a row to
      // verify quietly, it is a foreign key that failed to hold. Leaving it
      // unclaimed surfaces it as a stuck submission rather than paying it out
      // against an agent nobody can name.
      .innerJoin(agents, eq(agents.id, submissions.agentId))
      .where(and(eq(submissions.status, 'pending'), inArray(tasks.type, [...taskTypes])))
      // Oldest first: an agent that has waited longest is served first, and a
      // submission cannot be starved by a steady arrival of newer ones.
      .orderBy(asc(submissions.submittedAt))
      .limit(1)
      .for('update', { of: submissions, skipLocked: true })

    if (row === undefined) return undefined

    const [claimed] = await tx
      .update(submissions)
      .set({ status: 'verifying' })
      .where(eq(submissions.id, row.submission.id))
      .returning()

    if (claimed === undefined) throw new Error('claiming a locked submission returned no row')

    return {
      submission: toSubmission(claimed),
      taskType: TaskTypeSchema.parse(row.taskType),
      agent: toAgent(row.agent),
    }
  })
}

/** What recording a verdict did. */
export type RecordVerdictResult =
  | {
      readonly outcome: 'recorded'
      readonly submission: Submission
      readonly verification: Verification
      /**
       * What the pass paid, or `undefined` for any verdict that is not a pass.
       * A failed submission books nothing, and says so by having nothing here
       * rather than by a booking of zero.
       */
      readonly booking?: BookedReward
    }
  /**
   * The row was no longer the caller's to decide — another writer reached it
   * first, most plausibly the timeout sweep while a slow verifier was still
   * thinking. Not an error: the verdict is dropped and the evidence with it,
   * because a submission that has already timed out must not be resurrected
   * into a payout by a check that started before the deadline.
   */
  | { readonly outcome: 'stale'; readonly status: SubmissionStatus }

export interface RecordVerdictCommand {
  readonly submissionId: SubmissionId
  /** The type whose verifier produced this verdict; copied onto the record. */
  readonly taskType: TaskType
  readonly result: VerifyResult
  /** Injectable for tests. Production passes nothing and gets the wall clock. */
  readonly now?: Timestamp
}

/**
 * Write a verdict: the evidence, the submission's new status, and — on a pass —
 * the coins and reputation it earned, in one transaction.
 *
 * The order inside the transaction does not matter; the atomicity does, and it
 * is what all three writes are here for. A submission that reaches `passed`
 * without the row explaining why is a coin the Colony cannot account for. A
 * submission that reaches `passed` without the booking is a coin the Colony owes
 * and will never pay, because nothing ever revisits a decided submission. Both
 * states are unreachable only if everything commits together or nothing does.
 *
 * **This function does not decide what a pass is worth**, and must not grow the
 * ability to. `AGENTS.md` §3 — the verifier never rewards its own results — is a
 * rule about where an amount comes from, and the amount comes from the `tasks`
 * row, read by {@link bookTaskReward} inside this transaction. Nothing in
 * `command.result` reaches the ledger except the fact that the status was
 * `pass`; a verifier that wanted to pay itself more would have to change the
 * task an agent signed up for, in public, before the work was done.
 *
 * A `pending` verdict — the mail has not arrived yet — returns the submission to
 * `pending` and leaves `verified_at` null, so the next poll picks it up again.
 * The evidence row is still written: "checked at 14:02, the transaction had not
 * confirmed" is exactly the history that explains why a payout happened at 14:30
 * and not earlier.
 */
export async function recordVerdict(
  db: Database,
  command: RecordVerdictCommand,
): Promise<RecordVerdictResult> {
  const decidedAt = command.now ?? currentTime()
  const next = submissionStatusFor(command.result.status)

  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ status: submissions.status })
      .from(submissions)
      .where(eq(submissions.id, command.submissionId))
      .for('update')
      .limit(1)

    // The row was claimed by this runner moments ago. Its disappearance means a
    // submission was deleted mid-verification, which nothing in the Colony does.
    if (current === undefined) {
      throw new Error(
        `no submission row for ${command.submissionId}, which was claimed for verification`,
      )
    }

    if (current.status !== 'verifying') return { outcome: 'stale', status: current.status }

    // The state machine lives in core so that both writers of this table agree
    // on it (see `SUBMISSION_TRANSITIONS`). Re-deriving the rule here would be
    // the second slightly-different copy that comment warns about.
    if (!canTransition(current.status, next)) {
      throw new Error(`illegal transition from '${current.status}' to '${next}'`)
    }

    const [record] = await tx
      .insert(verifications)
      .values({
        submissionId: command.submissionId,
        taskType: command.taskType,
        status: command.result.status,
        evidence: command.result.evidence,
        metadata: command.result.metadata ?? null,
        createdAt: decidedAt,
      })
      .returning()

    if (record === undefined) throw new Error('insert into verifications returned no row')

    const [updated] = await tx
      .update(submissions)
      .set({
        status: next,
        // The `submissions_verified_at_matches_status` constraint requires these
        // two to agree, so the terminal test decides the timestamp rather than
        // the caller remembering to.
        verifiedAt: isTerminal(next) ? decidedAt : null,
      })
      .where(eq(submissions.id, command.submissionId))
      .returning()

    if (updated === undefined) throw new Error('updating a locked submission returned no row')

    // The last clause of the sentence the MVP is measured against in
    // `ROADMAP.md`: *"…and a coin lands in the ledger."* Only on `passed` —
    // `failed`, `timeout` and a return to `pending` all book nothing, which is
    // the same statement as having no branch for them.
    const booking =
      next === 'passed'
        ? await bookTaskReward(tx, { submissionId: command.submissionId, bookedAt: decidedAt })
        : undefined

    return {
      outcome: 'recorded',
      submission: toSubmission(updated),
      verification: toVerification(record),
      ...(booking === undefined ? {} : { booking }),
    }
  })
}

/**
 * Put a claimed submission back in the queue without deciding it.
 *
 * For transient failures — the verifier's upstream was unreachable, the process
 * is shutting down mid-check. Nothing is written to `verifications`, because
 * nothing was verified: a row here would put "the check did not happen" in the
 * table that explains why coins were paid.
 *
 * Returns whether the release actually applied. `false` means the row was no
 * longer `verifying` — the timeout sweep got there first — and the caller has
 * nothing left to do.
 */
export async function releaseSubmission(
  db: Database,
  submissionId: SubmissionId,
): Promise<boolean> {
  const released = await db
    .update(submissions)
    .set({ status: 'pending' })
    .where(and(eq(submissions.id, submissionId), eq(submissions.status, 'verifying')))
    .returning({ id: submissions.id })

  return released.length > 0
}

/** A submission the sweep gave up on, and the deadline it missed. */
export interface ExpiredSubmission {
  readonly submissionId: SubmissionId
  readonly taskType: TaskType
  /** What it was when the deadline passed — `pending` or `verifying`. */
  readonly previousStatus: SubmissionStatus
}

/**
 * Mark every open submission whose deadline has passed as `timeout`.
 *
 * Two distinct things end up here, and both need to.
 *
 * A `pending` submission past its deadline is the ordinary case: the task waits
 * on the real world (D-005), the world never answered, and `timeoutHours` is the
 * agent's promise that the wait ends. A `verifying` one is the interesting case
 * — it is a row whose runner died holding it. Nothing else reclaims those, and
 * without this sweep a single crash would leave a submission unanswerable
 * forever while its agent polls `GET /v1/agents/me` for a verdict that cannot
 * arrive.
 *
 * `timeout` is its own terminal status rather than `failed` on purpose: the
 * agent did not submit something wrong, so its record should not say it did.
 * Core allows a retry from neither, but `academy.md` treats the two
 * differently when it comes to reputation.
 *
 * The deadline is measured from `submitted_at`, not from the claim: it is the
 * agent's wait that `timeoutHours` bounds, and a submission the runner picked up
 * late has already used part of it.
 */
export async function expireOverdueSubmissions(
  db: Database,
  options: { readonly now?: Timestamp; readonly limit?: number } = {},
): Promise<readonly ExpiredSubmission[]> {
  const deadline = options.now ?? currentTime()
  const limit = options.limit ?? 50

  return db.transaction(async (tx) => {
    const overdue = await tx
      .select({
        id: submissions.id,
        status: submissions.status,
        taskType: tasks.type,
        timeoutHours: tasks.timeoutHours,
      })
      .from(submissions)
      .innerJoin(tasks, eq(tasks.id, submissions.taskId))
      .where(
        and(
          inArray(submissions.status, [...OPEN_STATUSES]),
          sql`${submissions.submittedAt} + make_interval(hours => ${tasks.timeoutHours}) <= ${deadline}::timestamptz`,
        ),
      )
      .orderBy(asc(submissions.submittedAt))
      .limit(limit)
      .for('update', { of: submissions, skipLocked: true })

    if (overdue.length === 0) return []

    const expired: ExpiredSubmission[] = []

    for (const row of overdue) {
      const submissionId = SubmissionIdSchema.parse(row.id)
      const taskType = TaskTypeSchema.parse(row.taskType)

      // Written as a verdict, unlike a release: a timeout *is* a decision about
      // the submission, it is terminal, and an agent that reads "your submission
      // expired" is owed the same account of why as one that reads "you failed".
      await tx.insert(verifications).values({
        submissionId,
        taskType,
        status: 'timeout',
        evidence:
          `No verdict within the task's ${row.timeoutHours}-hour window` +
          `; the submission was '${row.status}' when the deadline passed.`,
        createdAt: deadline,
      })

      await tx
        .update(submissions)
        .set({ status: 'timeout', verifiedAt: deadline })
        .where(eq(submissions.id, row.id))

      expired.push({ submissionId, taskType, previousStatus: row.status })
    }

    return expired
  })
}

/**
 * Every check made on one submission, oldest first.
 *
 * The audit read: this is what answers "why was this agent paid", and #8 books
 * against the last row of it.
 */
export async function verificationsFor(
  db: Database,
  submissionId: SubmissionId,
): Promise<readonly Verification[]> {
  const rows = await db
    .select()
    .from(verifications)
    .where(eq(verifications.submissionId, submissionId))
    .orderBy(asc(verifications.createdAt))

  return rows.map(toVerification)
}

/**
 * Which citizen, if any, has already passed Academy Level 2 with this GitHub
 * account.
 *
 * The Colony-side half of D-019's fourth check: *"the author is a single GitHub
 * account, and that account has not already carried another citizen's passing
 * Level 2 submission."* One GitHub identity certifies one citizen, and the point
 * of the level is that a citizen has a presence outside the Colony of its own —
 * which an account rented out to a dozen agents is not.
 *
 * It reads `metadata->>'author'` on passing `github-contribution` verifications,
 * because that is where the verifier records the login it admitted. That makes
 * the answer derived from the audit trail rather than from a second table kept
 * alongside it: a passing verdict *is* the claim on the account, and there is no
 * way to book one without staking the other.
 *
 * Compared case-insensitively, since GitHub treats `Octocat` and `octocat` as
 * one account. The verifier lowercases before writing, and this lowercases
 * before reading, so a row written by an older build cannot slip the rule.
 *
 * The oldest claim wins. Two agents racing the same account is exactly the abuse
 * this exists to stop, and "whoever asked most recently" would let the second
 * one take the first one's answer.
 */
export async function citizenForGithubAuthor(
  db: Database,
  author: string,
): Promise<AgentId | undefined> {
  const [claimed] = await db
    .select({ agentId: submissions.agentId })
    .from(verifications)
    .innerJoin(submissions, eq(submissions.id, verifications.submissionId))
    .where(
      and(
        eq(verifications.taskType, GITHUB_CONTRIBUTION_TASK_TYPE),
        eq(verifications.status, 'pass'),
        sql`lower(${verifications.metadata}->>'author') = lower(${author})`,
      ),
    )
    .orderBy(asc(verifications.createdAt))
    .limit(1)

  return claimed === undefined ? undefined : AgentIdSchema.parse(claimed.agentId)
}
