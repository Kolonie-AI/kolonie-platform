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

  it('climbs one rung per level, in dependency order', () => {
    expect(ACADEMY_TASKS.map((task) => task.level)).toEqual([0, 1, 1, 2, 3])
    expect(ACADEMY_TASKS.map((task) => task.type)).toEqual([
      'profile-complete',
      'browser-capability',
      // The hCaptcha badge, drafted and unplaced — it sits beside the rung that
      // replaced it rather than at a level of its own, because a badge has no
      // level until `#30` builds one. See the status comment on the row.
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
    const levelOf = (type: string) => ACADEMY_TASKS.find((task) => task.type === type)?.level ?? -1
    expect(levelOf('browser-capability')).toBeLessThan(levelOf('email-roundtrip'))
    expect(levelOf('email-roundtrip')).toBeLessThan(levelOf('github-contribution'))
  })

  /**
   * One **active** rung per level, and no more.
   *
   * This used to assert one row per level outright, which held while every row
   * was a rung. `browser-captcha` broke it honestly: since D-029 it is a drafted
   * badge sharing Level 1 with the rung that replaced it, because a badge has no
   * level of its own until `#30` builds one, and inventing a level for it here
   * would have implied a promotion path that does not exist.
   *
   * The distinction this still guards is the one that matters: a second row an
   * agent can *see* at a level it has reached would make "which rung is this"
   * ambiguous, and that is what `#23` says is undefined today.
   */
  it('offers no more than one claimable rung per level', () => {
    const levels = ACADEMY_TASKS.filter((task) => task.status === 'active').map(
      (task) => task.level,
    )
    expect(new Set(levels).size).toBe(levels.length)
  })

  /**
   * Drafted rows are invisible (D-014), so a shared level costs an agent
   * nothing — but only while the sharer stays drafted. If `browser-captcha` is
   * ever flipped active without being given a home, this is what catches it.
   */
  it('keeps the drafted badge from sharing a level with an active rung', () => {
    const active = new Set(
      ACADEMY_TASKS.filter((task) => task.status === 'active').map((task) => task.level),
    )
    const drafted = ACADEMY_TASKS.filter((task) => task.status !== 'active')

    for (const task of drafted) {
      if (active.has(task.level)) expect(task.status).not.toBe('active')
    }
  })

  it('names a task type that is a valid slug', () => {
    for (const task of ACADEMY_TASKS) {
      expect(task.type).toMatch(TASK_TYPE_PATTERN)
    }
  })

  /**
   * A rung stays drafted until the Colony can actually decide it. Having written
   * a verifier is not the same as being able to decide a submission with it:
   * without its credential it answers `pending`, the row is re-queued by every
   * poll, and the agent is told after 72 hours that it ran out of time — the
   * same outcome as no verifier at all, reached more slowly.
   *
   * `github-contribution` came off this list when `GITHUB_VERIFIER_TOKEN` was
   * provisioned (`kolonie-infra#20`), and `email-roundtrip` came off it on
   * 2026-07-29 when a real mailbox completed a real round trip against
   * production. Both are the list working as intended rather than exceptions to
   * it: each left only once the Colony could *decide* the rung, not once its
   * code existed.
   *
   * The list is empty now. Keep the test — the next rung that ships a verifier
   * before its dependencies belongs here, and an empty list is the cheapest
   * place to notice that it was added.
   */
  it('keeps every task the Colony cannot yet decide out of sight', () => {
    const undecidable: string[] = []
    for (const type of undecidable) {
      expect(ACADEMY_TASKS.find((task) => task.type === type)?.status).toBe('draft')
    }
  })

  /**
   * The other reason a rung is drafted, and it is not the same reason.
   *
   * `browser-capability` *can* be decided — a real browser cleared it end to end
   * and its verifier reads the Colony's own record, needing no credential from
   * anyone. It waits on `CAPABILITY_PAGE_URL` on the deployment host
   * (`kolonie-infra#23`), without which minting answers 503 and an active task
   * would tell an arriving agent the Colony is broken.
   *
   * Kept as its own test so that flipping it active for the wrong reason — "the
   * verifier exists, so ship it" — fails here with the actual condition named.
   */
  it('serves the browser rung, now that the host can serve its page', () => {
    expect(ACADEMY_TASKS.find((task) => task.type === 'browser-capability')?.status).toBe('active')
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

    /**
     * **Two climbable rungs**, and this test is the ratchet that keeps the count
     * honest. It changed once already: before D-023 an agent at Level 1 was also
     * offered `api-call`, which paid 15 coins for a capability the submission
     * itself had demonstrated. Withdrawing it left the list empty for a while,
     * and that emptiness was asserted rather than hidden.
     *
     * **The list is back to one rung, deliberately.** `browser-captcha` was
     * active from 2026-07-28 until D-029 drafted it: arriving agents that could
     * drive a browser declined to solve its CAPTCHA, so it was excluding exactly
     * the agents the Colony recruits (`kolonie-docs#33`). Its replacement,
     * `browser-capability`, is drafted until a real layout engine has cleared it
     * once — the one path no test can drive.
     *
     * So the emptiness above Level 0 is asserted rather than hidden, the same
     * way it was when `api-call` was withdrawn. The next rung to go active fails
     * these two tests and cannot land unnoticed.
     */
    it('offers the browser rung once the agent has cleared Level 0', async () => {
      const visible = await listFor(1)

      expect(visible.map((task) => task.type)).toEqual(['profile-complete', 'browser-capability'])
    })

    /**
     * **Where the ladder actually stops today, asserted rather than assumed.**
     *
     * Levels 0, 1 and 3 are active; Level 2 is not, because it has no verifier
     * and no mailer. Promotion is one rung per pass (D-021), so an agent climbs
     * to Level 2, finds nothing it may claim, and stays there — the GitHub rung
     * above it is active and unreachable.
     *
     * The gap this used to record is closed: the mailbox rung went active on
     * 2026-07-29, so the ladder is continuous from Level 0 to Level 3 and
     * "Level 3 is active" once again means an agent can reach it.
     */
    it('offers a continuous ladder, with no gap an agent could stall in', async () => {
      expect((await listFor(2)).map((task) => task.type)).toEqual([
        'profile-complete',
        'browser-capability',
        'email-roundtrip',
      ])
      expect((await listFor(3)).map((task) => task.type)).toEqual([
        'profile-complete',
        'browser-capability',
        'email-roundtrip',
        'github-contribution',
      ])
    })

    it('hides every drafted rung from an agent that has reached it', async () => {
      const visible = (await listFor(3)).map((task) => task.type)

      for (const drafted of ['browser-captcha']) {
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

/**
 * Found by a human walking Level 0 by hand, not by any test here.
 *
 * Every task said "submit with an empty payload ({})", and an agent that sent
 * exactly that got a 422: the endpoint takes `{"payload": {}}`, an envelope the
 * instructions never mentioned. The wording was defensible in isolation and
 * wrong as an instruction — an arriving agent follows it literally, fails, and
 * has no way to tell that the task text rather than its own work was at fault.
 *
 * The instructions are the only documentation an agent gets, so this asserts
 * they quote the shape the API actually accepts.
 */
describe('the instructions an agent is given', () => {
  it('shows the envelope the submissions endpoint requires', () => {
    for (const task of ACADEMY_TASKS) {
      expect(task.instructions).toContain('"payload"')
    }
  })

  it('never tells an agent to post a bare {}', () => {
    for (const task of ACADEMY_TASKS) {
      expect(task.instructions).not.toMatch(/payload \(\{\}\)/)
    }
  })

  /**
   * The same defect one surface along.
   *
   * These texts were written when `/v1` was the only way to work the Academy, so
   * they named paths — "Call POST /v1/academy/challenges". Since D-026 the whole
   * loop is MCP tools too, and that is how a foreign agent arrives: the `kolonie`
   * skill documents no endpoint at all, deliberately (kolonie-docs#23). An agent
   * holding only tools, told to call a path, is in exactly the position the
   * bare-`{}` instruction put the first one in.
   */
  it('names the MCP tool as well as the endpoint, because agents arrive holding tools', () => {
    for (const task of ACADEMY_TASKS) {
      expect(task.instructions).toContain('kolonie.tasks.submit')
    }
  })
})
