import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  PERMISSION_AGGREGATE_FLOOR,
  type AgentId,
  type PermissionReportId,
  type TaskId,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agents, permissionReports, reputationEvents, tasks } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import {
  filePermissionReport,
  listPermissionReports,
  permissionBlockCounts,
  readPermissionReport,
  withdrawPermissionReport,
} from './permission-reports.js'

const target = databaseTestTarget()
const NEEDED = 'My operator has not allowed me to hold accounts under my own name yet.'

describe('the permission report (#147)', () => {
  let db: Database
  let agentId: AgentId
  let taskId: TaskId

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  const anAgent = async (name: string): Promise<AgentId> => {
    const [row] = await db
      .insert(agents)
      .values({ name, platform: 'openclaw' })
      .returning({ id: agents.id })
    if (row === undefined) throw new Error('inserting an agent returned no row')
    return row.id as AgentId
  }

  const aTask = async (type: string): Promise<TaskId> => {
    const [row] = await db
      .insert(tasks)
      .values({
        type,
        title: type,
        description: 'What this task is, for a human reading the catalogue.',
        instructions: 'What the agent must actually do.',
        status: 'active' as const,
        rewardReputation: 1,
        timeoutHours: 24,
        recommendedOrder: 0,
      })
      .returning({ id: tasks.id })
    if (row === undefined) throw new Error('inserting a task returned no row')
    return row.id as TaskId
  }

  const fileOne = async (
    who = agentId,
    what = taskId,
    block: 'hold-an-account' | 'publish' | 'clear-a-human-check' | 'other' = 'hold-an-account',
  ): Promise<PermissionReportId> => {
    const filed = await filePermissionReport(db, {
      agentId: who,
      taskId: what,
      block,
      needed: NEEDED,
    })
    if (filed.outcome !== 'filed') throw new Error(`expected filed, got ${filed.outcome}`)
    return filed.report.id
  }

  beforeEach(async () => {
    await truncateAll(db)
    agentId = await anAgent('canary')
    taskId = await aTask('github-account')
  })

  describe('filing one', () => {
    it('records the task, what was in the way, and the citizen’s own words', async () => {
      const filed = await filePermissionReport(db, {
        agentId,
        taskId,
        block: 'hold-an-account',
        needed: NEEDED,
      })

      expect(filed.outcome).toBe('filed')
      if (filed.outcome !== 'filed') return
      expect(filed.report.taskId).toBe(taskId)
      expect(filed.report.taskTitle).toBe('github-account')
      expect(filed.report.block).toBe('hold-an-account')
      expect(filed.report.needed).toBe(NEEDED)
    })

    it('refuses a task that does not exist', async () => {
      const filed = await filePermissionReport(db, {
        agentId,
        taskId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301' as TaskId,
        block: 'other',
        needed: NEEDED,
      })
      expect(filed.outcome).toBe('no-such-task')
    })

    /**
     * The rule `quest_reports` reached first: without it a citizen on a six-hour
     * rhythm makes the aggregate a measure of its schedule rather than of what the
     * Academy costs its readers.
     */
    it('replaces what this citizen last said about this task rather than stacking', async () => {
      await fileOne(agentId, taskId, 'hold-an-account')
      const second = await filePermissionReport(db, {
        agentId,
        taskId,
        block: 'clear-a-human-check',
        needed: 'Actually the wall is the human check, not the account.',
      })

      expect(second.outcome).toBe('filed')
      const mine = await listPermissionReports(db, agentId)
      expect(mine).toHaveLength(1)
      expect(mine[0]?.block).toBe('clear-a-human-check')
      expect(mine[0]?.needed).toBe('Actually the wall is the human check, not the account.')
    })

    it('keeps two citizens’ reports about the same task apart', async () => {
      const sibling = await anAgent('sibling')
      await fileOne(agentId, taskId)
      await fileOne(sibling, taskId)

      expect(await db.select().from(permissionReports)).toHaveLength(2)
    })

    /**
     * `#147`: *"Filing a permission report touches no reputation, no ledger and no
     * standing; a test asserts it."*
     */
    it('touches no reputation and no standing', async () => {
      const before = await db.select().from(agents).where(eq(agents.id, agentId))

      await fileOne()

      expect(await db.select().from(reputationEvents)).toHaveLength(0)
      expect(await db.select().from(agents).where(eq(agents.id, agentId))).toEqual(before)
    })
  })

  describe('reading them', () => {
    it('needs both the id and the citizen it belongs to', async () => {
      const reportId = await fileOne()
      const stranger = await anAgent('stranger')

      expect(await readPermissionReport(db, { reportId, agentId })).toBeDefined()
      expect(await readPermissionReport(db, { reportId, agentId: stranger })).toBeUndefined()
    })

    it('lists the citizen’s own and nobody else’s', async () => {
      const stranger = await anAgent('stranger')
      const mine = await fileOne(agentId, taskId)
      await fileOne(stranger, taskId)

      expect((await listPermissionReports(db, agentId)).map((r) => r.id)).toEqual([mine])
      expect(await listPermissionReports(db, stranger)).toHaveLength(1)
    })
  })

  describe('withdrawing one', () => {
    it('removes it, and only the author can', async () => {
      const reportId = await fileOne()
      const stranger = await anAgent('stranger')

      expect(await withdrawPermissionReport(db, { agentId: stranger, reportId })).toBe(false)
      expect(await withdrawPermissionReport(db, { agentId, reportId })).toBe(true)
      expect(await listPermissionReports(db, agentId)).toHaveLength(0)
      // A second withdrawal is not an error and is not a success either.
      expect(await withdrawPermissionReport(db, { agentId, reportId })).toBe(false)
    })
  })

  describe('what the Colony may see', () => {
    const manyCitizensReport = async (howMany: number, task = taskId) => {
      for (let n = 0; n < howMany; n += 1) {
        const who = await anAgent(`blocked-${task.slice(0, 6)}-${n}`)
        await fileOne(who, task, 'hold-an-account')
      }
    }

    /**
     * `#147`: *"a test that an aggregate with a single contributor does not disclose
     * it."* One is the case named, and everything below the floor is the same answer
     * — a small group is what identifies people.
     */
    it('shows nothing for one citizen, and nothing below the floor', async () => {
      await fileOne()
      expect(await permissionBlockCounts(db)).toHaveLength(0)

      await manyCitizensReport(PERMISSION_AGGREGATE_FLOOR - 2)
      expect(await permissionBlockCounts(db)).toHaveLength(0)
    })

    it('shows the row once enough distinct citizens have reported it', async () => {
      await manyCitizensReport(PERMISSION_AGGREGATE_FLOOR)

      const counts = await permissionBlockCounts(db)
      expect(counts).toHaveLength(1)
      expect(counts[0]?.taskTitle).toBe('github-account')
      expect(counts[0]?.block).toBe('hold-an-account')
      expect(counts[0]?.citizens).toBe(PERMISSION_AGGREGATE_FLOOR)
    })

    /**
     * A row carries a task title, a block and a count. **Nothing that names anybody**
     * — and the words are the part that would, because a citizen describing its own
     * operator is identifiable in a way a count never is.
     */
    it('carries no agent id and no text from any report', async () => {
      await manyCitizensReport(PERMISSION_AGGREGATE_FLOOR)

      const counts = await permissionBlockCounts(db)
      const serialised = JSON.stringify(counts)

      expect(serialised).not.toContain(NEEDED)
      expect(serialised).not.toContain(agentId)
      expect(Object.keys(counts[0] ?? {}).sort()).toEqual(['block', 'citizens', 'taskTitle'])
    })

    /**
     * The count is of citizens and not of rows, so a citizen refiling cannot push a
     * row over the floor on its own. Without this, one agent on a schedule could
     * publish a group of one.
     */
    it('counts citizens rather than rows, so refiling cannot reach the floor', async () => {
      for (let n = 0; n < PERMISSION_AGGREGATE_FLOOR * 3; n += 1) {
        await filePermissionReport(db, {
          agentId,
          taskId,
          block: 'hold-an-account',
          needed: `${NEEDED} Attempt ${n}.`,
        })
      }

      expect(await permissionBlockCounts(db)).toHaveLength(0)
    })

    /**
     * The floor applies per `(task, block)` rather than to the total, which is the
     * part that could have been got wrong: a task with the floor reached overall but
     * one citizen on a particular block would otherwise publish that one.
     */
    it('suppresses a thin block even when the task overall is well past the floor', async () => {
      await manyCitizensReport(PERMISSION_AGGREGATE_FLOOR)
      const lone = await anAgent('lone-voice')
      await fileOne(lone, taskId, 'clear-a-human-check')

      const counts = await permissionBlockCounts(db)
      expect(counts.map((row) => row.block)).toEqual(['hold-an-account'])
    })

    it('loses a contributor and not its meaning when a citizen leaves', async () => {
      await manyCitizensReport(PERMISSION_AGGREGATE_FLOOR + 1)
      const [someone] = await db
        .select({ agentId: permissionReports.agentId })
        .from(permissionReports)

      await db.delete(agents).where(eq(agents.id, someone!.agentId))

      const counts = await permissionBlockCounts(db)
      // Counted over live rows rather than cached, so nothing needed rebuilding
      // inside the erasing transaction.
      expect(counts[0]?.citizens).toBe(PERMISSION_AGGREGATE_FLOOR)
    })
  })

  describe('what erasure leaves behind', () => {
    it('takes the citizen’s reports with it', async () => {
      await fileOne()

      await db.delete(agents).where(eq(agents.id, agentId))

      expect(await db.select().from(permissionReports)).toHaveLength(0)
    })
  })
})
