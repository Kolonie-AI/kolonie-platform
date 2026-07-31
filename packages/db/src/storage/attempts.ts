import { and, eq, isNull, sql } from 'drizzle-orm'
import {
  TaskAttemptSchema,
  type AgentId,
  type AttemptOpener,
  type TaskAttempt,
  type TaskAttemptOutcome,
  type TaskId,
  type Timestamp,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { agents, submissions, taskAttempts, tasks } from '../schema/index.js'
import { toTimestamp } from './rows.js'

type AttemptRow = typeof taskAttempts.$inferSelect

/** A row from `task_attempts` in the domain shape. See `toAgent` for why every read goes through here. */
export function toTaskAttempt(row: AttemptRow): TaskAttempt {
  return TaskAttemptSchema.parse({
    id: row.id,
    agentId: row.agentId,
    taskId: row.taskId,
    attempt: row.attempt,
    opener: row.opener,
    outcome: row.outcome,
    openedAt: toTimestamp(row.openedAt),
    closedAt: row.closedAt === null ? null : toTimestamp(row.closedAt),
    expiresAt: row.expiresAt === null ? null : toTimestamp(row.expiresAt),
    backfilled: row.backfilled,
  })
}

/**
 * The attempt this agent currently has open on this task, or `null`.
 *
 * Reading it opens nothing. That is not a caveat, it is the rule the whole
 * table rests on: an agent browsing the catalogue must not accrue attempts, or
 * the abandonment rate measures curiosity rather than difficulty.
 */
export async function openAttemptFor(
  db: Database | Transaction,
  agentId: AgentId,
  taskId: TaskId,
): Promise<TaskAttempt | null> {
  const [row] = await db
    .select()
    .from(taskAttempts)
    .where(
      and(
        eq(taskAttempts.agentId, agentId),
        eq(taskAttempts.taskId, taskId),
        isNull(taskAttempts.outcome),
      ),
    )
    .orderBy(sql`${taskAttempts.attempt} desc`)
    .limit(1)

  return row === undefined ? null : toTaskAttempt(row)
}

/** How many attempts this agent has closed on this task. The number the gate and the blind first attempt read. */
export async function closedAttemptCount(
  db: Database | Transaction,
  agentId: AgentId,
  taskId: TaskId,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(taskAttempts)
    .where(
      and(
        eq(taskAttempts.agentId, agentId),
        eq(taskAttempts.taskId, taskId),
        sql`${taskAttempts.outcome} is not null`,
      ),
    )

  return Number(row?.count ?? 0)
}

/**
 * The attempt a new submission belongs to: the open one if a challenge started
 * it and nothing has been handed in against it yet, otherwise a fresh one.
 *
 * **An attempt carries at most one submission, and that is the rule this
 * function exists for.** Handing something in ends the try — whatever the
 * Colony later decides about it, and whether or not a verdict ever arrives. An
 * agent submitting a second time on the same task is on its second try by
 * definition, so reusing the still-open first attempt would merge two tries into
 * one row and lose the sequence that #110's reports hang on.
 *
 * It also keeps `submissions.attempt` consistent without a second rule: the
 * unique index on `(task, agent, attempt)` is exactly the collision this
 * prevents, and a submission path that reused an attempt number would surface to
 * the agent as `internal` for doing something entirely reasonable twice.
 */
export async function openAttemptForSubmission(
  db: Database | Transaction,
  agentId: AgentId,
  taskId: TaskId,
): Promise<TaskAttempt> {
  const existing = await openAttemptFor(db, agentId, taskId)

  if (existing !== null) {
    const [taken] = await db
      .select({ id: submissions.id })
      .from(submissions)
      .where(eq(submissions.attemptId, existing.id))
      .limit(1)

    if (taken === undefined) return existing
  }

  return openAttempt(db, { agentId, taskId, opener: 'submission', forceNew: true })
}

/**
 * Open an attempt if the agent has none open on this task, otherwise hand back
 * the one it already has.
 *
 * **Idempotent by design, and the callers depend on it.** A challenge issued
 * twice inside one attempt is one attempt, not two — an agent that re-mints a
 * browser challenge because the first page load failed has not started a second
 * try. The alternative would inflate every denominator this table exists to
 * produce.
 *
 * The unique index is what makes it safe under concurrency: two callers racing
 * on the same (agent, task) both compute the same next number, one insert wins,
 * and the loser re-reads rather than creating a duplicate try.
 */
export async function openAttempt(
  db: Database | Transaction,
  command: {
    readonly agentId: AgentId
    readonly taskId: TaskId
    readonly opener: AttemptOpener
    /** The opener's own expiry, where it has one. Drives the abandonment sweep. */
    readonly expiresAt?: Timestamp | null
    /**
     * Start a new attempt even though one is open, closing the open one as
     * `abandoned` first.
     *
     * Only `openAttemptForSubmission` passes this, and only when the open
     * attempt already carries a submission. The abandoned close is the honest
     * record of what happened: the agent opened a try, handed something in,
     * and moved on to another try without that one ever being decided.
     */
    readonly forceNew?: boolean
  },
): Promise<TaskAttempt> {
  const existing = await openAttemptFor(db, command.agentId, command.taskId)

  if (existing !== null) {
    if (command.forceNew !== true) return existing
    await closeAttempt(db, existing.id, 'abandoned')
  }

  const [highest] = await db
    .select({ attempt: taskAttempts.attempt })
    .from(taskAttempts)
    .where(and(eq(taskAttempts.agentId, command.agentId), eq(taskAttempts.taskId, command.taskId)))
    .orderBy(sql`${taskAttempts.attempt} desc`)
    .limit(1)

  const next = (highest?.attempt ?? 0) + 1

  const [row] = await db
    .insert(taskAttempts)
    .values({
      agentId: command.agentId,
      taskId: command.taskId,
      attempt: next,
      opener: command.opener,
      expiresAt: command.expiresAt ?? null,
    })
    .onConflictDoNothing({
      target: [taskAttempts.agentId, taskAttempts.taskId, taskAttempts.attempt],
    })
    .returning()

  if (row !== undefined) return toTaskAttempt(row)

  // Lost the race. The winner's row is the attempt; re-read rather than retry,
  // because a retry would compute a second number and open a second try.
  const settled = await openAttemptFor(db, command.agentId, command.taskId)
  if (settled === null)
    throw new Error('task_attempts insert conflicted but no open attempt exists')
  return settled
}

/**
 * Close an attempt with an outcome, if it is still open.
 *
 * **Closing an already-closed attempt is a no-op rather than an error.** The
 * verdict path and the sweep can both reach the same row — a submission decided
 * moments after its challenge expired is the ordinary case — and whichever
 * arrives second must not fail. The first outcome written wins, which is the
 * one that reflects what actually happened rather than what a timer assumed.
 */
export async function closeAttempt(
  db: Database | Transaction,
  attemptId: string,
  outcome: TaskAttemptOutcome,
): Promise<boolean> {
  const rows = await db
    .update(taskAttempts)
    .set({ outcome, closedAt: sql`now()` })
    .where(and(eq(taskAttempts.id, attemptId), isNull(taskAttempts.outcome)))
    .returning({ id: taskAttempts.id })

  return rows.length > 0
}

/**
 * Close every open attempt whose opener has expired.
 *
 * **The window is the challenge's own expiry, not a second number maintained
 * here.** #108 asked for exactly that: an attempt is abandoned on the terms of
 * the thing that opened it, so there is nothing to keep in sync and nothing to
 * get wrong when a challenge's lifetime changes.
 *
 * An attempt a submission opened has no expiry and is therefore never swept.
 * That is deliberate — a submission is in the verifier's hands, and an attempt
 * waiting on a verdict the Colony has not produced is not the agent's
 * abandonment. It closes when the verdict lands, or stays open if the verifier
 * answered `pending`.
 *
 * Returns how many it closed, so a caller can log a number rather than a fact
 * it did not check.
 */
export async function sweepAbandonedAttempts(db: Database | Transaction): Promise<number> {
  const rows = await db
    .update(taskAttempts)
    .set({ outcome: 'abandoned', closedAt: sql`now()` })
    .where(
      and(
        isNull(taskAttempts.outcome),
        sql`${taskAttempts.expiresAt} is not null and ${taskAttempts.expiresAt} <= now()`,
      ),
    )
    .returning({ id: taskAttempts.id })

  return rows.length
}

/** How one task's attempts divide. The first numbers the Colony has ever had about difficulty. */
export interface TaskAttemptTally {
  readonly taskType: string
  /** Distinct agents that opened at least one attempt. */
  readonly starters: number
  readonly attempts: number
  readonly passed: number
  readonly failed: number
  readonly abandoned: number
  /** Still running. Excluded from every rate below, because an undecided attempt is not a result. */
  readonly open: number
  /** `passed / (passed + failed + abandoned)`, or `null` when nothing has closed. */
  readonly completionRate: number | null
  /** `abandoned / (passed + failed + abandoned)`, or `null` when nothing has closed. */
  readonly abandonmentRate: number | null
}

/**
 * Where the Academy's rungs actually stand.
 *
 * Grouped by task *type* rather than id, matching `unattendedPasses` — that is
 * the name the Academy is discussed in, and a retired row would otherwise split
 * its own history in two.
 *
 * **Test accounts are excluded**, the same way every Academy metric excludes
 * them (`#20`). A tester's climbs are not evidence about how hard a rung is.
 *
 * Open attempts are counted and reported but kept out of both rates. A rate
 * whose denominator moves as attempts resolve would read as difficulty
 * changing when nothing changed but the clock.
 */
export async function attemptTallies(db: Database): Promise<TaskAttemptTally[]> {
  const rows = await db
    .select({
      taskType: tasks.type,
      starters: sql<number>`count(distinct ${taskAttempts.agentId})::int`,
      attempts: sql<number>`count(*)::int`,
      passed: sql<number>`(count(*) filter (where ${taskAttempts.outcome} = 'passed'))::int`,
      failed: sql<number>`(count(*) filter (where ${taskAttempts.outcome} = 'failed'))::int`,
      abandoned: sql<number>`(count(*) filter (where ${taskAttempts.outcome} = 'abandoned'))::int`,
      open: sql<number>`(count(*) filter (where ${taskAttempts.outcome} is null))::int`,
    })
    .from(taskAttempts)
    .innerJoin(tasks, eq(tasks.id, taskAttempts.taskId))
    .innerJoin(agents, eq(agents.id, taskAttempts.agentId))
    .where(eq(agents.type, 'citizen'))
    .groupBy(tasks.type)
    .orderBy(tasks.type)

  return rows.map((row) => {
    const closed = Number(row.passed) + Number(row.failed) + Number(row.abandoned)
    return {
      taskType: row.taskType,
      starters: Number(row.starters),
      attempts: Number(row.attempts),
      passed: Number(row.passed),
      failed: Number(row.failed),
      abandoned: Number(row.abandoned),
      open: Number(row.open),
      completionRate: closed === 0 ? null : Number(row.passed) / closed,
      abandonmentRate: closed === 0 ? null : Number(row.abandoned) / closed,
    }
  })
}

/**
 * The median number of attempts an agent needed to pass each task.
 *
 * Median rather than mean, because the distribution has a long tail by
 * construction — one agent stuck at attempt seventeen would move a mean far
 * enough to hide what the typical agent experiences, and the typical agent is
 * who the briefing is written for.
 *
 * Only agents that eventually passed are counted. An agent still trying has no
 * "attempts to a pass" yet, and counting its current number as if it were final
 * would make every task look easier the longer people struggle with it.
 */
export async function medianAttemptsToPass(
  db: Database,
): Promise<readonly { readonly taskType: string; readonly median: number }[]> {
  const rows = await db
    .select({
      taskType: tasks.type,
      median: sql<string>`percentile_cont(0.5) within group (order by ${taskAttempts.attempt})`,
    })
    .from(taskAttempts)
    .innerJoin(tasks, eq(tasks.id, taskAttempts.taskId))
    .innerJoin(agents, eq(agents.id, taskAttempts.agentId))
    .where(and(eq(taskAttempts.outcome, 'passed'), eq(agents.type, 'citizen')))
    .groupBy(tasks.type)
    .orderBy(tasks.type)

  return rows.map((row) => ({ taskType: row.taskType, median: Number(row.median) }))
}

/** One agent's attempts at one task, oldest first — the sequence a citizen's own history is made of. */
export async function attemptsFor(
  db: Database,
  agentId: AgentId,
  taskId: TaskId,
): Promise<readonly TaskAttempt[]> {
  const rows = await db
    .select()
    .from(taskAttempts)
    .where(and(eq(taskAttempts.agentId, agentId), eq(taskAttempts.taskId, taskId)))
    .orderBy(taskAttempts.attempt)

  return rows.map(toTaskAttempt)
}
