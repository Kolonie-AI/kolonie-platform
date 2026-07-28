import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { TASK_TYPE_PATTERN, type AcademyLevel } from '@kolonie-ai/core'
import { ACADEMY_TASKS, seedAcademyTasks } from './academy-tasks.js'
import type { Database } from './client.js'
import { tasks } from './schema/index.js'
import { listTasks } from './storage/tasks.js'
import { connectForTests, databaseTestTarget, truncateAll } from './testing.js'

const target = databaseTestTarget()

if (!target.available) {
  console.warn(`\n${target.reason}\n`)
}

/**
 * Everything the seed says about itself, checked without a database.
 *
 * These run everywhere, including on a machine with no Postgres, because a typo
 * in a task id or a level outside the ladder is not a storage problem and should
 * not need storage to be caught.
 */
describe('the Academy task definitions', () => {
  it('gives every task a distinct, fixed id', () => {
    const ids = new Set(ACADEMY_TASKS.map((task) => task.id))
    expect(ids.size).toBe(ACADEMY_TASKS.length)
  })

  it('covers Levels 0 to 2, one task each', () => {
    expect(ACADEMY_TASKS.map((task) => task.level)).toEqual([0, 1, 2])
  })

  it('names a task type that is a valid slug', () => {
    for (const task of ACADEMY_TASKS) {
      expect(task.type).toMatch(TASK_TYPE_PATTERN)
    }
  })

  /**
   * The Level 2 task ships as a draft because no verifier answers
   * `github-contribution` yet (#19). An active task with no verifier is listed,
   * attempted, and then timed out on an agent that did the work correctly.
   */
  it('keeps a task without a deployed verifier out of sight', () => {
    const level2 = ACADEMY_TASKS.find((task) => task.level === 2)
    expect(level2?.type).toBe('github-contribution')
    expect(level2?.status).toBe('draft')
  })

  it('pays more for the harder levels', () => {
    const coins = ACADEMY_TASKS.map((task) => task.rewardCoins)
    expect(coins).toEqual([...coins].sort((a, b) => a - b))
    expect(coins.every((amount) => amount > 0)).toBe(true)
  })
})

describe.skipIf(!target.available)('seeding the Academy', () => {
  let db: Database

  beforeAll(async () => {
    if (!target.available) return
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
  })

  const listFor = async (level: AcademyLevel) => {
    const result = await listTasks(db, { maxLevel: level, availableOnly: true, limit: 50 })
    if (result.outcome !== 'listed') throw new Error(result.outcome)
    return result.page.items
  }

  it('inserts every task on an empty database', async () => {
    const result = await seedAcademyTasks(db)

    expect(result).toEqual({ inserted: ACADEMY_TASKS.length, updated: 0 })
    expect(await db.$count(tasks)).toBe(ACADEMY_TASKS.length)
  })

  it('does not duplicate anything when it runs again', async () => {
    await seedAcademyTasks(db)
    const second = await seedAcademyTasks(db)

    expect(second).toEqual({ inserted: 0, updated: ACADEMY_TASKS.length })
    expect(await db.$count(tasks)).toBe(ACADEMY_TASKS.length)
  })

  /**
   * The reason the seed upserts rather than inserting-if-absent: a reward or a
   * set of instructions corrected in this repository has to reach the deployed
   * Academy, and the only step that runs there is this one.
   */
  it('brings an edited task back in line with the definition', async () => {
    await seedAcademyTasks(db)
    const first = ACADEMY_TASKS[0]
    if (first === undefined) throw new Error('the Academy is empty')

    await db
      .update(tasks)
      .set({ rewardCoins: 9999, title: 'Drifted' })
      .where(eq(tasks.id, first.id))

    await seedAcademyTasks(db)

    const [row] = await db.select().from(tasks).where(eq(tasks.id, first.id))
    expect(row?.rewardCoins).toBe(first.rewardCoins)
    expect(row?.title).toBe(first.title)
  })

  /**
   * The point of the whole issue: `GET /v1/tasks` had nothing to return, so the
   * MVP loop broke at step two. This asserts the endpoint's own query, against
   * the level ceiling each arriving agent actually has.
   */
  describe('what an agent then sees', () => {
    beforeEach(async () => {
      await seedAcademyTasks(db)
    })

    it('offers a freshly registered agent exactly the Level 0 task', async () => {
      const visible = await listFor(0)

      expect(visible.map((task) => task.type)).toEqual(['profile-complete'])
    })

    it('adds Level 1 once the agent has cleared Level 0', async () => {
      const visible = await listFor(1)

      expect(visible.map((task) => task.type)).toEqual(['profile-complete', 'api-call'])
    })

    it('still hides the drafted Level 2 task from an agent that has reached it', async () => {
      const visible = await listFor(2)

      expect(visible.map((task) => task.type)).not.toContain('github-contribution')
    })

    it('gives each visible task a reward and instructions to act on', async () => {
      for (const task of await listFor(2)) {
        expect(task.reward.coins).toBeGreaterThan(0)
        expect(task.instructions.length).toBeGreaterThan(50)
        expect(task.status).toBe('active')
      }
    })
  })
})
