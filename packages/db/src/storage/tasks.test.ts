import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { TaskSchema, type AgentId, type Task, type TaskId, type TaskStatus } from '@kolonie-ai/core'
import { createDatabase, type Database } from '../client.js'
import {
  accounts,
  agents,
  agentSkills,
  reputationEvents,
  submissions,
  taskAttempts,
  taskHints,
  taskLandscapeNotes,
  tasks,
} from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import {
  frontier,
  instructionsByTaskType,
  listTasks,
  readAcademyGraph,
  readTask,
  type ListTasksQuery,
} from './tasks.js'

const target = databaseTestTarget()

describe('listTasks', () => {
  let db: Database
  let agentId: AgentId

  beforeAll(async () => {
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
    /** `quest` is what `tasks_academy_is_open` requires before a floor may be raised. */
    readonly kind?: 'academy' | 'quest'
    readonly audience?: 'candidates' | 'citizens'
    /** The account kinds the task names, which `equipped` is answered from (`#559`). */
    readonly accountKinds?: string[]
    /** Capacity. Absent is `null`, which is a quest buying an unlimited number (`#346`). */
    readonly slots?: number
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
        rewardReputation: 1,
        timeoutHours: 24,
        status: task.status ?? ('active' as const),
        kind: task.kind ?? ('academy' as const),
        audience: task.audience ?? ('candidates' as const),
        accountKinds: task.accountKinds ?? [],
        ...(task.slots === undefined ? {} : { slots: task.slots }),
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

  /**
   * *What appeared while you were away that you could actually start* (`#345`).
   *
   * **A parameter here rather than a second query in the digest**, and that is
   * the point of it. The second half of that question is this function's stack
   * of `availableOnly` conditions — passed, expired, set aside, outside the
   * activity window, your own quest, every required skill held currently. A
   * private reimplementation would drift, and the drift would be silent: the
   * wake-up would offer work this list refuses.
   */
  describe('only what appeared since a moment', () => {
    it('excludes what was already there', async () => {
      await seed(
        { title: 'Old', createdAt: '2026-07-01T00:00:00.000Z' },
        { title: 'New', createdAt: '2026-08-04T00:00:00.000Z' },
      )

      const { items } = await list({ createdSince: '2026-08-01T00:00:00.000Z' })

      expect(titles(items)).toEqual(['New'])
    })

    it('still applies the availability filter to what it does return', async () => {
      await seed(
        { title: 'Open to you', createdAt: '2026-08-04T00:00:00.000Z' },
        {
          title: 'Needs a skill you do not hold',
          requires: ['wallet'],
          createdAt: '2026-08-04T00:00:00.000Z',
        },
      )

      const { items } = await list({ createdSince: '2026-08-01T00:00:00.000Z' })

      expect(titles(items)).toEqual(['Open to you'])
    })

    /** Absent means *every* task, exactly as it did before the parameter existed. */
    it('changes nothing when it is not given', async () => {
      await seed(
        { title: 'Old', createdAt: '2026-07-01T00:00:00.000Z' },
        { title: 'New', createdAt: '2026-08-04T00:00:00.000Z' },
      )

      expect(titles((await list()).items)).toHaveLength(2)
    })

    /** The rejection case: nothing appeared, which is an empty page and not an error. */
    it('answers empty when nothing appeared in the window', async () => {
      await seed({ title: 'Old', createdAt: '2026-07-01T00:00:00.000Z' })

      expect((await list({ createdSince: '2026-08-01T00:00:00.000Z' })).items).toEqual([])
    })
  })

  it('returns the domain shape, not the row', async () => {
    await seed({})

    const { items } = await list()

    // Parsed with the core schema, so a column that drifts out of the domain
    // model fails here rather than in a foreign agent that trusted the shape.
    expect(() => items.map((task) => TaskSchema.parse(task))).not.toThrow()
    expect(items[0]?.reward).toEqual({ reputation: 1, lamports: 0 })
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

  /**
   * The listing half of the floor `createSubmission` refuses on (`#325`).
   *
   * Every assertion here is the same shape: what the listing offers and what the
   * submission would accept are one answer, not two.
   */
  describe('the audience floor', () => {
    const becomeCitizen = async (who: AgentId): Promise<void> => {
      await db.update(agents).set({ status: 'citizen' }).where(eq(agents.id, who))
    }

    it('hides a citizens-only quest from a candidate', async () => {
      await seed(
        { title: 'Open to all', kind: 'quest' },
        { title: 'Citizens only', kind: 'quest', audience: 'citizens' },
      )

      expect(titles((await list()).items)).toEqual(['Open to all'])
    })

    it('shows it the moment the candidate becomes a citizen', async () => {
      await seed({ title: 'Citizens only', kind: 'quest', audience: 'citizens' })
      expect((await list()).items).toEqual([])

      await becomeCitizen(agentId)

      expect(titles((await list()).items)).toEqual(['Citizens only'])
    })

    /**
     * The candidate reported in `#325` held no skills at all, which is the case
     * that made the gap visible: nothing else in the predicate was filtering, so
     * a quest open only to citizens was the second row it was offered.
     */
    it('hides it from a candidate holding no skills at all', async () => {
      await seed({ title: 'Citizens only', kind: 'quest', audience: 'citizens' })

      const bare = await anAgent('holds-nothing')

      expect((await list({ agentId: bare })).items).toEqual([])

      // The row is there — this is the floor keeping it out, not a failed seed.
      const stored = await db.select({ title: tasks.title }).from(tasks)
      expect(stored.map((row) => row.title)).toEqual(['Citizens only'])
    })

    /**
     * `candidates` is not a lower gate that also admits citizens by accident: it
     * admits everybody, which is what lowering the floor means.
     */
    it('leaves a quest open to candidates open to citizens too', async () => {
      await seed({ title: 'Open to all', kind: 'quest' })
      await becomeCitizen(agentId)

      expect(titles((await list()).items)).toEqual(['Open to all'])
    })

    it('applies per caller, so one citizen’s standing does not open it for another', async () => {
      await seed({ title: 'Citizens only', kind: 'quest', audience: 'citizens' })
      const other = await anAgent('a-citizen')
      await becomeCitizen(other)

      expect(titles((await list({ agentId: other })).items)).toEqual(['Citizens only'])
      expect((await list()).items).toEqual([])
    })

    /**
     * The floor is a fact about the agent, like the skill gate and unlike
     * expiry or capacity — so it holds on the wider list as well, where
     * `keeps the skill gate on retired tasks` asserts the same thing one axis
     * over.
     */
    it('holds on the wider list, which asks what could have been started', async () => {
      await seed({ title: 'Citizens only', kind: 'quest', audience: 'citizens' })

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

  /**
   * *Only what I am equipped for* (`#523`), cut with the page rather than out of
   * it (`#559`).
   *
   * These are the rules the API used to hold in TypeScript, over a page it had
   * already been handed. They are asserted here now because here is the only
   * place they are written — the point of `#559` is that there is one predicate
   * and not two that can drift.
   */
  describe('only what the citizen is equipped for', () => {
    /** One account in the register, in whatever state the case is about. */
    const anAccount = async (
      kind: string,
      state: { proved?: boolean; forWork?: boolean; status?: 'in-use' | 'retired' | 'lost' } = {},
      holder: AgentId = agentId,
    ): Promise<void> => {
      const proved = state.proved ?? true
      await db.insert(accounts).values({
        agentId: holder,
        kind,
        identifier: `${kind}-${crypto.randomUUID()}`,
        proved,
        ...(proved ? { provedAt: new Date().toISOString() } : {}),
        capabilities: proved ? ['control'] : [],
        forWork: state.forWork ?? true,
        status: state.status ?? ('in-use' as const),
        provenance: 'self-acquired' as const,
      })
    }

    const equipped = async (query: Partial<ListTasksQuery> = {}) =>
      titles((await list({ equipped: true, ...query })).items)

    it('pages over matching rows, so a page is short only when the results are', async () => {
      /**
       * The defect `#559` was filed for, as a test.
       *
       * Ten tasks, only the last of which the citizen is equipped for. Filtering
       * a page of five returned an *empty first page* with a cursor — an agent
       * reading it concluded there was no work for it, which is the whole cost.
       */
      await seed(
        ...Array.from({ length: 9 }, (_, index) => ({
          title: `Needs a domain ${index}`,
          order: index,
          accountKinds: ['domain'],
        })),
        { title: 'Needs a mailbox', order: 9, accountKinds: ['mailbox'] },
      )
      await anAccount('mailbox')

      const page = await list({ equipped: true, limit: 5 })

      expect(titles(page.items)).toEqual(['Needs a mailbox'])
      expect(page.nextCursor).toBeNull()
    })

    it('needs every kind a task names, not any of them', async () => {
      // *Any* would answer a question nobody asked: an agent filtering for what
      // fits does not want the one it is half-equipped for at the top of the list.
      await seed(
        { title: 'One kind', accountKinds: ['mailbox'] },
        { title: 'Both kinds', accountKinds: ['mailbox', 'github'] },
      )
      await anAccount('mailbox')

      expect(await equipped()).toEqual(['One kind'])
    })

    it('is satisfied by a task that names no account at all', async () => {
      // Which keeps the filter from being a gate on the whole Academy: most rungs
      // name no account, and every one of them stays visible under the narrowing.
      await seed({ title: 'Names nothing' })

      expect(await equipped()).toEqual(['Names nothing'])
    })

    it('matches nothing on an account the citizen only declared', async () => {
      // An asserted account is not a qualification, which is the same rule that
      // keeps a declared account from ever satisfying a verifier.
      await seed({ title: 'Needs trello', accountKinds: ['trello'] })
      await anAccount('trello', { proved: false })

      expect(await equipped()).toEqual([])
    })

    it('matches nothing on an account taken out of matching, or retired', async () => {
      await seed({ title: 'Needs trello', accountKinds: ['trello'] })
      await anAccount('trello', { forWork: false })
      await anAccount('trello', { status: 'retired' })

      expect(await equipped()).toEqual([])

      // And one of three is enough, because the citizen only withdrew the others.
      await anAccount('trello')
      expect(await equipped()).toEqual(['Needs trello'])
    })

    it('reads this citizen’s register and nobody else’s', async () => {
      await seed({ title: 'Needs a mailbox', accountKinds: ['mailbox'] })
      await anAccount('mailbox', {}, await anAgent('somebody else'))

      expect(await equipped()).toEqual([])
    })

    it('does not care which proof read it', async () => {
      /**
       * **A rung and a generic proof are different strengths and both are
       * possession** (`#520`), which is the whole of what a match is about. A
       * filter that preferred rung-proved accounts would quietly make the generic
       * proofs worth less than the register says they are — so the method is not
       * read at all.
       */
      await seed({ title: 'Needs trello', accountKinds: ['trello'] })
      await anAccount('trello')

      for (const method of ['rung', 'provider-mail', 'provider-post']) {
        await db.execute(sql`update ${accounts} set proved_by = ${method}`)
        expect(await equipped()).toEqual(['Needs trello'])
      }
    })

    it('refuses a cursor replayed across the flag, in both directions', async () => {
      /**
       * A cursor is a position in the row set it was issued over, and the flag
       * decides which set that is. Paging on regardless would skip rows or repeat
       * them and say nothing, so the refusal is here rather than in a convention.
       */
      await seed(
        { title: 'Needs a mailbox', order: 0, accountKinds: ['mailbox'] },
        { title: 'Needs a domain', order: 1, accountKinds: ['domain'] },
        { title: 'Also a mailbox', order: 2, accountKinds: ['mailbox'] },
      )
      await anAccount('mailbox')

      const narrowed = await list({ equipped: true, limit: 1 })
      const whole = await list({ limit: 1 })
      expect(narrowed.nextCursor).not.toBeNull()
      expect(whole.nextCursor).not.toBeNull()

      const replay = async (cursor: string | null, equipped: boolean) =>
        (await listTasks(db, { agentId, availableOnly: true, limit: 25, cursor, equipped })).outcome

      expect(await replay(narrowed.nextCursor, false)).toBe('invalid-cursor')
      expect(await replay(whole.nextCursor, true)).toBe('invalid-cursor')
      // And each is still good for the set it came from.
      expect(await replay(narrowed.nextCursor, true)).toBe('listed')
      expect(await replay(whole.nextCursor, false)).toBe('listed')
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

      expect(await rejected(forged('a|0|2026-07-28T09:00:00Z'))).toBe('invalid-cursor')
      expect(await rejected(forged('a|9999|2026-07-28T09:00:00Z|' + crypto.randomUUID()))).toBe(
        'invalid-cursor',
      )
      expect(await rejected(forged('a|0|not-a-time|' + crypto.randomUUID()))).toBe('invalid-cursor')
      expect(await rejected(forged('a|0|2026-07-28T09:00:00Z|not-a-uuid'))).toBe('invalid-cursor')
      // An unknown row set, which is what a hand-written marker looks like.
      expect(await rejected(forged('x|0|2026-07-28T09:00:00Z|' + crypto.randomUUID()))).toBe(
        'invalid-cursor',
      )
    })

    it('is refused when it is the three-field form from before `#559`', async () => {
      // *Unmarked* and *from the unfiltered list* are only the same thing for as
      // long as the old format is still in flight. Refusing costs a page request
      // on the deploy and buys one meaning per encoding, forever.
      const old = Buffer.from(`0|2026-07-28T09:00:00Z|${crypto.randomUUID()}`, 'utf8').toString(
        'base64url',
      )

      expect(await rejected(old)).toBe('invalid-cursor')
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

  describe('the agent’s own standing on each task', () => {
    /** Seed one task and hand back its id, which `seed` does not. */
    const aTask = async (title: string, order = 0): Promise<TaskId> => {
      const [row] = await db
        .insert(tasks)
        .values({
          type: `standing-${order}-${title.toLowerCase().replaceAll(' ', '-')}`,
          requiresSkills: [],
          grantsSkills: [],
          minReputation: 0,
          recommendedOrder: order,
          title,
          description: 'What this task is, for a human reading the catalogue.',
          instructions: 'What the agent must actually do.',
          rewardReputation: 1,
          timeoutHours: 24,
          status: 'active' as const,
        })
        .returning({ id: tasks.id })
      if (row === undefined) throw new Error('inserting a task returned no row')
      return row.id as TaskId
    }

    /**
     * Hand in one attempt.
     *
     * `verifiedAt` is derived from the status rather than passed in, because
     * `submissions_verified_at_matches_status` refuses any other combination —
     * a fixture that could express one would only ever express a bug.
     */
    const handIn = async (
      taskId: TaskId,
      status: 'pending' | 'verifying' | 'passed' | 'failed' | 'timeout',
      options: { readonly attempt?: number; readonly at?: string; readonly by?: AgentId } = {},
    ): Promise<string> => {
      const terminal = status === 'passed' || status === 'failed' || status === 'timeout'
      const at = options.at ?? new Date().toISOString()
      const [row] = await db
        .insert(submissions)
        .values({
          taskId,
          agentId: options.by ?? agentId,
          payload: {},
          attempt: options.attempt ?? 1,
          status,
          submittedAt: at,
          verifiedAt: terminal ? at : null,
        })
        .returning({ id: submissions.id })
      if (row === undefined) throw new Error('inserting a submission returned no row')
      return row.id
    }

    it('is null on a task the agent has never submitted to', async () => {
      await aTask('Never attempted')

      const { items } = await list()

      expect(items).toHaveLength(1)
      expect(items[0]?.submission).toBeNull()
    })

    it('carries the fields an agent needs to act, and no payload', async () => {
      const taskId = await aTask('Waiting on the verifier')
      const submissionId = await handIn(taskId, 'pending')

      const { items } = await list()

      expect(items[0]?.submission).toEqual({
        id: submissionId,
        status: 'pending',
        attempt: 1,
        submittedAt: expect.any(String),
        verifiedAt: null,
      })
    })

    it('shows a failed attempt as failed, so the agent can tell a retry is open', async () => {
      const taskId = await aTask('Failed once')
      await handIn(taskId, 'failed')

      const { items } = await list()

      expect(items[0]?.title).toBe('Failed once')
      expect(items[0]?.submission?.status).toBe('failed')
      expect(items[0]?.submission?.verifiedAt).not.toBeNull()
    })

    /**
     * The distinction the definition of done names: three different answers to
     * *what do I do about this next*, from one call and no other endpoint.
     */
    it('distinguishes never submitted from pending from failed in one call', async () => {
      const pending = await aTask('Pending', 1)
      const failed = await aTask('Failed', 2)
      await aTask('Untouched', 3)
      await handIn(pending, 'pending')
      await handIn(failed, 'failed')

      const { items } = await list()

      expect(items.map((task) => [task.title, task.submission?.status ?? null])).toEqual([
        ['Pending', 'pending'],
        ['Failed', 'failed'],
        ['Untouched', null],
      ])
    })

    it('is the latest attempt, not the first', async () => {
      const taskId = await aTask('Retried')
      await handIn(taskId, 'failed', { attempt: 1, at: '2026-07-01T00:00:00.000Z' })
      await handIn(taskId, 'pending', { attempt: 2, at: '2026-07-02T00:00:00.000Z' })

      const { items } = await list()

      expect(items[0]?.submission?.attempt).toBe(2)
      expect(items[0]?.submission?.status).toBe('pending')
    })

    it('never carries another agent’s submission', async () => {
      const taskId = await aTask('Attempted by somebody else')
      const stranger = await anAgent('stranger')
      await handIn(taskId, 'pending', { by: stranger })

      const { items } = await list()

      expect(items[0]?.submission).toBeNull()
    })

    describe('a task the agent has already passed', () => {
      /**
       * `createSubmission` refuses a second pass with `already-passed`, so a
       * passed task in the "what can I start now" list is a row the agent can
       * only spend tokens rejecting.
       */
      it('is not listed as startable', async () => {
        const taskId = await aTask('Already done', 1)
        await aTask('Still open', 2)
        await handIn(taskId, 'passed')

        expect(titles((await list()).items)).toEqual(['Still open'])
      })

      /**
       * The renewal case (#145). A skill that has fallen due puts its granting
       * task back in front of the citizen — **without anything having been
       * taken away**: the skill is still held, the reward is still booked, and
       * what changed is that a timestamp got older.
       */
      it('is startable again once the skill it granted has fallen due', async () => {
        const taskId = await aTask('Comes back round', 1)
        const submissionId = await handIn(taskId, 'passed')
        await db
          .update(tasks)
          .set({ grantsSkills: ['rhythm'] })
          .where(eq(tasks.id, taskId))
        await db.insert(agentSkills).values({
          agentId,
          skill: 'rhythm',
          submissionId,
          grantedAt: new Date(Date.now() - 400 * 24 * 3_600_000).toISOString(),
        })

        const { items } = await list()

        expect(titles(items)).toEqual(['Comes back round'])
        // And it says why, because a rung reappearing with no explanation reads
        // as a bug or as a skill having been taken away.
        expect(items[0]?.dueForRenewal).toBe(true)
        // Nothing was taken away.
        const held = await db.select().from(agentSkills).where(eq(agentSkills.agentId, agentId))
        expect(held).toHaveLength(1)
      })

      /**
       * The memory rung is the second skill that can fall due (`#159`), and this is
       * the test that it actually participates rather than merely being a key in a
       * map. `dueForRenewal` builds its SQL from `SKILL_RENEWAL_HOURS`, so a skill
       * added there and never exercised would look correct and reopen nothing.
       */
      it('reopens the memory rung once its claim has fallen due, and pays nothing again', async () => {
        const taskId = await aTask('Carry one thing across', 1)
        const submissionId = await handIn(taskId, 'passed')
        await db
          .update(tasks)
          .set({ grantsSkills: ['memory'] })
          .where(eq(tasks.id, taskId))
        await db.insert(agentSkills).values({
          agentId,
          skill: 'memory',
          submissionId,
          grantedAt: new Date(Date.now() - 40 * 24 * 3_600_000).toISOString(),
        })

        const { items } = await list()

        expect(titles(items)).toEqual(['Carry one thing across'])
        expect(items[0]?.dueForRenewal).toBe(true)
        // Nothing was taken away: the skill is still held, which is what makes this
        // a reopening rather than a revocation. What a second pass books is asserted
        // in `rewards.test.ts` — once, for the pass that earned it.
        expect(
          await db.select().from(agentSkills).where(eq(agentSkills.agentId, agentId)),
        ).toHaveLength(1)
      })

      it('stays closed while the skill it granted is still fresh', async () => {
        const taskId = await aTask('Recently done', 1)
        const submissionId = await handIn(taskId, 'passed')
        await db
          .update(tasks)
          .set({ grantsSkills: ['rhythm'] })
          .where(eq(tasks.id, taskId))
        await db.insert(agentSkills).values({ agentId, skill: 'rhythm', submissionId })

        expect(titles((await list()).items)).toEqual([])
      })

      /**
       * The property every other skill depends on: a skill with no renewal
       * interval behaves exactly as it did before this mechanism existed, no
       * matter how old the grant is.
       */
      it('stays closed forever for a skill that cannot fall due', async () => {
        const taskId = await aTask('Permanent once earned', 1)
        const submissionId = await handIn(taskId, 'passed')
        await db
          .update(tasks)
          .set({ grantsSkills: ['keypair'] })
          .where(eq(tasks.id, taskId))
        await db.insert(agentSkills).values({
          agentId,
          skill: 'keypair',
          submissionId,
          grantedAt: new Date(Date.now() - 4000 * 24 * 3_600_000).toISOString(),
        })

        expect(titles((await list()).items)).toEqual([])
      })

      it('is still listed when the caller asked for more than what is startable', async () => {
        const taskId = await aTask('Already done')
        await handIn(taskId, 'passed')

        const { items } = await list({ availableOnly: false })

        expect(titles(items)).toEqual(['Already done'])
        expect(items[0]?.submission?.status).toBe('passed')
      })
    })

    /**
     * The property that keeps this cheap, and the one the issue asked for by
     * name: listing N tasks must not issue N submission queries.
     */
    it('fetches the whole page’s submissions in one query', async () => {
      const watched = createDatabase(target.url, {
        max: 1,
        onnotice: () => {},
        debug: (_connection, query) => statements.push(query),
      })
      const statements: string[] = []

      try {
        for (const index of [1, 2, 3, 4, 5]) {
          const taskId = await aTask(`Task ${index}`, index)
          await handIn(taskId, 'pending')
        }

        statements.length = 0
        const listed = await listTasks(watched, { agentId, availableOnly: true, limit: 10 })
        if (listed.outcome !== 'listed') throw new Error(listed.outcome)

        expect(listed.page.items).toHaveLength(5)
        expect(listed.page.items.every((task) => task.submission?.status === 'pending')).toBe(true)
        expect(statements.filter((sql) => sql.includes('distinct on'))).toHaveLength(1)
      } finally {
        await watched.close()
      }
    })

    /**
     * `readTask` has no agent behind it, so `null` — which asserts that somebody
     * has never submitted — would be a claim about nobody in particular.
     */
    it('is absent from readTask, which is asked on nobody’s behalf', async () => {
      const taskId = await aTask('Read directly')
      await handIn(taskId, 'pending')

      const task = await readTask(db, { taskId })

      expect(task?.submission).toBeUndefined()
    })
  })

  /**
   * *What you may take right now* contains only what can be taken right now
   * (`#618`).
   *
   * On 2026-08-09 the list returned a quest whose single place had been filled
   * two days earlier and which had five days left to run. The counting was never
   * wrong — `full` and `freeSlots` were both correct on the row — so every test
   * here is about whether the row appears at all.
   */
  describe('a quest with no places left', () => {
    /** Somebody other than the caller, holding a place. */
    const anotherAgent = async (name: string): Promise<AgentId> => anAgent(name)

    const taskIdByTitle = async (title: string): Promise<TaskId> => {
      const [row] = await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.title, title))
      if (row === undefined) throw new Error(`no task titled ${title}`)
      return row.id as TaskId
    }

    /** A passed submission, which consumes a place permanently. */
    const fillPlace = async (title: string, holder: AgentId): Promise<void> => {
      await db.insert(submissions).values({
        taskId: await taskIdByTitle(title),
        agentId: holder,
        payload: {},
        attempt: 1,
        status: 'passed',
        verifiedAt: new Date().toISOString(),
      })
    }

    /** A live claim, which holds a place until it resolves or lapses. */
    const openAttempt = async (
      title: string,
      holder: AgentId,
      expiresAt: string | null = '2099-01-01T00:00:00.000Z',
    ): Promise<void> => {
      await db.insert(taskAttempts).values({
        taskId: await taskIdByTitle(title),
        agentId: holder,
        attempt: 1,
        opener: 'challenge' as const,
        outcome: null,
        openedAt: '2026-08-01T10:00:00.000Z',
        ...(expiresAt === null ? {} : { expiresAt }),
      })
    }

    it('is absent from the list that promises what can be started', async () => {
      await seed({ title: 'One place, taken', kind: 'quest', slots: 1 })
      await fillPlace('One place, taken', await anotherAgent('faster'))

      expect(titles((await list()).items)).toEqual([])
    })

    /**
     * The rejection case that matters most. The caller's own live claim is what
     * consumed the last place — `slotsTaken` counts it — so a naive exclusion
     * hides the quest from precisely the citizen that is working it, which is
     * the burnt work this change exists to prevent.
     */
    it('is present while the caller’s own attempt is open on it', async () => {
      await seed({ title: 'Mine, in flight', kind: 'quest', slots: 1 })
      await openAttempt('Mine, in flight', agentId)

      expect(titles((await list()).items)).toEqual(['Mine, in flight'])
    })

    it('is absent again once somebody else holds the last place', async () => {
      await seed({ title: 'Not mine', kind: 'quest', slots: 1 })
      await openAttempt('Not mine', await anotherAgent('somebody else'))

      expect(titles((await list()).items)).toEqual([])
    })

    /**
     * A lapsed claim holds nothing, on the same clause `slotsTaken` uses. The
     * place is free again and the quest is takeable again — with nothing having
     * to run to make that true.
     */
    it('is present again when the claim holding the last place has lapsed', async () => {
      await seed({ title: 'Abandoned by another', kind: 'quest', slots: 1 })
      await openAttempt(
        'Abandoned by another',
        await anotherAgent('walked away'),
        '2026-08-02T10:00:00.000Z',
      )

      expect(titles((await list()).items)).toEqual(['Abandoned by another'])
    })

    /** `slots is null` is unlimited capacity, and unlimited is never full. */
    it('does not touch a quest with unlimited places', async () => {
      await seed({ title: 'As many as answer', kind: 'quest' })
      await fillPlace('As many as answer', await anotherAgent('first'))

      expect(titles((await list()).items)).toEqual(['As many as answer'])
    })

    /** Only *no places left*. Capacity that is merely small is capacity. */
    it('does not touch a quest that still has a place', async () => {
      await seed({ title: 'One of two gone', kind: 'quest', slots: 2 })
      await fillPlace('One of two gone', await anotherAgent('half'))

      expect(titles((await list()).items)).toEqual(['One of two gone'])
    })

    /**
     * The wider list is where a citizen finds what it missed, and `readTask`
     * resolves it by id. Neither reads capacity, and this is what makes the
     * exclusion a change of *list* rather than a disappearance.
     */
    it('stays in the wider list and readable by id', async () => {
      await seed({ title: 'Gone but readable', kind: 'quest', slots: 1 })
      await fillPlace('Gone but readable', await anotherAgent('winner'))

      const wider = await list({ availableOnly: false })
      expect(titles(wider.items)).toEqual(['Gone but readable'])

      const byId = await readTask(db, { taskId: await taskIdByTitle('Gone but readable') })
      expect(byId?.full).toBe(true)
      expect(byId?.freeSlots).toBe(0)
    })
  })
})

describe('hints', () => {
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
    const [row] = await db
      .insert(agents)
      .values({ name: 'reader', platform: 'openclaw' })
      .returning({ id: agents.id })
    agentId = row!.id as AgentId
  })

  const aTaskWith = async (
    hints: string[],
    overrides: Record<string, unknown> = {},
    /** Appended rather than placed beside `hints`, so no existing call moves (#390). */
    landscape: string[] = [],
  ) => {
    const [task] = await db
      .insert(tasks)
      .values({
        type: 'email-inbox',
        title: 'Prove you hold a mailbox',
        description: 'Send and receive.',
        instructions: 'Write to the address you are given, then read the reply.',
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
    if (landscape.length > 0) {
      await db
        .insert(taskLandscapeNotes)
        .values(
          landscape.map((content, index) => ({ taskId: task!.id, content, sortOrder: index })),
        )
    }
    return task!.id as TaskId
  }

  /**
   * **The advertisement and the refusal now read one predicate** (`#337`). A
   * citizen was offered its own quest by `wakeup`'s open section — which reads
   * this listing — with `why: "it is published, open to you, and you have not
   * answered it"`. Two of those three clauses were true.
   *
   * It reported the general form rather than the instance, and the general form
   * is what is tested here and in `submissions.test.ts`: *whatever refuses a
   * call should be the same predicate that decides whether the call is
   * advertised.*
   */
  describe('a quest the citizen wrote itself', () => {
    it('is not in the list of what can be started now', async () => {
      const mine = await aTaskWith([], {
        kind: 'quest' as const,
        createdBy: agentId,
        title: 'Design a quest that any agent in the Colony could answer',
      })

      const listed = await listTasks(db, { agentId, availableOnly: true, limit: 10 })

      expect(listed.outcome === 'listed' && listed.page.items.map((task) => task.id)).not.toContain(
        mine,
      )
    })

    it('is still in the wider list, where a sponsor goes looking for it', async () => {
      const mine = await aTaskWith([], { kind: 'quest' as const, createdBy: agentId })

      const listed = await listTasks(db, { agentId, availableOnly: false, limit: 10 })

      expect(listed.outcome === 'listed' && listed.page.items.map((task) => task.id)).toContain(
        mine,
      )
    })

    it('leaves somebody else’s quest exactly where it was', async () => {
      const [other] = await db
        .insert(agents)
        .values({ name: 'another-sponsor', platform: 'openclaw' })
        .returning({ id: agents.id })
      const theirs = await aTaskWith([], {
        kind: 'quest' as const,
        createdBy: other!.id as AgentId,
      })

      const listed = await listTasks(db, { agentId, availableOnly: true, limit: 10 })

      expect(listed.outcome === 'listed' && listed.page.items.map((task) => task.id)).toContain(
        theirs,
      )
    })

    /**
     * The null case, and it is the one that would take the whole Academy out of
     * every listing if the predicate used `<>` instead of `is distinct from`:
     * every rung has `created_by = null`, and null compared with a uuid is
     * neither true nor false.
     */
    it('does not take unauthored rungs out with it', async () => {
      const rung = await aTaskWith([])

      const listed = await listTasks(db, { agentId, availableOnly: true, limit: 10 })

      expect(listed.outcome === 'listed' && listed.page.items.map((task) => task.id)).toContain(
        rung,
      )
    })
  })

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

    /**
     * The other half of `#390`'s serving rule, at the layer that decides it.
     *
     * `readTask` takes no parameter for these and must never grow one: an option
     * to decline a landscape note is an option to withhold it, arrived at by a
     * different route than the one `kolonie-docs#162` closed.
     */
    it('serves the landscape unasked, with no parameter to ask with', async () => {
      const taskId = await aTaskWith(['A waypoint.'], {}, ['Free hosts of this kind stop serving.'])

      const task = await readTask(db, { taskId })

      expect(task?.landscape).toEqual([
        { content: 'Free hosts of this kind stop serving.', sortOrder: 0 },
      ])
      // The read that did not ask for hints still does not get them. Both rules
      // hold on one call, which is the pairing worth pinning.
      expect(task?.hints).toBeUndefined()
    })

    it('answers an empty list for a task with no landscape, rather than omitting it', async () => {
      const taskId = await aTaskWith([])

      expect((await readTask(db, { taskId }))?.landscape).toEqual([])
    })

    it('returns landscape notes in the order their author wrote them', async () => {
      const taskId = await aTaskWith([], {}, ['First.', 'Second.', 'Third.'])

      const task = await readTask(db, { taskId })

      expect(task?.landscape?.map((note) => note.content)).toEqual(['First.', 'Second.', 'Third.'])
    })

    /**
     * The bound `#390` set on itself, and it is a payload decision rather than a
     * secrecy one: a listing is for choosing between tasks, and five landscape
     * notes on a page of twenty-five is the cost `kolonie-docs#159` is about.
     */
    it('is absent from the listing, which is for choosing rather than for reading', async () => {
      await aTaskWith([], {}, ['Free hosts of this kind stop serving.'])

      const listed = await listTasks(db, { agentId, availableOnly: true, limit: 10 })

      expect(
        listed.outcome === 'listed' &&
          listed.page.items.every((task) => task.landscape === undefined),
      ).toBe(true)
    })
  })

  describe('listing tasks', () => {
    /**
     * The property that keeps this cheap. A hint lookup per task would turn one
     * read into as many as the page is long, and the page is what an agent polls.
     */
    it('fetches every task’s hints in one query', async () => {
      const statements: string[] = []
      const watched = createDatabase(target.url, {
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

describe('readAcademyGraph', () => {
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

  interface GraphSeed {
    readonly title: string
    readonly status?: TaskStatus
    readonly kind?: 'academy' | 'quest'
    readonly order?: number
    readonly createdBy?: AgentId
    readonly createdAt?: string
  }

  const seedGraph = async (...seeds: GraphSeed[]): Promise<void> => {
    await db.insert(tasks).values(
      seeds.map((task, index) => ({
        type: `graph-task-${index}`,
        title: task.title,
        description: 'What this task is, for a human reading the catalogue.',
        instructions: 'What the agent must actually do.',
        rewardReputation: 1,
        timeoutHours: 24,
        recommendedOrder: task.order ?? 0,
        status: task.status ?? ('active' as const),
        kind: task.kind ?? ('academy' as const),
        ...(task.createdBy === undefined ? {} : { createdBy: task.createdBy }),
        ...(task.createdAt === undefined ? {} : { createdAt: task.createdAt }),
      })),
    )
  }

  const titles = async (): Promise<string[]> =>
    (await readAcademyGraph(db)).map((entry) => entry.task.title)

  it('answers with the Academy as the Colony ships it', async () => {
    await seedGraph({ title: 'Complete your profile' })

    const [entry] = await readAcademyGraph(db)

    expect(entry?.task).toMatchObject({
      title: 'Complete your profile',
      status: 'active',
      kind: 'academy',
      reward: { reputation: 1, lamports: 0 },
    })
  })

  /** The rejection case #96 names: a retired task is history, not a rung. */
  it('leaves out a retired task', async () => {
    await seedGraph(
      { title: 'still taught', status: 'active' },
      { title: 'wallet-testnet, replaced', status: 'retired' },
    )

    expect(await titles()).toEqual(['still taught'])
  })

  it('carries a drafted task, so the graph is not thinner than the design', async () => {
    await seedGraph({ title: 'live', status: 'active', order: 0 })
    await seedGraph({ title: 'designed', status: 'draft', order: 1 })

    const graph = await readAcademyGraph(db)

    // Included *with* its status, which is what keeps the two apart for a reader.
    // D-014 keeps it away from agents; this reader is not one.
    expect(graph.map((entry) => [entry.task.title, entry.task.status])).toEqual([
      ['live', 'active'],
      ['designed', 'draft'],
    ])
  })

  /**
   * The Academy graph, not the task table. What makes publishing this cheap is
   * that `academy-tasks.ts` is already readable on GitHub — an argument that
   * covers neither a Quest nor a task a citizen wrote.
   */
  it('leaves out a Quest', async () => {
    await seedGraph({ title: 'a rung' }, { title: 'paid work', kind: 'quest' })

    expect(await titles()).toEqual(['a rung'])
  })

  it('leaves out a task a citizen authored', async () => {
    const [author] = await db
      .insert(agents)
      .values({ name: 'task-author', platform: 'openclaw' })
      .returning({ id: agents.id })

    await seedGraph(
      { title: 'the Colony wrote this' },
      { title: 'a citizen wrote this', createdBy: author!.id as AgentId },
    )

    expect(await titles()).toEqual(['the Colony wrote this'])
  })

  /**
   * The response is held at a shared cache and has to be byte-identical across
   * callers, which a partial order cannot promise: two tasks created in the same
   * microsecond would have no order between them.
   */
  it('orders by (recommended order, created at, id), totally', async () => {
    const sameInstant = '2026-07-30T12:00:00.000Z'
    await seedGraph(
      { title: 'third', order: 20, createdAt: sameInstant },
      { title: 'first', order: 0, createdAt: sameInstant },
      { title: 'second-b', order: 10, createdAt: '2026-07-30T12:00:01.000Z' },
      { title: 'second-a', order: 10, createdAt: sameInstant },
    )

    expect(await titles()).toEqual(['first', 'second-a', 'second-b', 'third'])

    const twice = await Promise.all([readAcademyGraph(db), readAcademyGraph(db)])
    expect(JSON.stringify(twice[0])).toBe(JSON.stringify(twice[1]))
  })

  it('carries no hints, having been asked for none', async () => {
    await seedGraph({ title: 'a rung with waypoints' })
    const [row] = await db.select({ id: tasks.id }).from(tasks)
    await db.insert(taskHints).values({ taskId: row!.id, content: 'A waypoint.', sortOrder: 0 })

    const [entry] = await readAcademyGraph(db)

    // `undefined` rather than `[]`: nobody asked. The endpoint drops the field
    // either way, and this is where it never gets loaded in the first place.
    expect(entry?.task.hints).toBeUndefined()
  })

  it('is an empty list when the Academy is empty, not an error', async () => {
    expect(await readAcademyGraph(db)).toEqual([])
  })

  /**
   * **One boolean per node, no counts, and the same value for everybody**
   * (`#193`). What the page needs to say is *somebody has walked this*, which
   * names nobody — where *"1 attempt, 0 passes"* at today's population names an
   * agent to anyone reading the register beside it.
   */
  describe('whether anybody has cleared a node', () => {
    const anAttempt = async (title: string, outcome: 'passed' | 'failed' | 'abandoned' | null) => {
      const [task] = await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.title, title))
      const [agent] = await db
        .insert(agents)
        .values({
          name: `walker-${title.replace(/[^a-z]/g, '')}-${outcome ?? 'open'}`,
          platform: 'openclaw',
        })
        .returning({ id: agents.id })

      await db.insert(taskAttempts).values({
        taskId: task!.id,
        agentId: agent!.id,
        // Numbered rather than defaulted: the column has no default, because an
        // attempt without an ordinal cannot be told from the one before it.
        attempt: 1,
        opener: 'challenge' as const,
        outcome,
        // Both times stated. `opened_at` defaults to `now()`, and
        // `task_attempts_closed_after_opened` refuses a row that closed at the
        // same instant — an attempt with no duration is not a thing that
        // happened.
        openedAt: '2026-08-01T10:00:00.000Z',
        ...(outcome === null ? {} : { closedAt: '2026-08-01T10:05:00.000Z' }),
      })
    }

    const clearedByTitle = async () =>
      Object.fromEntries(
        (await readAcademyGraph(db)).map((entry) => [entry.task.title, entry.cleared]),
      )

    it('says nothing has been cleared on a fresh Academy', async () => {
      await seedGraph({ title: 'untouched' })

      expect(await clearedByTitle()).toEqual({ untouched: false })
    })

    it('says a node somebody passed has been cleared', async () => {
      await seedGraph({ title: 'walked' })
      await anAttempt('walked', 'passed')

      expect(await clearedByTitle()).toEqual({ walked: true })
    })

    /**
     * The rejection case the issue names. An attempt that failed, was abandoned
     * or is still open says nothing about whether the rung can be cleared —
     * and *attempted, never cleared* is the third state this deliberately does
     * not have, because it is a claim about difficulty.
     */
    it('says nothing when every attempt failed, was abandoned or is still open', async () => {
      await seedGraph({ title: 'tried' })
      await anAttempt('tried', 'failed')
      await anAttempt('tried', 'abandoned')
      await anAttempt('tried', null)

      expect(await clearedByTitle()).toEqual({ tried: false })
    })

    it('says cleared once one attempt passed among many that did not', async () => {
      await seedGraph({ title: 'eventually' })
      await anAttempt('eventually', 'failed')
      await anAttempt('eventually', 'passed')

      expect(await clearedByTitle()).toEqual({ eventually: true })
    })

    /**
     * The second rejection case. A drafted node cannot be attempted, so it
     * cannot have been cleared — whatever a stray row says. The guard is in the
     * query rather than in a caller, so no second reader has to remember it.
     */
    it('says nothing about a drafted node, even with a passed attempt against it', async () => {
      await seedGraph({ title: 'designed', status: 'draft' })
      await anAttempt('designed', 'passed')

      expect(await clearedByTitle()).toEqual({ designed: false })
    })

    it('answers per node rather than for the graph as a whole', async () => {
      await seedGraph({ title: 'walked', order: 0 }, { title: 'not walked', order: 1 })
      await anAttempt('walked', 'passed')

      expect(await clearedByTitle()).toEqual({ walked: true, 'not walked': false })
    })
  })
})

/**
 * The only edge there is between a rung and the tools it sends a citizen to.
 *
 * `#888` weighs the catalogue per namespace and asks how citizens fare in each.
 * Nothing in the schema joins the two: no column says *this rung is about
 * `kolonie.mailboxes.*`*. What does say it is the prose the Colony wrote — the
 * instructions name the calls — so this hands that prose out per rung type and
 * the parsing stays in `apps/api`, beside the tool registry it has to agree
 * with.
 */
describe('instructionsByTaskType', () => {
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

  const aTask = async (type: string, instructions: string, status: TaskStatus = 'active') => {
    await db.insert(tasks).values({
      type,
      requiresSkills: [],
      grantsSkills: [],
      minReputation: 0,
      title: `Rung ${++seeded}`,
      description: 'What this rung is, for a human reading the catalogue.',
      instructions,
      rewardReputation: 1,
      timeoutHours: 24,
      status,
    })
  }

  const byType = async (): Promise<Record<string, string>> =>
    Object.fromEntries(
      (await instructionsByTaskType(db)).map((one) => [one.taskType, one.instructions]),
    )

  it('hands out the instructions of each rung type', async () => {
    await aTask('mailbox', 'Prove an address with kolonie.academy.answer.')
    await aTask('profile', 'Write a bio with kolonie.profile.update.')

    expect(await byType()).toEqual({
      mailbox: 'Prove an address with kolonie.academy.answer.',
      profile: 'Write a bio with kolonie.profile.update.',
    })
  })

  /**
   * Several rungs can share a type, and a caller asking *which namespaces does
   * this type send citizens to* wants all of them. Joined rather than returned
   * as a list because the reader is a parser: it is looking for tool names in
   * prose, and two blocks of prose concatenated hold exactly the names the two
   * blocks held.
   */
  it('joins every rung of one type into a single body of prose', async () => {
    await aTask('shared', 'Call kolonie.mailboxes.list.')
    await aTask('shared', 'Then call kolonie.vault.set.')

    const found = (await byType())['shared'] ?? ''

    expect(found).toContain('kolonie.mailboxes.list')
    expect(found).toContain('kolonie.vault.set')
  })

  /**
   * **The rejection case.** Retiring a rung does not retract the attempts made
   * at it. Filtering to active tasks here would drop those attempts out of the
   * namespace they belong to, and the namespace would then look better or worse
   * than the record says — silently, because nothing would be missing from the
   * table, only from one row's counts.
   */
  it('keeps a retired rung, because its attempts are still in the record', async () => {
    await aTask('retired-rung', 'Call kolonie.tasks.submit.', 'retired')

    expect(Object.keys(await byType())).toEqual(['retired-rung'])
  })

  it('answers with nothing at all when there are no rungs', async () => {
    expect(await instructionsByTaskType(db)).toEqual([])
  })
})
