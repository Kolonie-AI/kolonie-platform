import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import type { Database } from './client.js'
import { agents, agentSkills, submissions, tasks } from './schema/index.js'
import {
  BACKFILL_AGENT_SKILLS_SQL,
  backfillAgentSkills,
  SKILL_GRAPH_MIGRATION,
} from './skill-backfill.js'
import {
  connectForTests,
  databaseTestTarget,
  expectRejection,
  MIGRATIONS_FOLDER,
  truncateAll,
} from './testing.js'

const target = databaseTestTarget()

if (!target.available) {
  console.warn(`\n${target.reason}\n`)
}

/**
 * The copy check, and it needs no database.
 *
 * The backfill exists twice: once in the migration, which is what actually ran
 * against the deployment, and once here, which is what the tests below drive. A
 * migration cannot import TypeScript and a derivation nobody can test is a
 * derivation nobody can trust — so the two are kept in step by asserting the
 * migration still contains the statement, rather than by hoping.
 */
describe('the backfill statement', () => {
  it('is the one the migration ran', async () => {
    const migration = await readFile(join(MIGRATIONS_FOLDER, SKILL_GRAPH_MIGRATION), 'utf8')

    expect(migration).toContain(BACKFILL_AGENT_SKILLS_SQL)
  })
})

describe.skipIf(!target.available)('backfilling agent skills', () => {
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

  const anAgent = async (name: string, level: number) => {
    const [row] = await db
      .insert(agents)
      .values({ name, platform: 'openclaw', level })
      .returning({ id: agents.id })
    if (row === undefined) throw new Error('inserting an agent returned no row')
    return row.id
  }

  const aTask = async (type: string, grants: string[]) => {
    const [row] = await db
      .insert(tasks)
      .values({
        type,
        level: 0,
        grantsSkills: grants,
        title: `The ${type} rung`,
        description: 'What this task is, for a human reading the catalogue.',
        instructions: 'What the agent must actually do.',
        rewardCoins: 1,
        rewardReputation: 1,
        timeoutHours: 24,
        status: 'active' as const,
      })
      .returning({ id: tasks.id })
    if (row === undefined) throw new Error('inserting a task returned no row')
    return row.id
  }

  const submitted = async (
    taskId: string,
    agentId: string,
    status: 'passed' | 'failed',
    verifiedAt = new Date().toISOString(),
  ) => {
    const [row] = await db
      .insert(submissions)
      .values({ taskId, agentId, payload: {}, attempt: 1, status, verifiedAt })
      .returning({ id: submissions.id })
    if (row === undefined) throw new Error('inserting a submission returned no row')
    return row.id
  }

  const heldBy = async (agentId: string) =>
    (
      await db
        .select({ skill: agentSkills.skill })
        .from(agentSkills)
        .where(eq(agentSkills.agentId, agentId))
        .orderBy(agentSkills.skill)
    ).map((row) => row.skill)

  /**
   * **The assertion the whole issue turns on.** The agent's level says it
   * climbed four rungs; its submissions say it passed two. The level is a
   * synthesised position nobody can audit, so the backfill derives from the
   * passes — and this agent comes out holding exactly what it proved, not what
   * the number implied.
   */
  it('grants what the passes prove, not what the level claims', async () => {
    const agentId = await anAgent('over-levelled', 4)
    await submitted(await aTask('profile-complete', ['profile']), agentId, 'passed')
    await submitted(await aTask('browser-capability', ['browser']), agentId, 'passed')

    await backfillAgentSkills(db)

    expect(await heldBy(agentId)).toEqual(['browser', 'profile'])
  })

  it('grants nothing for a submission that did not pass', async () => {
    const agentId = await anAgent('tried-once', 0)
    await submitted(await aTask('browser-capability', ['browser']), agentId, 'failed')

    await backfillAgentSkills(db)

    expect(await heldBy(agentId)).toEqual([])
  })

  it('grants nothing for a badge, however many agents passed it', async () => {
    const agentId = await anAgent('badge-holder', 1)
    await submitted(await aTask('browser-captcha', []), agentId, 'passed')

    await backfillAgentSkills(db)

    expect(await heldBy(agentId)).toEqual([])
  })

  it('grants every skill a task lists, not just the first', async () => {
    const agentId = await anAgent('multi', 0)
    await submitted(await aTask('two-at-once', ['profile', 'compute']), agentId, 'passed')

    await backfillAgentSkills(db)

    expect(await heldBy(agentId)).toEqual(['compute', 'profile'])
  })

  it('attributes the skill to the earliest pass that proved it', async () => {
    const agentId = await anAgent('twice', 0)
    const first = await aTask('browser-capability', ['browser'])
    const second = await aTask('browser-again', ['browser'])
    const earliest = await submitted(first, agentId, 'passed', '2026-01-01T00:00:00.000Z')
    await submitted(second, agentId, 'passed', '2026-06-01T00:00:00.000Z')

    await backfillAgentSkills(db)

    const [row] = await db
      .select({ submissionId: agentSkills.submissionId })
      .from(agentSkills)
      .where(eq(agentSkills.agentId, agentId))

    expect(row?.submissionId).toBe(earliest)
  })

  it('is safe to run twice, which is what makes it safe to run by hand', async () => {
    const agentId = await anAgent('repeatable', 0)
    await submitted(await aTask('profile-complete', ['profile']), agentId, 'passed')

    await backfillAgentSkills(db)
    await backfillAgentSkills(db)

    expect(await heldBy(agentId)).toEqual(['profile'])
  })

  it('keeps one agent’s passes out of another agent’s record', async () => {
    const holder = await anAgent('holder', 0)
    const bystander = await anAgent('bystander', 3)
    await submitted(await aTask('profile-complete', ['profile']), holder, 'passed')

    await backfillAgentSkills(db)

    expect(await heldBy(bystander)).toEqual([])
  })
})

