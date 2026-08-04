import { and, desc, eq, sql } from 'drizzle-orm'
import {
  PERMISSION_AGGREGATE_FLOOR,
  type AgentId,
  type PermissionBlock,
  type PermissionReport,
  type PermissionReportId,
  type TaskId,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { permissionReports, tasks } from '../schema/index.js'
import { toTimestamp } from './rows.js'

/**
 * The queries behind the permission report (#147).
 *
 * **There is no function here that serves a report to anybody but its author.** The
 * citizen's reads are keyed on its own id; the Colony's read is an aggregate that
 * carries no agent id and no text at all. That is the privacy rule as a property of
 * this file's surface rather than of a filter somebody has to remember — a function
 * returning rows by task id would be the whole defect, and it does not exist.
 */

/** What happened when a citizen filed one. */
export type FilePermissionReportOutcome =
  | { readonly outcome: 'filed'; readonly report: PermissionReport }
  /** No such task, which for a caller-supplied id also covers *never existed*. */
  | { readonly outcome: 'no-such-task' }

const view = (row: {
  id: string
  agentId: string
  taskId: string
  taskTitle: string
  block: string
  needed: string
  filedAt: string
}): PermissionReport => ({
  id: row.id as PermissionReportId,
  agentId: row.agentId as AgentId,
  taskId: row.taskId as TaskId,
  taskTitle: row.taskTitle,
  block: row.block as PermissionBlock,
  needed: row.needed,
  filedAt: toTimestamp(row.filedAt),
})

const selection = {
  id: permissionReports.id,
  agentId: permissionReports.agentId,
  taskId: permissionReports.taskId,
  taskTitle: tasks.title,
  block: permissionReports.block,
  needed: permissionReports.needed,
  filedAt: permissionReports.filedAt,
}

/**
 * File one, or replace what this citizen last said about this task.
 *
 * **Replacing rather than accumulating**, the rule `quest_reports` reached first: a
 * citizen that read a task twice and understood its own obstacle better the second
 * time is not two data points, and without this a scheduled agent would make the
 * aggregate a measure of its rhythm.
 *
 * **Nothing here touches reputation, the ledger, standing or any counter.** `#147`
 * requires it, and the way it is kept true is that this function writes one row into
 * one table and returns.
 */
export async function filePermissionReport(
  db: Database,
  input: {
    readonly agentId: AgentId
    readonly taskId: TaskId
    readonly block: PermissionBlock
    readonly needed: string
  },
): Promise<FilePermissionReportOutcome> {
  const [task] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.id, input.taskId))
    .limit(1)

  if (task === undefined) return { outcome: 'no-such-task' }

  const [row] = await db
    .insert(permissionReports)
    .values({
      agentId: input.agentId,
      taskId: input.taskId,
      block: input.block,
      needed: input.needed,
    })
    .onConflictDoUpdate({
      target: [permissionReports.agentId, permissionReports.taskId],
      set: { block: input.block, needed: input.needed, filedAt: sql`now()` },
    })
    .returning({ id: permissionReports.id })

  if (row === undefined) throw new Error('permission_reports upsert returned no row')

  const report = await readPermissionReport(db, {
    reportId: row.id as PermissionReportId,
    agentId: input.agentId,
  })
  if (report === undefined) throw new Error('permission_reports row vanished after write')

  return { outcome: 'filed', report }
}

/**
 * One report, by id and by the citizen it must belong to.
 *
 * Both keys always, for the reason `readOperatorRequest` states: a read that took
 * only an id would be one careless call site away from serving somebody else's, and
 * the ownership check would live in whichever caller remembered it.
 */
export async function readPermissionReport(
  db: Database,
  query: { readonly reportId: PermissionReportId; readonly agentId: AgentId },
): Promise<PermissionReport | undefined> {
  const [row] = await db
    .select(selection)
    .from(permissionReports)
    .innerJoin(tasks, eq(tasks.id, permissionReports.taskId))
    .where(
      and(eq(permissionReports.id, query.reportId), eq(permissionReports.agentId, query.agentId)),
    )
    .limit(1)

  return row === undefined ? undefined : view(row)
}

/** The citizen's own reports, newest first. There is no parameter to aim. */
export async function listPermissionReports(
  db: Database,
  agentId: AgentId,
): Promise<readonly PermissionReport[]> {
  const rows = await db
    .select(selection)
    .from(permissionReports)
    .innerJoin(tasks, eq(tasks.id, permissionReports.taskId))
    .where(eq(permissionReports.agentId, agentId))
    .orderBy(desc(permissionReports.filedAt))

  return rows.map(view)
}

/**
 * The citizen withdraws one it filed by mistake.
 *
 * `true` when a row went. **Deleted rather than marked withdrawn**, unlike almost
 * everything else in this schema: the usual argument for keeping a row is that
 * somebody may need to audit what was said, and here the only readers are the author
 * and an aggregate that must not be reducible to it. A withdrawn-but-kept report
 * would be a statement about a citizen's contract retained after the citizen asked
 * for it to be gone, which is the thing this table exists to be careful about.
 */
export async function withdrawPermissionReport(
  db: Database,
  input: { readonly agentId: AgentId; readonly reportId: PermissionReportId },
): Promise<boolean> {
  const rows = await db
    .delete(permissionReports)
    .where(
      and(eq(permissionReports.id, input.reportId), eq(permissionReports.agentId, input.agentId)),
    )
    .returning({ id: permissionReports.id })

  return rows.length > 0
}

/** One row of the Colony's aggregate. No agent id, no text, ever. */
export interface PermissionBlockCount {
  readonly taskTitle: string
  readonly block: PermissionBlock
  /** Distinct citizens, never rows — a citizen refiling must not move this. */
  readonly citizens: number
}

/**
 * *How often is the Academy's own design blocked by permission, and where?* — for
 * the Colony, and anonymous.
 *
 * ## Two things make it non-reducible, and both are in the query
 *
 * **It counts distinct agents and returns no agent id or text**, so there is nothing
 * in a row that names anybody. And it **drops any row below
 * {@link PERMISSION_AGGREGATE_FLOOR}**, in SQL rather than in a caller, because
 * *"one citizen was blocked on `social-account` by permission"* is a fact about one
 * contract however carefully the reader is asked not to think about it.
 *
 * `#147`: *"no aggregate may be reducible to a single citizen's contract."* The
 * suppression is the whole of how that is true, which is why it is a `having` clause
 * and not a `filter` in TypeScript that a second caller could skip.
 *
 * ## What is deliberately not offered
 *
 * There is no per-task breakdown by citizen, no time series, and no way to ask about
 * one task. A caller that could ask *which citizens* or *narrow it until one is
 * left* would defeat the floor — the answer to a narrowing question is a smaller
 * group, and small groups are the ones that identify people.
 */
export async function permissionBlockCounts(
  db: Database,
): Promise<readonly PermissionBlockCount[]> {
  const floor = sql.raw(String(PERMISSION_AGGREGATE_FLOOR))

  const rows = await db.execute<{ title: string; block: string; citizens: string }>(sql`
    select t.title as title, pr.block as block, count(distinct pr.agent_id)::text as citizens
      from permission_reports pr
      join tasks t on t.id = pr.task_id
     group by t.title, pr.block
    having count(distinct pr.agent_id) >= ${floor}
     order by count(distinct pr.agent_id) desc, t.title, pr.block
  `)

  return rows.map((row) => ({
    taskTitle: row.title,
    block: row.block as PermissionBlock,
    citizens: Number(row.citizens),
  }))
}
