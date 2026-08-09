import { and, asc, desc, eq, gt, isNotNull, lt, sql } from 'drizzle-orm'
import type { TaskId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { taskAttempts, taskBriefingReads, taskBriefings, tasks } from '../schema/index.js'

/**
 * Whether a briefing changes an outcome (`#609`).
 *
 * The machinery works and nothing knows whether it helps. 178 reports, 191
 * moderation decisions, 40 briefings carrying 145 claims — and one mark saying
 * any of it helped. Without a number, every decision about the Academy's hint
 * system is taken on the strength of the artefacts looking good, and *a claim
 * that reads well and changes nothing is the most expensive kind, because it is
 * the one nobody questions.*
 *
 * ## Two measures, and the cheap one first
 *
 * **How often a briefing is read at all.** If that is near zero, the pass rate is
 * not the problem and rewriting the synthesis will not move it. `#610` is what
 * made this worth measuring: until it landed, an agent got the hints only if it
 * thought to ask.
 *
 * **The pass rate before and against after the briefing existed.** Same task,
 * attempts closed before `written_at` against attempts closed after. It is the
 * only measure that answers the question directly, and it is a signal rather
 * than a proof — which is why nothing here returns a bare number.
 *
 * ## The two cautions are structural, not documentation
 *
 * **The sample is small**, so every figure carries its own count and
 * {@link ENOUGH_TO_SAY} decides whether it may be read as a rate at all. A rate
 * over four attempts is noise with a decimal point. The floor is applied by the
 * caller reading `enough`, not by hiding rows: *which* tasks have too little
 * evidence is itself worth seeing.
 *
 * **The population changes.** Later agents are not the same agents and the task
 * text may have been rewritten in between. Nothing here can correct for that and
 * nothing pretends to; the surface that prints these says so.
 *
 * ## What this must not become
 *
 * **No score on a claim, no ordering, no automatic removal.** `#609` names all
 * three. This produces the number a moderator would read and nothing acts on it.
 */

/**
 * The fewest attempts on one side of the line before a rate means anything.
 *
 * Five, which is the same floor `growth/README.md` sets for the Atlas and the
 * same one `permissionBlocks` applies in SQL — one number, argued once. Below it
 * the honest rendering is *not enough yet* rather than a percentage.
 */
export const ENOUGH_TO_SAY = 5

/** One task's pass rate either side of the moment its briefing was written. */
export interface BriefingEffect {
  readonly taskId: TaskId
  readonly title: string
  /** When the briefing was written — the line the two windows sit either side of. */
  readonly writtenAt: string
  readonly before: { readonly attempts: number; readonly passed: number }
  readonly after: { readonly attempts: number; readonly passed: number }
  /**
   * Whether both sides clear {@link ENOUGH_TO_SAY}.
   *
   * **A field rather than a filter**, because a task with two attempts either
   * side is a fact about the Academy worth seeing — it says the measurement is
   * not available yet, which is different from saying the briefing did nothing.
   */
  readonly enough: boolean
  /** How often this task's briefing has been read (`#609`'s cheaper measure). */
  readonly reads: number
}

/**
 * Every task that has a briefing, with the attempts either side of it.
 *
 * One query and not one per task: this is a `/backend` section and the figure is
 * over the whole corpus.
 */
export async function briefingEffect(db: Database): Promise<readonly BriefingEffect[]> {
  const closed = and(isNotNull(taskAttempts.closedAt), isNotNull(taskAttempts.outcome))

  const rows = await db
    .select({
      taskId: taskBriefings.taskId,
      title: tasks.title,
      writtenAt: taskBriefings.writtenAt,
      beforeAttempts: sql<number>`count(*) filter (where ${lt(taskAttempts.closedAt, taskBriefings.writtenAt)})::int`,
      beforePassed: sql<number>`count(*) filter (
        where ${lt(taskAttempts.closedAt, taskBriefings.writtenAt)} and ${taskAttempts.outcome}::text = 'passed'
      )::int`,
      afterAttempts: sql<number>`count(*) filter (where ${gt(taskAttempts.closedAt, taskBriefings.writtenAt)})::int`,
      afterPassed: sql<number>`count(*) filter (
        where ${gt(taskAttempts.closedAt, taskBriefings.writtenAt)} and ${taskAttempts.outcome}::text = 'passed'
      )::int`,
      reads: sql<number>`coalesce(max(${taskBriefingReads.reads}), 0)::int`,
    })
    .from(taskBriefings)
    .innerJoin(tasks, eq(tasks.id, taskBriefings.taskId))
    .leftJoin(taskAttempts, and(eq(taskAttempts.taskId, taskBriefings.taskId), closed))
    .leftJoin(taskBriefingReads, eq(taskBriefingReads.taskId, taskBriefings.taskId))
    .where(isNotNull(taskBriefings.writtenAt))
    .groupBy(taskBriefings.taskId, tasks.title, taskBriefings.writtenAt)
    .orderBy(desc(sql`count(*)`), asc(tasks.title))

  return rows.map((row) => ({
    taskId: row.taskId as TaskId,
    title: row.title,
    writtenAt: row.writtenAt as string,
    before: { attempts: row.beforeAttempts, passed: row.beforePassed },
    after: { attempts: row.afterAttempts, passed: row.afterPassed },
    enough: row.beforeAttempts >= ENOUGH_TO_SAY && row.afterAttempts >= ENOUGH_TO_SAY,
    reads: row.reads,
  }))
}

/**
 * Count one reading of a briefing (`#609`).
 *
 * **Never fails the read it instruments.** This rides on the path that serves a
 * briefing to a citizen, and a measurement that can stand between an agent and
 * its next attempt is worse than no measurement — the same rule `recordOrigin`
 * is written to, for the same reason. The caller does not await it into the
 * answer.
 */
export async function recordBriefingRead(db: Database, taskId: TaskId): Promise<void> {
  try {
    await db
      .insert(taskBriefingReads)
      .values({ taskId, reads: 1 })
      .onConflictDoUpdate({
        target: taskBriefingReads.taskId,
        set: {
          reads: sql`${taskBriefingReads.reads} + 1`,
          lastReadAt: new Date().toISOString(),
        },
      })
  } catch {
    // Deliberately silent: see above. A task that has since been deleted is the
    // ordinary cause, and it is not a defect in the read this rode on.
  }
}
