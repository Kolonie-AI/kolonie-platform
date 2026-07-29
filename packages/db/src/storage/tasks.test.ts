import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { TaskSchema, type AgentId, type Task, type TaskId, type TaskStatus } from '@kolonie-ai/core'
import { createDatabase, type Database } from '../client.js'
import {
  agents,
  agentSkills,
  reputationEvents,
  submissions,
  taskHints,
  tasks,
} from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { frontier, listTasks, readTask, type ListTasksQuery } from './tasks.js'

const target = databaseTestTarget()

if (!target.available) {
  console.warn(`\n${target.reason}\n`)
}

describe.skipIf(!target.available)('listTasks', () => {
  let db: Database
  let agentId: AgentId

  beforeAll(async () => {
    if (!target.available) return
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  /** One agent, because every question here is asked on somebody's behalf. */
  const anAgent = async (name: string): Promise<AgentId> => {
    const [row] = await db
      .insert(agents)
      .values({ name, platform: 'openclaw' })
      .returning({ id: agents.id })
    if (row === undefined) throw new Error('inserting an agent returned no row')
    return row.id as AgentId
  }

  beforeEach(async () => {
    await truncateAll(db)
    agentId = await anAgent('canary')
  })

  interface Seed {
    readonly title?: string
    readonly requires?: string[]
    readonly grants?: string[]
    readonly minReputation?: number
    readonly order?: number
    readonly status?: TaskStatus
    /** Set explicitly where a test is about ordering rather than about content. */
    readonly createdAt?: string
  }

  const seed = async (...seeds: Seed[]): Promise<void> => {
    await db.insert(tasks).values(
      seeds.map((task, index) => ({
        type: `academy-task-${index}`,
        requiresSkills: task.requires ?? [],
        grantsSkills: task.grants ?? [],
        minReputation: task.minReputation ?? 0,
        recommendedOrder: task.order ?? 0,
        title: task.title ?? `Task ${index}`,
        description: 'What this task is, for a human reading the catalogue.',
        instructions: 'What the agent must actually do.',
        rewardCoins: 1,
        rewardReputation: 1,
        timeoutHours: 24,
        status: task.status ?? ('active' as const),
        ...(task.createdAt === undefined ? {} : { createdAt: task.createdAt }),
      })),
    )
  }

  /**
   * Give an agent a skill the way a pass does — through a submission.
   *
   * `agent_skills.submission_id` is `not null` on purpose, so there is no way to
   * conjure a skill from nowhere, and this fixture has to build the provenance a
   * real grant has. The task it invents is `draft`, so it never turns up in a
   * list and cannot be mistaken for something a test seeded.
   */
  const grantSkill = async (holder: AgentId, skill: string): Promise<void> => {
    const [task] = await db
      .insert(tasks)
      .values({
        type: `grants-${skill}`,
        grantsSkills: [skill],
        title: `Whatever granted ${skill}`,
        description: 'The provenance a granted skill has to have.',
        instructions: 'Not listed to anyone: this row is draft.',
        rewardCoins: 1,
        rewardReputation: 1,
        timeoutHours: 24,
        status: 'draft' as const,
      })
      .returning({ id: tasks.id })
    if (task === undefined) throw new Error('inserting a task returned no row')

    const [submission] = await db
      .insert(submissions)
      .values({
        taskId: task.id,
        agentId: holder,
        payload: {},
        attempt: 1,
        status: 'passed',
        // `submissions_verified_at_matches_status` insists: a passed submission
        // has a verdict time, because a pass nobody can date is a payout nobody
        // can audit.
        verifiedAt: new Date().toISOString(),
      })
      .returning({ id: submissions.id })
    if (submission === undefined) throw new Error('inserting a submission returned no row')

    await db
      .insert(agentSkills)
      .values({ agentId: holder, skill, submissionId: submission.id })
      .onConflictDoNothing()
  }

  const earnReputation = async (holder: AgentId, delta: number): Promise<void> => {
    await db
      .insert(reputationEvents)
      .values({ agentId: holder, delta, reason: 'task_passed', memo: 'fixture' })
  }

  const list = async (query: Partial<ListTasksQuery> = {}) => {
    const result = await listTasks(db, {
      agentId,
      availableOnly: true,
      limit: 25,
      ...query,
    })
    if (result.outcome !== 'listed') throw new Error(result.outcome)
    return result.page
  }

  const titles = (items: readonly Task[]) => items.map((task) => task.title)

  it('returns the domain shape, not the row', async () => {
    await seed({})

    const { items } = await list()

    // Parsed with the core schema, so a column that drifts out of the domain
    // model fails here rather than in a foreign agent that trusted the shape.
    expect(() => items.map((task) => TaskSchema.parse(task))).not.toThrow()
    expect(items[0]?.reward).toEqual({ coins: 1, reputation: 1 })
  })

  it('is empty rather than absent when the Colony has no tasks', async () => {
    expect(await list()).toEqual({ items: [], nextCursor: null })
  })

  describe('what an agent may see', () => {
    it('hides a task whose required skill the agent does not hold', async () => {
      await seed({ title: 'Open' }, { title: 'Locked', requires: ['browser'] })

      expect(titles((await list()).items)).toEqual(['Open'])

      // Asserted against the stored rows as well: the row is there, and it is
      // the gate keeping it out of the list rather than a seed that failed.
      const stored = await db.select({ title: tasks.title }).from(tasks)
      expect(stored.map((row) => row.title).sort()).toEqual(['Locked', 'Open'])
    })

    it('opens the task the moment the skill is held', async () => {
      await seed({ title: 'Locked', requires: ['browser'] })
      expect((await list()).items).toEqual([])

      await grantSkill(agentId, 'browser')

      expect(titles((await list()).items)).toEqual(['Locked'])
    })

    it('requires every skill on the list, not any of them', async () => {
      await seed({ title: 'Two prerequisites', requires: ['profile', 'browser'] })
      await grantSkill(agentId, 'profile')

      expect((await list()).items).toEqual([])

      await grantSkill(agentId, 'browser')
      expect(titles((await list()).items)).toEqual(['Two prerequisites'])
    })

    /**
     * What the ladder could not express, asserted directly: there is no
     * ordering, so a skill earned "late" opens its task while an "earlier" one
     * stays shut.
     */
    it('has no ordering — a graph gates on what is held, not on how far along', async () => {
      await seed(
        { title: 'Needs browser', requires: ['browser'] },
        { title: 'Needs keypair', requires: ['keypair'], order: 5 },
      )
      await grantSkill(agentId, 'keypair')

      expect(titles((await list()).items)).toEqual(['Needs keypair'])
    })

    it('does not show another agent’s skills as this one’s', async () => {
      const other = await anAgent('somebody-else')
      await seed({ title: 'Locked', requires: ['browser'] })
      await grantSkill(other, 'browser')

      expect((await list()).items).toEqual([])
      expect(titles((await list({ agentId: other })).items)).toEqual(['Locked'])
    })

    it('refuses a task under the agent’s reputation floor', async () => {
      await seed({ title: 'Peer review', minReputation: 10 })

      expect((await list()).items).toEqual([])

      await earnReputation(agentId, 9)
      expect((await list()).items).toEqual([])

      await earnReputation(agentId, 1)
      expect(titles((await list()).items)).toEqual(['Peer review'])
    })

    it('never shows a draft, whatever else was asked for', async () => {
      await seed({ title: 'Unfinished', status: 'draft' })

      expect((await list()).items).toEqual([])
      expect((await list({ availableOnly: false })).items).toEqual([])
    })

    it('shows a retired task only to a caller that opted out of availableOnly', async () => {
      await seed({ title: 'Live' }, { title: 'Retired', status: 'retired' })

      expect(titles((await list()).items)).toEqual(['Live'])
      expect(titles((await list({ availableOnly: false })).items).sort()).toEqual([
        'Live',
        'Retired',
      ])
    })

    it('keeps the skill gate on retired tasks: it lists what could have been started', async () => {
      await seed({ title: 'Retired and locked', requires: ['browser'], status: 'retired' })

      expect((await list({ availableOnly: false })).items).toEqual([])
    })
  })

  describe('ordering and paging', () => {
    it('follows the order the Colony recommends', async () => {
      await seed(
        { title: 'Third', order: 30 },
        { title: 'First', order: 0 },
        { title: 'Second', order: 10 },
      )

      expect(titles((await list()).items)).toEqual(['First', 'Second', 'Third'])
    })

    it('walks every task exactly once across pages', async () => {
      // Same recommended order and the same created_at, which is the case a
      // naive cursor gets wrong: without a tiebreak the order between two rows
      // is undefined, and a page boundary that lands between them repeats one
      // and loses the other.
      const sameInstant = '2026-07-28T09:00:00.000Z'
      await seed(
        ...Array.from({ length: 7 }, (_, index) => ({
          title: `Task ${index}`,
          createdAt: sameInstant,
        })),
      )

      const seen: string[] = []
      let cursor: string | null = null
      let pages = 0

      do {
        const page = await list({ limit: 2, cursor })
        seen.push(...titles(page.items))
        cursor = page.nextCursor
        pages += 1
        if (pages > 10) throw new Error('paging did not terminate')
      } while (cursor !== null)

      expect(seen).toHaveLength(7)
      expect(new Set(seen).size).toBe(7)
      expect(pages).toBe(4)
    })

    it('closes the walk with a null cursor, not an empty last page', async () => {
      await seed({}, {})

      const page = await list({ limit: 2 })

      expect(page.items).toHaveLength(2)
      expect(page.nextCursor).toBeNull()
    })

    it('does not repeat a row whose timestamp has sub-millisecond precision', async () => {
      // Postgres keeps microseconds; the domain's ISO timestamps keep
      // milliseconds. A cursor built from the rounded form points just *before*
      // the row it came from, and hands that row back on the next page.
      await seed({ title: 'First' }, { title: 'Second' })
      await db.execute(
        sql`update ${tasks} set created_at = timestamptz '2026-07-28 09:00:00.000001+00' where title = 'First'`,
      )
      await db.execute(
        sql`update ${tasks} set created_at = timestamptz '2026-07-28 09:00:00.000002+00' where title = 'Second'`,
      )

      const first = await list({ limit: 1 })
      const second = await list({ limit: 1, cursor: first.nextCursor })

      expect(titles(first.items)).toEqual(['First'])
      expect(titles(second.items)).toEqual(['Second'])
    })

    it('sees a task inserted mid-walk instead of shifting the ones behind it', async () => {
      // The reason the cursor is keyset and not an offset: a row arriving
      // between two pages must not push a task an agent has not read yet past
      // the boundary.
      await seed({ title: 'Task A', order: 0 }, { title: 'Task C', order: 20 })
      const first = await list({ limit: 1 })

      await seed({ title: 'Task B', order: 10 })
      const second = await list({ limit: 25, cursor: first.nextCursor })

      expect(titles(first.items)).toEqual(['Task A'])
      expect(titles(second.items)).toEqual(['Task B', 'Task C'])
    })
  })

  describe('a cursor the endpoint did not issue', () => {
    const rejected = async (cursor: string) =>
      (await listTasks(db, { agentId, availableOnly: true, limit: 25, cursor })).outcome

    it('is refused rather than thrown, so the route can name the field', async () => {
      expect(await rejected('not-a-cursor')).toBe('invalid-cursor')
    })

    it('is refused when it decodes but carries nonsense', async () => {
      const forged = (value: string) => Buffer.from(value, 'utf8').toString('base64url')

      expect(await rejected(forged('0|2026-07-28T09:00:00Z'))).toBe('invalid-cursor')
      expect(await rejected(forged('9999|2026-07-28T09:00:00Z|' + crypto.randomUUID()))).toBe(
        'invalid-cursor',
      )
      expect(await rejected(forged('0|not-a-time|' + crypto.randomUUID()))).toBe('invalid-cursor')
      expect(await rejected(forged('0|2026-07-28T09:00:00Z|not-a-uuid'))).toBe('invalid-cursor')
    })

    it('does not look addressable, so nobody hand-crafts one', async () => {
      await seed({}, {})

      const { nextCursor } = await list({ limit: 1 })

      expect(nextCursor).not.toBeNull()
      expect(nextCursor).not.toContain('order')
      expect(nextCursor).not.toMatch(/\d{4}-\d{2}-\d{2}/)
    })
  })

  /**
   * The half of D-030 an agent plans with. The list says what is open now; this
   * says what one more skill would open, and where that skill comes from.
   */
  describe('the frontier', () => {
    it('names the missing skill and the task that grants it', async () => {
      await seed(
        { title: 'Browser rung', grants: ['browser'], order: 10 },
        { title: 'Needs a browser', requires: ['browser'], order: 20 },
      )

      const { entries } = await frontier(db, { agentId })

      expect(entries).toHaveLength(1)
      expect(entries[0]?.task.title).toBe('Needs a browser')
      expect(entries[0]?.missingSkill).toBe('browser')
      expect(entries[0]?.grantedBy.map((task) => task.title)).toEqual(['Browser rung'])
    })

    it('leaves out a task that is two skills away', async () => {
      await seed(
        { title: 'One away', requires: ['browser'] },
        { title: 'Two away', requires: ['browser', 'mailbox'] },
      )

      const { entries } = await frontier(db, { agentId })

      expect(entries.map((entry) => entry.task.title)).toEqual(['One away'])
    })

    it('moves a task from the frontier into the list when its skill is earned', async () => {
      await seed({ title: 'Needs a browser', requires: ['browser'] })
      await grantSkill(agentId, 'browser')

      expect((await frontier(db, { agentId })).entries).toEqual([])
      expect(titles((await list()).items)).toEqual(['Needs a browser'])
    })

    it('counts only what is still missing, not everything the task requires', async () => {
      await seed({ title: 'Two prerequisites', requires: ['profile', 'browser'] })
      await grantSkill(agentId, 'profile')

      const { entries } = await frontier(db, { agentId })

      expect(entries.map((entry) => entry.missingSkill)).toEqual(['browser'])
    })

    it('says so plainly when nothing grants the missing skill yet', async () => {
      await seed({ title: 'Planned rung', requires: ['wallet'] })

      const [entry] = (await frontier(db, { agentId })).entries

      expect(entry?.missingSkill).toBe('wallet')
      expect(entry?.grantedBy).toEqual([])
    })

    it('does not name a draft task as the way to earn a skill', async () => {
      await seed(
        { title: 'Unfinished granter', grants: ['browser'], status: 'draft' },
        { title: 'Needs a browser', requires: ['browser'] },
      )

      expect((await frontier(db, { agentId })).entries[0]?.grantedBy).toEqual([])
    })

    it('leaves out a task the agent could not start even holding the skill', async () => {
      // The reputation floor is applied rather than reported: this list means
      // "earn this and you may begin", and a row that would still be refused
      // makes that sentence false.
      await seed({ title: 'Trusted work', requires: ['browser'], minReputation: 10 })

      expect((await frontier(db, { agentId })).entries).toEqual([])
    })

    it('reports the skills the caller already holds, so the answer reads alone', async () => {
      await grantSkill(agentId, 'profile')
      await grantSkill(agentId, 'browser')

      expect((await frontier(db, { agentId })).skills).toEqual(['browser', 'profile'])
    })

    it('never names a task the agent can already start', async () => {
      await seed({ title: 'Open now' })

      expect((await frontier(db, { agentId })).entries).toEqual([])
    })
  })
})

describe.skipIf(!target.available)('hints', () => {
  let db: Database
  let agentId: AgentId

  beforeAll(async () => {
    if (!target.available) return
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
    const [row] = await db
      .insert(agents)
      .values({ name: 'reader', platform: 'openclaw' })
      .returning({ id: agents.id })
    agentId = row!.id as AgentId
  })

  const aTaskWith = async (hints: string[], overrides: Record<string, unknown> = {}) => {
    const [task] = await db
      .insert(tasks)
      .values({
        type: 'email-roundtrip',
        title: 'Prove you hold a mailbox',
        description: 'Send and receive.',
        instructions: 'Write to the address you are given, then read the reply.',
        rewardCoins: 1,
        rewardReputation: 1,
        timeoutHours: 24,
        status: 'active' as const,
        ...overrides,
      })
      .returning()

    if (hints.length > 0) {
      await db
        .insert(taskHints)
        .values(hints.map((content, index) => ({ taskId: task!.id, content, sortOrder: index })))
    }
    return task!.id as TaskId
  }

  describe('reading one task', () => {
    it('finds a task the agent could not attempt', async () => {
      const taskId = await aTaskWith([], { requiresSkills: ['mailbox'] })

      const task = await readTask(db, { taskId })

      // The point of the endpoint: no skill gate. The same task would not
      // appear in `listTasks` for this agent, and asserting that here is what
      // stops the gate being copied over later by analogy.
      expect(task?.id).toBe(taskId)
      const listed = await listTasks(db, { agentId, availableOnly: true, limit: 10 })
      expect(listed.outcome === 'listed' && listed.page.items).toEqual([])
    })

    it('does not find a draft task', async () => {
      const taskId = await aTaskWith([], { status: 'draft' as const })

      expect(await readTask(db, { taskId })).toBeUndefined()
    })

    it('finds a retired task, so an old submission still resolves', async () => {
      const taskId = await aTaskWith([], { status: 'retired' as const })

      expect((await readTask(db, { taskId }))?.status).toBe('retired')
    })

    it('leaves hints off unless they were asked for', async () => {
      const taskId = await aTaskWith(['The first waypoint.'])

      expect((await readTask(db, { taskId }))?.hints).toBeUndefined()
      expect((await readTask(db, { taskId, hints: true }))?.hints).toEqual([
        { content: 'The first waypoint.', sortOrder: 0 },
      ])
    })

    it('answers an empty list for a task that has none', async () => {
      const taskId = await aTaskWith([])

      expect((await readTask(db, { taskId, hints: true }))?.hints).toEqual([])
    })

    it('returns them in the order their author wrote them', async () => {
      const taskId = await aTaskWith(['First.', 'Second.', 'Third.'])

      const task = await readTask(db, { taskId, hints: true })

      expect(task?.hints?.map((hint) => hint.content)).toEqual(['First.', 'Second.', 'Third.'])
    })
  })

  describe('listing tasks', () => {
    /**
     * The property that keeps this cheap. A hint lookup per task would turn one
     * read into as many as the page is long, and the page is what an agent polls.
     */
    it('fetches every task’s hints in one query', async () => {
      const statements: string[] = []
      const watched = createDatabase(target.available ? target.url : '', {
        max: 1,
        onnotice: () => {},
        debug: (_connection, query) => statements.push(query),
      })

      try {
        await aTaskWith(['One.'], { type: 'task-a', recommendedOrder: 1 })
        await aTaskWith(['Two.', 'Three.'], { type: 'task-b', recommendedOrder: 2 })

        statements.length = 0
        const listed = await listTasks(watched, {
          agentId,
          availableOnly: true,
          limit: 10,
          hints: true,
        })

        expect(listed.outcome === 'listed' && listed.page.items).toHaveLength(2)

        // Only what this call asked of our own tables. The driver runs a type
        // catalogue query on its first connection, which is not the subject.
        const ours = statements.filter((sql) => /"(tasks|task_hints)"/.test(sql))

        // The task query plus the hint query. Two, whatever the page length —
        // one lookup per task is what this assertion exists to catch.
        expect(ours).toHaveLength(2)
        expect(ours.filter((sql) => sql.includes('task_hints'))).toHaveLength(1)
      } finally {
        await watched.close()
      }
    })

    it('attaches each task’s own hints and nobody else’s', async () => {
      await aTaskWith(['Only on A.'], { type: 'task-a', recommendedOrder: 1 })
      await aTaskWith([], { type: 'task-b', recommendedOrder: 2 })

      const listed = await listTasks(db, { agentId, availableOnly: true, limit: 10, hints: true })
      if (listed.outcome !== 'listed') throw new Error(listed.outcome)

      expect(listed.page.items.map((task) => task.hints)).toEqual([
        [{ content: 'Only on A.', sortOrder: 0 }],
        [],
      ])
    })
  })
})
