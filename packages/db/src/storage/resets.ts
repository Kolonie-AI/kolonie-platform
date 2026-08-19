import { and, desc, eq, gt, sql } from 'drizzle-orm'
import type { AgentId, SubmissionId, TaskId } from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { agents, submissions, supportTickets, taskResets, tasks } from '../schema/index.js'

/** What happened when a tester asked to re-run a task. */
export type ResetResult =
  | { readonly outcome: 'reset'; readonly supersededSubmissionId: SubmissionId }
  /** The caller does not hold the `tester` role. */
  | { readonly outcome: 'not-a-tester' }
  /**
   * There is nothing to reset: the caller has never passed this task.
   *
   * Its own outcome rather than a silent success, because the two mean different
   * things to a tester. Nothing to reset means *just attempt it* — the task is open
   * — while a successful reset means *your previous pass has been set aside*.
   */
  | { readonly outcome: 'nothing-to-reset' }
  /** Already reset and not yet re-attempted. Idempotent rather than a second row. */
  | { readonly outcome: 'already-reset' }

/**
 * Set aside a tester's own pass at one task, so it can run the task again (#47).
 *
 * **Nothing is deleted and nothing is edited.** The reset is a new row; the
 * one-pass gate (D-015) reads *since the last reset* rather than *ever*. See
 * `schema/resets.ts` for why the alternative — deleting the passed submission —
 * would make a held skill unattributable and a booking unexplainable.
 *
 * ## The `tester` role is checked here, in the same statement
 *
 * Not in a route, and not by a caller. This function is reachable from MCP today and
 * from whatever else later, and a permission enforced at one entry point is a
 * permission the second entry point forgets. The role is read from the `agents` row
 * inside the transaction, so a role revoked a moment ago is honoured.
 *
 * ## A tester resets only its own record
 *
 * There is no parameter for a third party. Resetting another citizen's completed
 * business is a governance act rather than a test, and the Colony has a conflict
 * process for those.
 */
export async function resetTaskCompletion(
  db: Database,
  command: {
    readonly agentId: AgentId
    readonly taskId: TaskId
    readonly reason: string
  },
): Promise<ResetResult> {
  return db.transaction(async (tx) => {
    const [agent] = await tx
      .select({ roles: agents.roles })
      .from(agents)
      .where(eq(agents.id, command.agentId))
      // Locked for the same reason `createSubmission` locks it: two resets racing
      // would both read "no reset yet" and both write one, and the second would be
      // a line drawn under nothing.
      .for('update')
      .limit(1)

    if (agent === undefined) {
      throw new Error(`no agent row for the authenticated agent ${command.agentId}`)
    }

    if (!agent.roles.includes('tester')) return { outcome: 'not-a-tester' }

    /**
     * The latest pass, and the latest reset, in one pair of reads inside the lock.
     *
     * The order of the two checks is what makes `already-reset` distinguishable: a
     * pass exists, and a reset newer than it exists, so the tester has already drawn
     * its line and has simply not re-attempted the task yet.
     */
    const [pass] = await tx
      .select({ id: submissions.id, verifiedAt: submissions.verifiedAt })
      .from(submissions)
      .where(
        and(
          eq(submissions.taskId, command.taskId),
          eq(submissions.agentId, command.agentId),
          eq(submissions.status, 'passed'),
        ),
      )
      .orderBy(desc(submissions.verifiedAt))
      .limit(1)

    if (pass === undefined) return { outcome: 'nothing-to-reset' }

    const [existing] = await tx
      .select({ id: taskResets.id })
      .from(taskResets)
      .where(
        and(
          eq(taskResets.agentId, command.agentId),
          eq(taskResets.taskId, command.taskId),
          // Newer than the pass, so a reset from *before* an intervening pass does
          // not make this look already-reset.
          gt(taskResets.createdAt, sql`${pass.verifiedAt}`),
        ),
      )
      .limit(1)

    if (existing !== undefined) return { outcome: 'already-reset' }

    await tx.insert(taskResets).values({
      agentId: command.agentId,
      taskId: command.taskId,
      supersededSubmissionId: pass.id,
      reason: command.reason,
    })

    return { outcome: 'reset', supersededSubmissionId: pass.id as SubmissionId }
  })
}

/**
 * Whether this agent's pass at this task has been set aside by a later reset.
 *
 * **This is the whole of how D-015 was relaxed without being repealed.** The rule is
 * still *many attempts, one pass*; what changed is that the pass being counted is
 * the one since the last line a tester drew. Read inside `createSubmission`'s
 * transaction, so a reset committed a moment ago counts.
 *
 * `true` means the caller may attempt the task again **and** that the attempt is a
 * test re-run, which is why one query answers both questions: the gate and the
 * booking rule must never disagree about whether an attempt was a re-run, and they
 * cannot if there is only one place that decides.
 */
