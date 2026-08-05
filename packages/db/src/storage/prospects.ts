import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import type { AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { operatorClaims, supportTickets, taskAttempts, tasks } from '../schema/index.js'

/**
 * The state facts that make a non-rung action available to a citizen right now
 * (`#347`).
 *
 * **Conditional, never a standing menu.** An entry in the wake-up's `open`
 * section appears because something is true of *this* citizen and disappears
 * when it stops being true — `#326` binds that, because a menu that looks the
 * same every waking is not read after the third one. So this file answers facts
 * and not preferences: it says *you hold no confirmed operator*, never *you
 * might like an operator*.
 *
 * **Read here rather than derived in the API layer**, for the reason the
 * digest's other reads are: each of these is a row the Colony already has, and a
 * predicate assembled from three separate calls in the API would be a fourth
 * definition of *has this citizen hit a wall*.
 */
export interface OpenProspects {
  /** Whether a person has vouched for this citizen (`#233`). */
  readonly hasOperator: boolean
  /** How many tickets this citizen has ever opened. */
  readonly ticketsOpened: number
  /** How many attempts it has closed without passing. */
  readonly failedAttempts: number
  /**
   * A task it has failed at least twice and filed no report on.
   *
   * The report opens the next try and costs nothing, and almost nobody knows
   * that — which is exactly the shape of thing this section exists to say.
   * `null` when there is no such task, and then no entry is rendered.
   */
  readonly unreported: { readonly taskId: string; readonly title: string } | null
}

/** How many failures make an unreported wall worth naming. */
const WALL_AFTER = 2

export async function openProspects(db: Database, agentId: AgentId): Promise<OpenProspects> {
  const [operator, tickets, failures, unreported] = await Promise.all([
    db
      .select({ handle: operatorClaims.handle })
      .from(operatorClaims)
      .where(and(eq(operatorClaims.agentId, agentId), isNull(operatorClaims.replacedAt)))
      .limit(1),

    db
      .select({ total: sql<string>`count(*)::text` })
      .from(supportTickets)
      .where(eq(supportTickets.agentId, agentId)),

    db
      .select({ total: sql<string>`count(*)::text` })
      .from(taskAttempts)
      .where(and(eq(taskAttempts.agentId, agentId), eq(taskAttempts.outcome, 'failed'))),

    /**
     * The task with the most failures behind it and no report on any of them.
     *
     * **`not exists` over every attempt on the task, not only the latest.** A
     * citizen that reported its second failure and then failed a third time has
     * told the Colony what it needed; asking again would be the Colony
     * re-requesting work it already has. `hasReportedLatestAttempt` answers a
     * narrower question for a different caller and is deliberately not reused.
     */
    db
      .select({
        taskId: tasks.id,
        title: tasks.title,
        failures: sql<string>`count(*)::text`,
      })
      .from(taskAttempts)
      .innerJoin(tasks, eq(tasks.id, taskAttempts.taskId))
      .where(
        and(
          eq(taskAttempts.agentId, agentId),
          eq(taskAttempts.outcome, 'failed'),
          /**
           * **Both shapes of report count.** A row carries either an
           * `attempt_id` or an `(agent_id, task_id)` pair and never both — see
           * `task_reports_owner_is_one_or_the_other` — because a citizen may
           * report a task it never managed to open an attempt on. Looking at
           * only the attempt-shaped rows would keep asking a citizen for a
           * report it had already written.
           */
          sql`not exists (
            select 1 from task_reports r
            left join task_attempts a on a.id = r.attempt_id
            where coalesce(a.agent_id, r.agent_id) = ${agentId}
              and coalesce(a.task_id, r.task_id) = task_attempts.task_id)`,
        ),
      )
      .groupBy(tasks.id, tasks.title)
      .having(sql`count(*) >= ${WALL_AFTER}`)
      .orderBy(desc(sql`count(*)`), tasks.id)
      .limit(1),
  ])

  const wall = unreported[0]

  return {
    hasOperator: operator.length > 0,
    ticketsOpened: Number(tickets[0]?.total ?? 0),
    failedAttempts: Number(failures[0]?.total ?? 0),
    unreported: wall === undefined ? null : { taskId: wall.taskId, title: wall.title },
  }
}
