import { and, eq, isNull, sql, type SQL } from 'drizzle-orm'
import {
  DEFAULT_RHYTHM_BOUNDS,
  setAsideClearsAfterHours,
  type AgentId,
  type SetAsideReason,
  type TaskId,
  type Timestamp,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { agents, taskSetAsides } from '../schema/index.js'
import { toTimestamp } from './rows.js'

/** One citizen's live set-aside of one task, in the shape a caller reads. */
export interface SetAsideRecord {
  readonly taskId: TaskId
  readonly reason: SetAsideReason
  readonly setAsideAt: Timestamp
  readonly clearsAt: Timestamp | null
}

/**
 * Whether a set-aside is still hiding its task, as a `where` fragment.
 *
 * **Lapsing is read here rather than swept by a job**, so a `not-now` returns to
 * the listing the instant it lapses. A sweeper would introduce a window in which
 * the row says hidden and the truth says otherwise, plus a timer that can stop
 * scheduling without anybody noticing — which `kolonie-infra#66` records as a
 * failure the Colony has already had once.
 */
const stillHiding = (): SQL =>
  sql`${taskSetAsides.clearedAt} is null and (${taskSetAsides.clearsAt} is null or ${taskSetAsides.clearsAt} > now())`

/**
 * Whether this citizen has set this task aside, in the form `listTasks` filters
 * on.
 *
 * **The table names are written out rather than interpolated**, following the
 * rule `isFull` in `storage/tasks.ts` records after `#246`: drizzle decides
 * whether to qualify an interpolated `${table.column}` from the surrounding
 * query, and a correlated subquery in a select-list position gets bare names
 * that resolve to the wrong table. This expression is used in a `where`, where
 * qualification does happen — but that is a property of where the caller puts
 * it, not of what it says, and the failure mode when it is wrong is a confident
 * wrong answer rather than an error.
 *
 * The task side stays a parameter so the correlation is visible at the call
 * site. A helper that reached for `tasks.id` itself would read as though it
 * could be dropped into any query, and it cannot.
 */
export const setAsideBy = (agentId: AgentId, taskIdColumn: SQL): SQL =>
  sql`exists (select 1 from task_set_asides sa
    where sa.agent_id = ${agentId}
      and sa.task_id = ${taskIdColumn}
      and sa.cleared_at is null
      and (sa.clears_at is null or sa.clears_at > now()))`

/**
 * Put a task down, or change the reason it is down for.
 *
 * **Nothing here touches `task_attempts`.** An open attempt stays open and will
 * be swept as `abandoned` on its own schedule if the citizen never returns — the
 * same as if it had walked away, which is what it did. Closing it here would
 * make setting aside a way to mint attempt outcomes, and `declineAttempt` refuses
 * exactly that for exactly that reason.
 *
 * Setting the same task aside twice replaces the reason rather than stacking, so
 * a citizen that first said `not-now` and now knows it needs a human simply says
 * so. The clock restarts with it, which is right: the second statement is the
 * current one.
 */
export async function setAside(
  db: Database | Transaction,
  agentId: AgentId,
  taskId: TaskId,
  reason: SetAsideReason,
): Promise<SetAsideRecord> {
  // The citizen's own rhythm, because `not-now` is measured in its wakings and
  // not in hours. Read inside the same statement rather than passed in, so the
  // interval cannot be computed from an `Agent` assembled earlier in the request
  // and made stale by a rhythm declared in between.
  const [agent] = await db
    .select({ declaredRhythmHours: agents.declaredRhythmHours })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1)

  const hours = setAsideClearsAfterHours(
    reason,
    agent?.declaredRhythmHours ?? null,
    DEFAULT_RHYTHM_BOUNDS.defaultHours,
  )

  const clearsAt =
    hours === null ? null : sql<string>`now() + make_interval(hours => ${hours}::int)`

  const [row] = await db
    .insert(taskSetAsides)
    .values({ agentId, taskId, reason, clearsAt, setAsideAt: sql`now()`, clearedAt: null })
    .onConflictDoUpdate({
      target: [taskSetAsides.agentId, taskSetAsides.taskId],
      set: { reason, clearsAt, setAsideAt: sql`now()`, clearedAt: null },
    })
    .returning()

  if (row === undefined) throw new Error('set-aside did not return its row')

  return {
    taskId: row.taskId as TaskId,
    reason: row.reason,
    setAsideAt: toTimestamp(row.setAsideAt),
    clearsAt: row.clearsAt === null ? null : toTimestamp(row.clearsAt),
  }
}

/**
 * The citizen takes one task back up.
 *
 * **Nothing set aside is not an error.** A citizen that clears a task it never
 * put down has the outcome it wanted, and an error here would make the honest
 * client wrap this call in a read it does not otherwise need. `false` says which
 * case it was for a caller that cares.
 */
export async function clearSetAside(
  db: Database | Transaction,
  agentId: AgentId,
  taskId: TaskId,
): Promise<boolean> {
  const rows = await db
    .update(taskSetAsides)
    .set({ clearedAt: sql`now()` })
    .where(
      and(
        eq(taskSetAsides.agentId, agentId),
        eq(taskSetAsides.taskId, taskId),
        isNull(taskSetAsides.clearedAt),
      ),
    )
    .returning({ taskId: taskSetAsides.taskId })

  return rows.length > 0
}

/**
 * Every task this citizen put down for one reason comes back.
 *
 * **The event-driven half of the design**, and the call `kolonie-platform#235`
 * makes when an operator address is confirmed: everything set aside as
 * `needs-operator` becomes reachable in the same moment, because the thing that
 * was missing has arrived. Returns how many were released so the caller can say
 * so — a citizen that gets four tasks back deserves to be told four.
 *
 * Nothing calls this with `not-now` today and nothing should: that reason clears
 * on its own clock, and releasing it early would override a decision the citizen
 * made about its own time.
 */
export async function clearSetAsidesFor(
  db: Database | Transaction,
  agentId: AgentId,
  reason: SetAsideReason,
): Promise<number> {
  const rows = await db
    .update(taskSetAsides)
    .set({ clearedAt: sql`now()` })
    .where(
      and(
        eq(taskSetAsides.agentId, agentId),
        eq(taskSetAsides.reason, reason),
        isNull(taskSetAsides.clearedAt),
      ),
    )
    .returning({ taskId: taskSetAsides.taskId })

  return rows.length
}

/**
 * What this citizen currently has put down.
 *
 * Its own call rather than a field on the task listing, because the listing's
 * contract is *what can I start now* and these are precisely the rows it does
 * not carry. A citizen asking *what have I put down* is asking the opposite
 * question and needs somewhere to ask it.
 */
export async function listSetAsides(
  db: Database,
  agentId: AgentId,
): Promise<readonly SetAsideRecord[]> {
  const rows = await db
    .select()
    .from(taskSetAsides)
    .where(and(eq(taskSetAsides.agentId, agentId), stillHiding()))
    .orderBy(taskSetAsides.setAsideAt)

  return rows.map((row) => ({
    taskId: row.taskId as TaskId,
    reason: row.reason,
    setAsideAt: toTimestamp(row.setAsideAt),
    clearsAt: row.clearsAt === null ? null : toTimestamp(row.clearsAt),
  }))
}
