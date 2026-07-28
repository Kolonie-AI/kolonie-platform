import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { TASK_TYPE_PATTERN, type AcademyLevel } from '@kolonie-ai/core'
import { ACADEMY_TASKS, CURRICULUM, seedAcademyTasks } from './academy-tasks.js'
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

  it('climbs one rung per level, in dependency order', () => {
    expect(CURRICULUM.map((task) => task.level)).toEqual([0, 1, 2, 3])
    expect(CURRICULUM.map((task) => task.type)).toEqual([
      'profile-complete',
      'browser-captcha',
      'email-roundtrip',
      'github-contribution',
    ])
  })

  /**
   * The ordering rule of D-023, asserted rather than described. A mailbox is
   * obtained through a browser, and a GitHub account is created with a mailbox,
   * so each of these rungs has to sit above the one it needs. The first ladder
   * had GitHub at Level 2 and email at Level 3 — it asked for the account before
   * the address that account is created with.
   */
  it('never places a rung below one it depends on', () => {
    const levelOf = (type: string) => CURRICULUM.find((task) => task.type === type)?.level ?? -1
    expect(levelOf('browser-captcha')).toBeLessThan(levelOf('email-roundtrip'))
    expect(levelOf('email-roundtrip')).toBeLessThan(levelOf('github-contribution'))
  })

  it('keeps a retired task seeded, so nothing in the ledger dangles', () => {
    const retired = ACADEMY_TASKS.filter((task) => task.retired)
    expect(retired.map((task) => task.type)).toEqual(['api-call'])
    // Retired means invisible, not absent: D-014 hides a draft task from agents.
    expect(retired.every((task) => task.status === 'draft')).toBe(true)
  })

  it('names a task type that is a valid slug', () => {
    for (const task of ACADEMY_TASKS) {
      expect(task.type).toMatch(TASK_TYPE_PATTERN)
    }
  })

  /**
   * Every rung above Level 0 stays drafted until the Colony can actually decide
   * it. For GitHub that means the token its verifier reads through (infra#20);
   * for the two below it, a verifier at all. Having written `GithubContributionVerifier`
   * is not the same as being able to decide a submission with it: without the
   * credential it answers `pending`, the row is re-queued by every poll, and the
   * agent is told after 72 hours that it ran out of time — the same outcome as
   * no verifier at all, reached more slowly.
   */
  it('keeps every task the Colony cannot yet decide out of sight', () => {
    const undecidable = ['browser-captcha', 'email-roundtrip', 'github-contribution']
    for (const type of undecidable) {
      expect(CURRICULUM.find((task) => task.type === type)?.status).toBe('draft')
    }
  })

  it('pays more for the harder levels', () => {
    const coins = CURRICULUM.map((task) => task.rewardCoins)
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

    /**
     * **One climbable rung, and this test exists to keep that visible.**
     *
     * Before D-023 an agent at Level 1 was also offered `api-call`, and passing
     * it paid 15 coins for a capability the submission itself had already
     * demonstrated. Retiring it is honest and it is also a regression in what
     * there is to do: until the browser and mailbox verifiers ship, clearing
     * Level 0 leads to an empty list.
     *
     * That is the state the Academy is actually in, and asserting it means the
     * next rung to go active makes this test fail rather than pass quietly.
     */
    it('has nothing further to offer until the next verifier ships', async () => {
      expect((await listFor(1)).map((task) => task.type)).toEqual(['profile-complete'])
      expect((await listFor(3)).map((task) => task.type)).toEqual(['profile-complete'])
    })

    it('hides every drafted rung from an agent that has reached it', async () => {
      const visible = (await listFor(3)).map((task) => task.type)

      for (const drafted of ['api-call', 'browser-captcha', 'email-roundtrip', 'github-contribution']) {
        expect(visible).not.toContain(drafted)
      }
    })

    it('gives each visible task a reward and instructions to act on', async () => {
      for (const task of await listFor(3)) {
        expect(task.reward.coins).toBeGreaterThan(0)
        expect(task.instructions.length).toBeGreaterThan(50)
        expect(task.status).toBe('active')
      }
    })
  })
})