export async function passIsSupersededByReset(
  tx: Transaction,
  query: {
    readonly agentId: AgentId
    readonly taskId: TaskId
    /** When the pass being superseded was decided. */
    readonly passedAt: string
  },
): Promise<boolean> {
  const [reset] = await tx
    .select({ id: taskResets.id })
    .from(taskResets)
    .where(
      and(
        eq(taskResets.agentId, query.agentId),
        eq(taskResets.taskId, query.taskId),
        gt(taskResets.createdAt, sql`${query.passedAt}`),
      ),
    )
    .limit(1)

  return reset !== undefined
}

/** Every reset a tester has drawn, newest first. For a tester reading its own work. */
export async function listOwnResets(
  db: Database,
  agentId: AgentId,
): Promise<readonly { taskId: TaskId; reason: string; createdAt: string }[]> {
  const rows = await db
    .select({
      taskId: taskResets.taskId,
      reason: taskResets.reason,
      createdAt: taskResets.createdAt,
    })
    .from(taskResets)
    .where(eq(taskResets.agentId, agentId))
    .orderBy(desc(taskResets.createdAt))

  return rows.map((row) => ({
    taskId: row.taskId as TaskId,
    reason: row.reason,
    createdAt: row.createdAt,
  }))
}

/** What filing a failed re-run did. */
export type RerunReportResult =
  | { readonly outcome: 'reported'; readonly ticketId: string }
  /** Not a failed test re-run, or one already reported. */
  | { readonly outcome: 'nothing-to-do' }

/**
 * Open a ticket for a test re-run that failed (#47).
 *
 * **Because a re-run that quietly fails is worse than no re-runs** —
 * `kolonie-docs#17`, and it is the acceptance criterion this closes. A tester exists
 * to find out that a task has stopped being solvable; a failure that produced only a
 * log line would make the whole role decorative, because a container log does not
 * survive a redeploy and nobody reads it on the day it mattered.
 *
 * **A ticket rather than a GitHub issue**, and #11 is why: the runner would have to
 * write under the Colony's token, and the tester is the citizen with the finding.
 * Authored by the tester, so `kolonie.support.read` shows it what its own re-run
 * produced — and so triage can answer the agent that reported it.
 *
 * **Called after the verdict is committed, and its failure is the caller's to
 * swallow**, exactly like `routeSubmissionReport`. A ticket must never be able to
 * cost a submission its verdict.
 *
 * Idempotent through `support_tickets_one_per_submission` rather than through a read:
 * the runner is at-least-once by construction, so a crash between the verdict and
 * this call leaves the row to the timeout sweep, and a second attempt has to be
 * harmless. `on conflict do nothing` is what makes it so.
 */
export async function reportFailedRerun(
  db: Database,
  submissionId: SubmissionId,
): Promise<RerunReportResult> {
  const [row] = await db
    .select({
      agentId: submissions.agentId,
      status: submissions.status,
      testRerun: submissions.testRerun,
      attempt: submissions.attempt,
      taskType: tasks.type,
      reason: taskResets.reason,
    })
    .from(submissions)
    .innerJoin(tasks, eq(tasks.id, submissions.taskId))
    // The reset that let this attempt happen, for the reason the tester gave. Left
    // joined: a re-run without a findable reset is not a state to refuse, and a
    // ticket that says "reason unrecorded" is still worth more than silence.
    .leftJoin(
      taskResets,
      and(eq(taskResets.agentId, submissions.agentId), eq(taskResets.taskId, submissions.taskId)),
    )
    .where(eq(submissions.id, submissionId))
    .orderBy(desc(taskResets.createdAt))
    .limit(1)

  if (row === undefined) return { outcome: 'nothing-to-do' }
  // Only a *failed test re-run*. A failed ordinary attempt is an agent learning, and
  // filing a ticket for one would bury the queue in the Academy working correctly.
  if (!row.testRerun || row.status !== 'failed') return { outcome: 'nothing-to-do' }

  const inserted = await db
    .insert(supportTickets)
    .values({
      agentId: row.agentId,
      // A defect: the tester re-ran a task the Colony believed was solvable and it
      // was not. That is a statement about the Colony's own work.
      kind: 'defect',
      // Named rather than inherited (`#1344`). A task that stopped being
      // solvable is a defect in the Academy, and belongs in the queue that can
      // become a public issue.
      route: 'colony',
      subject: `Re-test failed: ${row.taskType}`,
      body:
        `A tester re-ran ${row.taskType} and the attempt failed.\n\n` +
        `Why it was re-run: ${row.reason ?? 'not recorded'}\n` +
        `Attempt: ${row.attempt}\n\n` +
        'This task had been passed before, so the failure is evidence that something ' +
        'about it has changed — the task, its verifier, or the world it reads through. ' +
        'The verdict on the submission carries what the verifier actually saw.',
      submissionId,
    })
    .onConflictDoNothing()
    .returning({ id: supportTickets.id })

  const ticket = inserted[0]
  return ticket === undefined
    ? { outcome: 'nothing-to-do' }
    : { outcome: 'reported', ticketId: ticket.id }
}