/**
 * The rule that keeps a skill worth something: only the Colony mints them.
 *
 * Enforced on the row rather than in a service, because the property has to hold
 * for every write path that will ever exist — including the one nobody has
 * written yet, which is exactly the one that would forget. A citizen-authored
 * task may require any skill; it may grant none.
 */
describe.skipIf(!target.available)('who may mint a skill', () => {
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

  const insertTask = (createdBy: string | null, grants: string[]) =>
    db.insert(tasks).values({
      type: `citizen-task-${randomUUID().slice(0, 8)}`,
      level: 0,
      grantsSkills: grants,
      createdBy,
      title: 'A task somebody wrote',
      description: 'What this task is, for a human reading the catalogue.',
      instructions: 'What the agent must actually do.',
      rewardCoins: 1,
      rewardReputation: 1,
      timeoutHours: 24,
      status: 'active' as const,
    })

  it('refuses an agent-authored task that grants a skill', async () => {
    const [author] = await db
      .insert(agents)
      .values({ name: 'task-author', platform: 'openclaw' })
      .returning({ id: agents.id })
    if (author === undefined) throw new Error('inserting an agent returned no row')

    // Through `expectRejection`, because Drizzle wraps the driver error and the
    // constraint name lives on a `cause` several levels down — matching the
    // wrapper's message would pass for any failure at all.
    await expectRejection(
      () => insertTask(author.id, ['builder']),
      /tasks_only_colony_grants_skills/,
    )
  })

  it('allows an agent-authored task that grants nothing', async () => {
    const [author] = await db
      .insert(agents)
      .values({ name: 'another-author', platform: 'openclaw' })
      .returning({ id: agents.id })
    if (author === undefined) throw new Error('inserting an agent returned no row')

    await expect(insertTask(author.id, [])).resolves.not.toThrow()
  })

  it('allows the Colony’s own tasks to grant', async () => {
    await expect(insertTask(null, ['builder'])).resolves.not.toThrow()
  })
})
