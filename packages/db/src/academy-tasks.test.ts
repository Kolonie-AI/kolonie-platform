import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { arrayContains, eq } from 'drizzle-orm'
import { isKnownSkill, TASK_TYPE_PATTERN, type AgentId } from '@kolonie-ai/core'
import { ACADEMY_TASKS, seedAcademyTasks } from './academy-tasks.js'
import type { Database } from './client.js'
import { agents, agentSkills, submissions, tasks } from './schema/index.js'
import { listTasks } from './storage/tasks.js'
import { randomUUID } from 'node:crypto'
import { connectForTests, databaseTestTarget, truncateAll } from './testing.js'

const target = databaseTestTarget()

if (!target.available) {
  console.warn(`\n${target.reason}\n`)
}

/**
 * Everything the seed says about itself, checked without a database.
 *
 * These run everywhere, including on a machine with no Postgres, because a typo
 * in a task id or a skill slug no task grants is not a storage problem and
 * should not need storage to be caught.
 */
describe('the Academy task definitions', () => {
  it('gives every task a distinct, fixed id', () => {
    const ids = new Set(ACADEMY_TASKS.map((task) => task.id))
    expect(ids.size).toBe(ACADEMY_TASKS.length)
  })

  it('lists the graph the curriculum describes', () => {
    expect(ACADEMY_TASKS.map((task) => task.type)).toEqual([
      'profile-complete',
      'browser-capability',
      // The second root of the first frontier, and the branch for an agent that
      // cannot drive a browser (#36).
      'key-signature',
      // The third root, and the second an agent with no browser can take (#37).
      // It is the only task that asks the agent to spend a resource of its own.
      'proof-of-work',
      // The hCaptcha badge. It sits next to the rung it shares a page with
      // because it opens nothing of its own: it requires `browser` and grants
      // nothing.
      'browser-captcha',
      'email-roundtrip',
      // Split from `github-contribution` on 2026-07-29 (D-031): controlling an
      // account is the skill, contributing is what an agent does with one.
      'github-account',
      'github-contribution',
    ])
  })

  /**
   * The vocabulary check, and the reason it is worth a test: a typo in a skill
   * slug fails nothing at run time. The row would simply require a capability no
   * task grants, and would never be listed to anybody — a task that has silently
   * left the Academy, with no error anywhere to say so.
   */
  it('names only skills the Colony knows, on every edge', () => {
    for (const task of ACADEMY_TASKS) {
      for (const skill of [...task.requires, ...task.suggests, ...task.grants]) {
        expect(isKnownSkill(skill), `${task.type} names an unknown skill: ${skill}`).toBe(true)
      }
    }
  })

  /**
   * `profile` is the one chokepoint in the graph, on purpose: it is free,
   * self-service, contacts no third party and conflicts with no policy, and it
   * is what makes every later verdict attach to an agent that is at least
   * findable.
   */
  it('roots the graph at profile-complete, and requires it almost everywhere', () => {
    const root = ACADEMY_TASKS.find((task) => task.type === 'profile-complete')
    expect(root?.requires).toEqual([])
    expect(root?.grants).toEqual(['profile'])

    /**
     * Reachability, computed rather than listed.
     *
     * The earlier version named the one task that required `browser` instead of
     * `profile` as an exception, which meant every new node one level deeper
     * became another exception to add by hand — and a node that was genuinely
     * unreachable would have looked exactly like one somebody forgot. So: walk
     * the graph from an agent holding nothing and take every task whose
     * requirements are already met, over and over, until nothing new opens.
     * Anything left over hangs off nothing.
     */
    const held = new Set<string>()
    const reached = new Set<string>()

    for (let opened = true; opened;) {
      opened = false
      for (const task of ACADEMY_TASKS) {
        if (reached.has(task.type)) continue
        if (!task.requires.every((skill) => held.has(skill))) continue

        reached.add(task.type)
        for (const skill of task.grants) held.add(skill)
        opened = true
      }
    }

    for (const task of ACADEMY_TASKS) {
      expect(reached.has(task.type), `${task.type} hangs off nothing`).toBe(true)
    }
  })

  /**
   * Every skill a task requires has to be granted by some task, or the row is
   * unreachable — the graph equivalent of a rung with no ladder under it.
   */
  it('leaves no required skill that nothing grants', () => {
    const granted = new Set(ACADEMY_TASKS.flatMap((task) => task.grants))

    for (const task of ACADEMY_TASKS) {
      for (const required of task.requires) {
        expect(
          granted.has(required),
          `${task.type} requires ${required}, which nothing grants`,
        ).toBe(true)
      }
    }
  })

  /**
   * The hard/soft split, asserted where it was decided.
   *
   * `github-account` **suggests** a mailbox and a browser: an account is created
   * with an address and usually through a page, so those are the route — but an
   * agent arriving with an account of its own already holds the capability, and
   * demanding a second address first would be enforcing a route it does not
   * need. Same for `email-roundtrip` and a browser. This is the whole of
   * Recognition of Prior Learning, and getting it backwards is the mistake the
   * ladder made everywhere.
   */
  it('keeps the route soft where the capability is what matters', () => {
    const github = ACADEMY_TASKS.find((task) => task.type === 'github-account')
    expect(github?.requires).toEqual(['profile'])
    expect(github?.suggests).toEqual(['mailbox', 'browser'])

    const email = ACADEMY_TASKS.find((task) => task.type === 'email-roundtrip')
    expect(email?.requires).toEqual(['profile'])
    expect(email?.suggests).toEqual(['browser'])
  })

  /**
   * The badge, and the rule it exists to respect: a task that may need an
   * operator grants nothing (`academy.md`). Its whole safety comes from
   * `grants: []` — declining it costs an agent nothing because there is no rung
   * behind it.
   */
  it('makes the CAPTCHA task a badge that opens nothing', () => {
    const badge = ACADEMY_TASKS.find((task) => task.type === 'browser-captcha')

    expect(badge?.requires).toEqual(['browser'])
    expect(badge?.grants).toEqual([])
    expect(badge?.status).toBe('active')

    for (const task of ACADEMY_TASKS) {
      expect(task.requires).not.toContain('captcha')
    }
  })

  /** A citizen-authored task may require any skill and must grant none. */
  it('mints skills only from Colony-authored rows', () => {
    // Every row here is the Colony's — `created_by` is null for all of them, and
    // the database refuses the other combination. This asserts the seed never
    // starts down that path.
    expect(ACADEMY_TASKS.some((task) => task.grants.length > 0)).toBe(true)
  })

  it('gives the badge no advantage over the rung it sits beside', () => {
    const badge = ACADEMY_TASKS.find((task) => task.type === 'browser-captcha')
    const rung = ACADEMY_TASKS.find((task) => task.type === 'browser-capability')

    // At least what the browser rung pays: harder, and it advances nothing.
    expect(badge?.rewardCoins).toBeGreaterThanOrEqual(rung?.rewardCoins ?? 0)
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

  /**
   * **Granting tasks** pay more the further into the graph they sit. Badges are
   * exempt, and that is the point of them rather than an inconsistency: what a
   * badge pays is a judgement about the work, not a position in an order it does
   * not advance. `github-contribution` sits last and pays least of all, because
   * it opens nothing and `kolonie-docs#29` has not decided what it is worth.
   */
  it('pays more the further into the graph a granting task sits', () => {
    const coins = ACADEMY_TASKS.filter((task) => task.grants.length > 0).map(
      (task) => task.rewardCoins,
    )

    expect(coins).toEqual([...coins].sort((a, b) => a - b))
    expect(ACADEMY_TASKS.every((task) => task.rewardCoins > 0)).toBe(true)
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

  let agentId: AgentId

  /** An agent holding exactly the skills named, and nothing else. */
  const anAgentHolding = async (...skills: string[]): Promise<AgentId> => {
    const [agent] = await db
      .insert(agents)
      .values({ name: `canary-${randomUUID()}`, platform: 'openclaw' })
      .returning({ id: agents.id })
    if (agent === undefined) throw new Error('inserting an agent returned no row')

    for (const skill of skills) {
      // Through a passed submission, because that is the only provenance
      // `agent_skills` accepts. The task it is attached to is whichever seeded
      // row grants the skill, so the fixture stays honest about where a
      // capability comes from.
      const [task] = await db
        .select({ id: tasks.id })
        .from(tasks)
        .where(arrayContains(tasks.grantsSkills, [skill]))
      if (task === undefined) throw new Error(`nothing in the Academy grants ${skill}`)

      const [submission] = await db
        .insert(submissions)
        .values({
          taskId: task.id,
          agentId: agent.id,
          payload: {},
          attempt: 1,
          status: 'passed',
          verifiedAt: new Date().toISOString(),
        })
        .returning({ id: submissions.id })
      if (submission === undefined) throw new Error('inserting a submission returned no row')

      await db
        .insert(agentSkills)
        .values({ agentId: agent.id, skill, submissionId: submission.id })
        .onConflictDoNothing()
    }

    return agent.id as AgentId
  }

  const listFor = async (holder: AgentId) => {
    const result = await listTasks(db, { agentId: holder, availableOnly: true, limit: 50 })
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
   * The point of the original issue: `GET /v1/tasks` had nothing to return, so
   * the MVP loop broke at step two. Since D-030 it also asserts the shape of the
   * graph — what the Colony opens, and when.
   */
  describe('what an agent then sees', () => {
    beforeEach(async () => {
      await seedAcademyTasks(db)
      agentId = await anAgentHolding()
    })

    it('offers a freshly registered agent exactly the one root task', async () => {
      expect((await listFor(agentId)).map((task) => task.type)).toEqual(['profile-complete'])
    })

    /**
     * **The first frontier is deliberately wide**, and it got wider with the
     * keypair rung (#36). Holding `profile` alone opens several tasks at once,
     * and that is the change the whole model was made for: an agent picks the
     * branch its own shape allows instead of being handed one next rung.
     *
     * `key-signature` is the one that matters most in this list. It is the
     * branch an agent with no browser takes, so before it existed an agent that
     * could not render a page was finished after one task.
     */
    it('opens every root task at once to an agent holding profile', async () => {
      const visible = await listFor(await anAgentHolding('profile'))

      expect(visible.map((task) => task.type)).toEqual([
        'profile-complete',
        'browser-capability',
        'key-signature',
        'proof-of-work',
        'email-roundtrip',
        'github-account',
      ])
    })

    /**
     * The soft edge, which is the whole point of it: an agent that arrives with
     * a GitHub account of its own does not have to obtain a mailbox from us
     * first. `github-account` suggests `mailbox` and `browser` and requires
     * neither, so an agent holding only `profile` can start it.
     */
    it('lets an agent with neither mailbox nor browser prove a GitHub account', async () => {
      const visible = await listFor(await anAgentHolding('profile'))

      expect(visible.map((task) => task.type)).toContain('github-account')
    })

    /**
     * And the hard edge the split created (D-031). There is no way to contribute
     * from an account without controlling one, so the badge waits behind the
     * skill rather than failing an agent for something it could have been told.
     */
    it('keeps the contribution badge behind the account it needs', async () => {
      expect(
        (await listFor(await anAgentHolding('profile'))).map((task) => task.type),
      ).not.toContain('github-contribution')

      const certified = await anAgentHolding('profile', 'github')
      expect((await listFor(certified)).map((task) => task.type)).toContain('github-contribution')
    })

    it('keeps the badge shut until the browser skill is held', async () => {
      expect(
        (await listFor(await anAgentHolding('profile'))).map((task) => task.type),
      ).not.toContain('browser-captcha')

      const capable = await anAgentHolding('profile', 'browser')
      expect((await listFor(capable)).map((task) => task.type)).toContain('browser-captcha')
    })

    it('gives each visible task a reward and instructions to act on', async () => {
      for (const task of await listFor(await anAgentHolding('profile', 'browser'))) {
        expect(task.reward.coins).toBeGreaterThan(0)
        expect(task.instructions.length).toBeGreaterThan(50)
        expect(task.status).toBe('active')
      }
    })

    it('stores the edges the definition declares', async () => {
      const rows = await db.select().from(tasks)
      for (const definition of ACADEMY_TASKS) {
        const row = rows.find((candidate) => candidate.id === definition.id)
        expect(row?.requiresSkills).toEqual([...definition.requires])
        expect(row?.suggestsSkills).toEqual([...definition.suggests])
        expect(row?.grantsSkills).toEqual([...definition.grants])
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

  /**
   * The same rule for the steps *before* the submission, and it is the one the
   * test above did not catch.
   *
   * The mailbox rung shipped with three HTTP endpoints and no tools (#26), and
   * its instructions named only paths — so an agent that had climbed two rungs
   * through tools was told, mid-Academy, to build an HTTP client (#38). The
   * assertion is therefore about the Academy's *own* routes: a task that sends
   * an agent to `/v1/academy/...` has to name the tool that does the same thing,
   * because a rung only `/v1` can reach is a rung foreign agents do not have
   * (D-026).
   */
  it('names an Academy tool wherever it names an Academy endpoint', () => {
    for (const task of ACADEMY_TASKS) {
      if (!task.instructions.includes('/v1/academy/')) continue
      expect(task.instructions).toContain('kolonie.academy.')
    }
  })
})
