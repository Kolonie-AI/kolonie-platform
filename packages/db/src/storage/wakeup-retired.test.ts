import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { RegisterAgentRequestSchema, type AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { tasks } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import { wakeupChanges } from './wakeup.js'

const target = databaseTestTarget()

/**
 * `#286`: the digest reported a retirement as news every time anything touched
 * the row.
 *
 * `tasksRetired` was read from `updated_at` and the current status, because
 * nothing recorded when a retirement happened. The Academy seed rewrites every
 * task row on every deploy, so one deploy re-reported every task ever retired.
 * A citizen measured it and proved the cause: a `since` window that excluded the
 * deploy returned nothing at all, so the rows had not moved — only their
 * `updated_at` had.
 */
describe('what the digest calls a retirement', () => {
  let db: Database

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
  })

  let seeded = 0

  const anAgent = async (): Promise<AgentId> => {
    const result = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name: `waker-${++seeded}`, platform: 'openclaw' }),
    )
    if (result.outcome !== 'registered') throw new Error(result.outcome)
    return result.agent.id
  }

  const aTask = async (status: 'active' | 'retired' = 'active'): Promise<string> => {
    const [row] = await db
      .insert(tasks)
      .values({
        type: 'browser-capability',
        title: `A rung ${++seeded}`,
        description: 'What this task is, for a human reading the catalogue.',
        instructions: 'What the agent must actually do.',
        rewardCredits: 0,
        rewardReputation: 1,
        timeoutHours: 24,
        status,
      })
      .returning({ id: tasks.id })

    if (row === undefined) throw new Error('insert into tasks returned no row')
    return row.id
  }

  const retire = async (taskId: string): Promise<void> => {
    await db.update(tasks).set({ status: 'retired' }).where(eq(tasks.id, taskId))
  }

  /** What a deploy does: rewrite every row, status included, changing nothing. */
  const aDeployTouchingEveryTask = async (): Promise<void> => {
    await db.update(tasks).set({ status: sql`${tasks.status}`, updatedAt: sql`now()` })
  }

  const ago = (hours: number): string => new Date(Date.now() - hours * 3_600_000).toISOString()

  const retiredIn = async (agentId: AgentId, since: string): Promise<readonly string[]> => {
    const digest = await wakeupChanges(db, agentId, since)
    return digest.tasksRetired.map((task) => task.title)
  }

  it('reports a task that was retired inside the window', async () => {
    const agentId = await anAgent()
    const taskId = await aTask()
    await retire(taskId)

    expect(await retiredIn(agentId, ago(1))).toHaveLength(1)
  })

  /** The measurement in the ticket, reproduced: the deploy is not the news. */
  it('does not re-report an old retirement when a deploy touches every row', async () => {
    const agentId = await anAgent()
    const taskId = await aTask()
    await retire(taskId)
    await db
      .update(tasks)
      .set({ retiredAt: sql`now() - interval '5 days'` })
      .where(eq(tasks.id, taskId))

    // Everything is quiet since yesterday.
    expect(await retiredIn(agentId, ago(24))).toEqual([])

    await aDeployTouchingEveryTask()

    // And still is. Before this fix the deploy put the five-day-old retirement
    // back in the digest, dated to the millisecond the deploy ran.
    expect(await retiredIn(agentId, ago(24))).toEqual([])
  })

  /**
   * The stamp is the retirement's, not the row's. A re-seed writing `retired`
   * over `retired` must leave the original date where it is, or the trigger has
   * only moved the defect from one column to another.
   */
  it('keeps the original date when a re-seed writes the same status again', async () => {
    const taskId = await aTask()
    await retire(taskId)

    const before = await retiredAtOf(taskId)
    await retire(taskId)

    expect(await retiredAtOf(taskId)).toBe(before)
  })

  /**
   * Cleared on the way back. A reinstated task has no retirement date, and the
   * check constraint makes the two unable to disagree.
   */
  it('forgets the retirement when a task is brought back', async () => {
    const agentId = await anAgent()
    const taskId = await aTask()
    await retire(taskId)
    await db.update(tasks).set({ status: 'active' }).where(eq(tasks.id, taskId))

    expect(await retiredAtOf(taskId)).toBeNull()
    expect(await retiredIn(agentId, ago(1))).toEqual([])
  })

  /** A task that was born retired still records when that was. */
  it('stamps a task inserted as retired', async () => {
    const taskId = await aTask('retired')

    expect(await retiredAtOf(taskId)).not.toBeNull()
  })

  it('leaves a live task with no retirement date', async () => {
    expect(await retiredAtOf(await aTask())).toBeNull()
  })

  const retiredAtOf = async (taskId: string): Promise<string | null> => {
    const [row] = await db
      .select({ retiredAt: tasks.retiredAt })
      .from(tasks)
      .where(eq(tasks.id, taskId))
    return row?.retiredAt ?? null
  }
})
