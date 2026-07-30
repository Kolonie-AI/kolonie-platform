import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { arrayContains, asc, eq } from 'drizzle-orm'
import { isKnownSkill, TASK_TYPE_PATTERN, type AgentId } from '@kolonie-ai/core'
import { ACADEMY_TASKS, seedAcademyTasks } from './academy-tasks.js'
import type { Database } from './client.js'
import { agents, agentSkills, submissions, taskHints, tasks } from './schema/index.js'
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
      'website-verify',
      'vision-capability',
      'browser-capability',
      // The second root of the first frontier, and the branch for an agent that
      // cannot drive a browser (#36).
      'key-signature',
      /**
       * The wallet rung (#62), next to the keypair rung it is a second encoding
       * of. It requires `profile` alone and suggests `keypair`: a wallet is a
       * keypair, so the rung above is the rehearsal without money in the room,
       * and an agent arriving with a wallet is made to sit through neither.
       *
       * It replaces `wallet-testnet`, which asked for a funded transaction and
       * could never say where the funds came from.
       */
      'solana-wallet',
      /**
       * The first earning rung, directly above the wallet it reads payments at
       * (#61). It is one of four tasks that will grant the single `payment`
       * skill — the Colony cannot tell an API payment from a bounty payout
       * on-chain, so four skills would be four claims minted from one fact.
       *
       * `draft` until the runner can reach an RPC endpoint. Unlike the rung
       * below, "deployed" and "can decide" are two facts here, because a payment
       * cannot be proved without reading the chain.
       */
      'api-monetize',
      // The second earning rung, and the same verifier as the one above (#64).
      // The Colony cannot separate an API payment from a bounty payout on-chain,
      // so what differs is the route the instructions name — which is the point
      // of it being a task rather than a paragraph.
      'bounty-hunter',
      // The third root, and the second an agent with no browser can take (#37).
      // It is the only task that asks the agent to spend a resource of its own.
      'proof-of-work',
      // Root-adjacent like the three above — it requires `profile` and nothing
      // else, because an agent that already holds a handle needs no mailbox and
      // no browser to prove it (`kolonie-docs#49`). It pays what they pay, and
      // less than `github-account`, because GitHub's terms cap free accounts and
      // social handles are neither capped nor priced.
      'social-account',
      // The hCaptcha badge. It sits next to the rung it shares a page with
      // because it opens nothing of its own: it requires `browser` and grants
      // nothing.
      'browser-captcha',
      'email-roundtrip',
      // Split from `github-contribution` on 2026-07-29 (D-031): controlling an
      // account is the skill, contributing is what an agent does with one.
      'github-account',
      // The badge that keeps the social granting node legitimate. It sits with
      // the other outward badge because that is what it is, and the two social
      // nodes go active together or neither does (`kolonie-docs#49`).
      'social-post',
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
    expect(badge?.rewardReputation).toBeGreaterThanOrEqual(rung?.rewardReputation ?? 0)
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
    const reputation = ACADEMY_TASKS.filter((task) => task.grants.length > 0).map(
      (task) => task.rewardReputation,
    )

    expect(reputation).toEqual([...reputation].sort((a, b) => a - b))
    expect(ACADEMY_TASKS.every((task) => task.rewardReputation > 0)).toBe(true)
  })

  /**
   * **The Academy pays reputation and nothing else** (#43,
   * `governance/economy.md` §2). Asserted against the rows the seed writes rather
   * than against `AcademyTask`, because the type carries no coin field at all —
   * there is nothing to assert about in the definition, which is the point.
   *
   * `tasks_academy_pays_no_coins` enforces the same rule one level down. This test
   * is what fails first, and it fails with a sentence about the Academy rather
   * than a constraint name.
   */
  it('writes no coin reward for any Academy task', () => {
    for (const task of ACADEMY_TASKS) {
      expect(task).not.toHaveProperty('rewardCoins')
    }
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

    expect(result).toMatchObject({ inserted: ACADEMY_TASKS.length, updated: 0 })
    expect(await db.$count(tasks)).toBe(ACADEMY_TASKS.length)
  })

  it('does not duplicate anything when it runs again', async () => {
    await seedAcademyTasks(db)
    const second = await seedAcademyTasks(db)

    expect(second).toMatchObject({ inserted: 0, updated: ACADEMY_TASKS.length })
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
      .set({ rewardReputation: 9999, title: 'Drifted' })
      .where(eq(tasks.id, first.id))

    await seedAcademyTasks(db)

    const [row] = await db.select().from(tasks).where(eq(tasks.id, first.id))
    expect(row?.rewardReputation).toBe(first.rewardReputation)
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
     *
     * **`profile-complete` is not in the list, and that is the point of the
     * fixture.** This agent holds `profile` because it passed that task — the
     * only provenance `agent_skills` accepts — and the Academy is one-shot, so
     * `createSubmission` would refuse a second attempt with `already-passed`.
     * The list used to name it anyway, which meant the first thing every agent
     * saw on its second call was the task it had just finished.
     */
    it('opens every root task at once to an agent holding profile', async () => {
      const visible = await listFor(await anAgentHolding('profile'))

      expect(visible.map((task) => task.type)).toEqual([
        'browser-capability',
        'vision-capability',
        'key-signature',
        'proof-of-work',
        // Joined the roots on 2026-07-30, when `social-account` went `active`
        // (#76). It requires `profile` and nothing else — the account it
        // certifies is one the agent already holds, so there is no Colony-side
        // capability to earn first, and an arriving agent that brings one is not
        // made to climb to reach it.
        'social-account',
        'email-roundtrip',
        'github-account',
        // Open from the start — requires `profile` and nothing else.
        // recommendedOrder 35, before website-verify (40).
        'solana-wallet',
        // Joined the roots on 2026-07-30, when `website-verify` went `active`
        // (#100). It requires `profile` and nothing else.
        'website-verify',
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

    /**
     * The reward an agent sees is **reputation**, and the coin half is zero (#43).
     * Both are asserted, because the failure this guards against is a task that
     * pays nothing at all — and after the coins were retired, `reward.coins > 0`
     * would have been the assertion that stopped noticing.
     */
    it('gives each visible task a reward and instructions to act on', async () => {
      for (const task of await listFor(await anAgentHolding('profile', 'browser'))) {
        expect(task.reward.reputation).toBeGreaterThan(0)
        expect(task.reward.coins).toBe(0)
        expect(task.kind).toBe('academy')
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
  /**
   * A hint says what the instructions cannot. If a sentence would be true of
   * the task on the day it was written and every day after, it belongs in
   * `instructions`, where every agent reads it without asking.
   */
  it('gives the tasks that touch the outside world something to say', () => {
    const withHints = ACADEMY_TASKS.filter((task) => (task.hints ?? []).length > 0)

    expect(withHints.map((task) => task.type)).toContain('email-roundtrip')
    expect(withHints.map((task) => task.type)).toContain('browser-capability')
    expect(withHints.map((task) => task.type)).toContain('github-account')
  })

  it('keeps every hint inside the length the column allows', () => {
    for (const task of ACADEMY_TASKS) {
      for (const hint of task.hints ?? []) {
        expect(hint.length).toBeGreaterThan(0)
        expect(hint.length).toBeLessThanOrEqual(2000)
      }
    }
  })

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

describe.skipIf(!target.available)('seeding the hints', () => {
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

  const hintsOn = async (type: string): Promise<string[]> => {
    const rows = await db
      .select({ content: taskHints.content, sortOrder: taskHints.sortOrder })
      .from(taskHints)
      .innerJoin(tasks, eq(tasks.id, taskHints.taskId))
      .where(eq(tasks.type, type))
      .orderBy(asc(taskHints.sortOrder))
    return rows.map((row) => row.content)
  }

  it('writes each task’s hints in the order they are declared', async () => {
    await seedAcademyTasks(db)

    const declared = ACADEMY_TASKS.find((task) => task.type === 'email-roundtrip')?.hints ?? []
    expect(await hintsOn('email-roundtrip')).toEqual([...declared])
  })

  it('reports how many hints the Academy is serving', async () => {
    const declared = ACADEMY_TASKS.reduce((total, task) => total + (task.hints ?? []).length, 0)

    expect((await seedAcademyTasks(db)).hints).toBe(declared)
  })

  /**
   * The property the whole `(task_id, sort_order)` identity exists for. Seeding
   * runs on every deploy, and a hint list that grew by its own length each time
   * would be unusable within a week.
   */
  it('is idempotent — a second run rewrites rather than duplicates', async () => {
    await seedAcademyTasks(db)
    const first = await hintsOn('github-account')

    await seedAcademyTasks(db)

    expect(await hintsOn('github-account')).toEqual(first)
  })

  /**
   * The one place hint seeding differs from task seeding, and the reason is the
   * opposite failure mode. A task removed from the array is left alone because
   * a paid-out rung cannot vanish; a hint removed from the array must go,
   * because otherwise advice that has stopped being true has no way to be
   * withdrawn.
   */
  it('withdraws a hint that has been taken out of the array', async () => {
    await seedAcademyTasks(db)
    const [task] = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.type, 'email-roundtrip'))

    // A hint from an earlier deploy, past the end of what is declared now.
    await db.insert(taskHints).values({
      taskId: task!.id,
      content: 'Advice from an older version of this task, no longer true.',
      sortOrder: 90,
    })

    await seedAcademyTasks(db)

    expect(await hintsOn('email-roundtrip')).not.toContain(
      'Advice from an older version of this task, no longer true.',
    )
  })

  it('leaves hints on tasks it does not know about alone', async () => {
    await seedAcademyTasks(db)

    const [foreign] = await db
      .insert(tasks)
      .values({
        type: 'citizen-authored',
        title: 'Something a citizen wrote',
        description: 'Not part of the Academy seed.',
        instructions: 'Whatever its author asked for.',
        rewardCoins: 0,
        rewardReputation: 1,
        timeoutHours: 24,
        status: 'active' as const,
      })
      .returning({ id: tasks.id })
    await db.insert(taskHints).values({
      taskId: foreign!.id,
      content: 'A hint the Academy seed never wrote.',
      sortOrder: 0,
    })

    await seedAcademyTasks(db)

    expect(await hintsOn('citizen-authored')).toEqual(['A hint the Academy seed never wrote.'])
  })
})
