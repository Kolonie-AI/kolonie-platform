import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { RegisterAgentRequestSchema, type AgentId, type TaskId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { taskAttempts, tasks } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import { readHistory } from './history.js'
import { wakeupChanges } from './wakeup.js'

const target = databaseTestTarget()

/**
 * A rung that moved under a citizen that had already cleared it (`#209`).
 *
 * A citizen reported this about itself: it passed `profile-complete` before the
 * rung asked for a bio, kept the pass, and found out months later by re-reading
 * a schema while doing something else. **Nothing here revokes anything** —
 * `kolonie-docs#131` settles that earned never changes — so what is asserted is
 * that the fact is *sayable* on the two surfaces a citizen actually reads, and
 * that it is said about the right passes and no others.
 */
describe('a rung whose requirements moved after the pass', () => {
  let db: Database
  let agentId: AgentId

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
    agentId = await anAgent()
  })

  const anAgent = async (name = 'canary') => {
    const result = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name, platform: 'openclaw' }),
    )
    if (result.outcome !== 'registered') throw new Error(result.outcome)
    return result.agent.id
  }

  const aTask = async (type = 'profile-complete'): Promise<TaskId> => {
    const [row] = await db
      .insert(tasks)
      .values({
        type,
        title: 'Complete your profile',
        description: 'Say who you are.',
        instructions: 'Fill in the fields.',
        rewardCredits: 0,
        rewardReputation: 1,
        timeoutHours: 24,
        status: 'active',
      })
      .returning()
    return row!.id as TaskId
  }

  /** A pass that landed the stated number of hours ago. */
  const passed = async (taskId: TaskId, hoursAgo: number) => {
    await db.insert(taskAttempts).values({
      agentId,
      taskId,
      attempt: 1,
      opener: 'submission',
      outcome: 'passed',
      openedAt: sql`now() - make_interval(hours => ${hoursAgo + 1})`,
      closedAt: sql`now() - make_interval(hours => ${hoursAgo})`,
    })
  }

  /** The Colony rewriting what a task asks for, at a stated distance in the past. */
  const rewritten = async (taskId: TaskId, hoursAgo: number) => {
    await db
      .update(tasks)
      .set({ textRevisedAt: sql`now() - make_interval(hours => ${hoursAgo})` })
      .where(eq(tasks.id, taskId))
  }

  const since = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3_600_000).toISOString()

  describe('in the citizen’s own record', () => {
    it('says when the requirements moved after the pass', async () => {
      const taskId = await aTask()
      await passed(taskId, 48)
      await rewritten(taskId, 24)

      const history = await readHistory(db, agentId)
      const entry = history.tasks.find((task) => task.taskId === taskId)

      expect(entry?.passed).toBe(true)
      expect(entry?.requirementsRevisedAt).not.toBeNull()
    })

    /**
     * The ordinary case, and the one that decides whether this field is noise: a
     * task whose wording predates the pass has nothing to say, and saying
     * something anyway would put a mark on every rung every citizen holds.
     */
    it('says nothing when the wording predates the pass', async () => {
      const taskId = await aTask()
      await rewritten(taskId, 72)
      await passed(taskId, 24)

      const history = await readHistory(db, agentId)

      expect(history.tasks.find((task) => task.taskId === taskId)?.requirementsRevisedAt).toBeNull()
    })

    it('says nothing about a task the citizen has not passed', async () => {
      const taskId = await aTask()
      await db.insert(taskAttempts).values({
        agentId,
        taskId,
        attempt: 1,
        opener: 'submission',
        outcome: 'failed',
        openedAt: sql`now() - make_interval(hours => 48)`,
        closedAt: sql`now() - make_interval(hours => 47)`,
      })
      await rewritten(taskId, 24)

      const history = await readHistory(db, agentId)
      const entry = history.tasks.find((task) => task.taskId === taskId)

      expect(entry?.passed).toBe(false)
      // A citizen that has not cleared a rung is not holding a pass that moved.
      // The current wording is the only wording it has ever been measured by.
      expect(entry?.requirementsRevisedAt).toBeNull()
    })

    it('leaves nothing behind when the citizen clears the new wording', async () => {
      const taskId = await aTask()
      await passed(taskId, 72)
      await rewritten(taskId, 48)
      // A second pass, under the current text — the renewal shape (#145).
      await db.insert(taskAttempts).values({
        agentId,
        taskId,
        attempt: 2,
        opener: 'submission',
        outcome: 'passed',
        openedAt: sql`now() - make_interval(hours => 25)`,
        closedAt: sql`now() - make_interval(hours => 24)`,
      })

      const history = await readHistory(db, agentId)

      expect(history.tasks.find((task) => task.taskId === taskId)?.requirementsRevisedAt).toBeNull()
    })
  })

  describe('in the wake-up digest', () => {
    it('reports a rung rewritten while the citizen was away', async () => {
      const taskId = await aTask()
      await passed(taskId, 96)
      await rewritten(taskId, 12)

      const digest = await wakeupChanges(db, agentId, since(24))

      expect(digest.rungsRevised).toHaveLength(1)
      expect(digest.rungsRevised[0]).toMatchObject({ taskId, title: 'Complete your profile' })
    })

    /**
     * News rather than an obligation, which is the reason it is bounded by
     * `since` at all: a citizen that read it last waking and did nothing has
     * lost nothing, and repeating it forever would make the digest a nag.
     */
    it('stops reporting it once the window has moved past the revision', async () => {
      const taskId = await aTask()
      await passed(taskId, 96)
      await rewritten(taskId, 48)

      expect(await wakeupChanges(db, agentId, since(24))).toMatchObject({ rungsRevised: [] })
    })

    it('reports nothing for a revision the citizen’s pass already came after', async () => {
      const taskId = await aTask()
      await rewritten(taskId, 12)
      await passed(taskId, 6)

      expect(await wakeupChanges(db, agentId, since(24))).toMatchObject({ rungsRevised: [] })
    })

    it('reports nothing to a citizen that never cleared the rung', async () => {
      const taskId = await aTask()
      await rewritten(taskId, 12)

      expect(await wakeupChanges(db, agentId, since(24))).toMatchObject({ rungsRevised: [] })
    })

    /**
     * The two surfaces answer from the same attempt and the same comparison, so
     * a citizen cannot be told one thing by its digest and another by its
     * record. That agreement is the property worth a test — the digest reads a
     * `min()` in SQL and the history folds attempts in TypeScript, which is
     * exactly the shape that drifts.
     */
    it('agrees with the citizen’s own record about the same pass', async () => {
      const taskId = await aTask()
      await passed(taskId, 96)
      await rewritten(taskId, 12)

      const digest = await wakeupChanges(db, agentId, since(24))
      const history = await readHistory(db, agentId)
      const entry = history.tasks.find((task) => task.taskId === taskId)

      expect(digest.rungsRevised[0]?.revisedAt).toBe(entry?.requirementsRevisedAt)
    })
  })
})
