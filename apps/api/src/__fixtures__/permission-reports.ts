import { randomUUID } from 'node:crypto'
import type {
  AgentId,
  PermissionBlock,
  PermissionReport,
  PermissionReportId,
  TaskId,
} from '@kolonie-ai/core'
import type { PermissionReportDependencies, PermissionReportStore } from '../permission-reports.js'
import { fakeAutonomyStore, type FakeAutonomyStore } from './autonomy.js'

export interface FakePermissionReportStore extends PermissionReportStore {
  /** Make a task exist, so a report has something to be about. */
  readonly giveTask: (title?: string) => TaskId
  /** Give the citizen a reputation, which lives off the authenticated agent. */
  readonly setReputation: (agentId: AgentId, reputation: number) => void
}

interface Row {
  readonly id: PermissionReportId
  readonly agentId: AgentId
  readonly taskId: TaskId
  block: PermissionBlock
  needed: string
  filedAt: string
}

/**
 * The permission report's storage, in memory.
 *
 * **The invariants the database holds are held here too**: one live report per
 * `(citizen, task)` with a refile replacing rather than stacking, and no read that
 * answers with somebody else's row. A fake more permissive than PostgreSQL would let a
 * test pass against behaviour the real store refuses.
 */
export function fakePermissionReportStore(): FakePermissionReportStore {
  const rows = new Map<PermissionReportId, Row>()
  const tasks = new Map<TaskId, string>()
  const reputations = new Map<AgentId, number>()

  return {
    file: ({ agentId, taskId, block, needed }) => {
      if (!tasks.has(taskId)) return Promise.resolve({ outcome: 'no-such-task' as const })

      const existing = [...rows.values()].find(
        (row) => row.agentId === agentId && row.taskId === taskId,
      )

      const row: Row =
        existing ??
        ({
          id: randomUUID() as PermissionReportId,
          agentId,
          taskId,
          block,
          needed,
          filedAt: new Date().toISOString(),
        } satisfies Row)

      row.block = block
      row.needed = needed
      row.filedAt = new Date().toISOString()
      rows.set(row.id, row)

      return Promise.resolve({
        outcome: 'filed' as const,
        report: {
          id: row.id,
          agentId: row.agentId,
          taskId: row.taskId,
          taskTitle: tasks.get(row.taskId) ?? '',
          block: row.block,
          needed: row.needed,
          filedAt: row.filedAt,
        } satisfies PermissionReport,
      })
    },

    list: (agentId) =>
      Promise.resolve(
        [...rows.values()]
          .filter((row) => row.agentId === agentId)
          .sort((a, b) => b.filedAt.localeCompare(a.filedAt))
          .map((row) => ({
            id: row.id,
            agentId: row.agentId,
            taskId: row.taskId,
            taskTitle: tasks.get(row.taskId) ?? '',
            block: row.block,
            needed: row.needed,
            filedAt: row.filedAt,
          })),
      ),

    withdraw: ({ agentId, reportId }) => {
      const row = rows.get(reportId)
      if (row === undefined || row.agentId !== agentId) return Promise.resolve(false)
      rows.delete(reportId)
      return Promise.resolve(true)
    },

    reputation: (agentId) => Promise.resolve(reputations.get(agentId) ?? 0),

    giveTask: (title = 'github-account') => {
      const taskId = randomUUID() as TaskId
      tasks.set(taskId, title)
      return taskId
    },

    setReputation: (agentId, reputation) => {
      reputations.set(agentId, reputation)
    },
  }
}

/**
 * The module wired for a test that does not care about it.
 *
 * The contract store is shared with the autonomy module's fake when a caller passes
 * one, because the recommendation's whole job is comparing *what the citizen holds*
 * with *what its blocked work needs* — and two stores would let a test grant a
 * contract the recommendation never sees.
 */
export function fakePermissionReports(
  contracts: FakeAutonomyStore = fakeAutonomyStore(),
): PermissionReportDependencies & { readonly store: FakePermissionReportStore } {
  return { store: fakePermissionReportStore(), contracts }
}
