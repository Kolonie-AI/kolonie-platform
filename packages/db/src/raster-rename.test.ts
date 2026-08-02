import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import type { Database } from './client.js'
import { ACADEMY_TASKS } from './academy-tasks.js'
import {
  RASTER_RENAME_MIGRATION,
  RENAME_IMAGE_GEN_TO_RASTER_SQL,
  renameImageGenToRaster,
} from './raster-rename.js'
import { agents, agentSkills, submissions, tasks } from './schema/index.js'
import { connectForTests, databaseTestTarget, MIGRATIONS_FOLDER, truncateAll } from './testing.js'

const target = databaseTestTarget()

/**
 * The copy check, and it needs no database. Same arrangement as
 * `skill-backfill.test.ts` and `credit-rename.test.ts`: the statements exist in
 * the migration, which is what ran against the deployment, and here, which is
 * what the tests below drive.
 *
 * Compared statement by statement rather than as one string, because the
 * migration separates its statements with Drizzle's `--> statement-breakpoint`
 * and the constant separates them with a newline. A whole-string containment
 * check would fail for a formatting reason and say nothing about drift.
 */
describe('the rename statements', () => {
  it('are the ones the migration ran', async () => {
    const migration = await readFile(join(MIGRATIONS_FOLDER, RASTER_RENAME_MIGRATION), 'utf8')

    const statements = RENAME_IMAGE_GEN_TO_RASTER_SQL.split('\n').filter((line) => line !== '')
    expect(statements).toHaveLength(5)

    for (const statement of statements) {
      expect(migration, `the migration is missing: ${statement}`).toContain(statement)
    }
  })
})

/**
 * **The slug is retired, and this is where that stops being a promise** (`#215`).
 *
 * `image-gen` sounds like the generator rung that grants `image-model` (`#216`),
 * so a row meaning two different things depending on when it was written is the
 * one outcome the rename exists to prevent. The seed is the only thing that ever
 * mints these values.
 */
describe('the retired slug', () => {
  it('is granted, required and suggested by no seeded task', () => {
    for (const task of ACADEMY_TASKS) {
      expect(task.type, `${task.title} still has the retired type`).not.toBe('image-gen')
      expect(task.grants).not.toContain('image-gen')
      expect(task.requires).not.toContain('image-gen')
      expect(task.suggests).not.toContain('image-gen')
    }
  })

  it('has exactly one task granting the skill that replaced it', () => {
    const granting = ACADEMY_TASKS.filter((task) => task.grants.includes('raster'))

    expect(granting).toHaveLength(1)
    expect(granting[0]?.type).toBe('raster')
  })
})

describe('renaming the image rung to raster', () => {
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

  const anAgent = async (name: string) => {
    const [row] = await db
      .insert(agents)
      .values({ name, platform: 'openclaw' })
      .returning({ id: agents.id })
    if (row === undefined) throw new Error('inserting an agent returned no row')
    return row.id
  }

  const aTask = async (type: string, skills: Partial<Record<'grants', string[]>> = {}) => {
    const [row] = await db
      .insert(tasks)
      .values({
        type,
        grantsSkills: skills.grants ?? [],
        title: `The ${type} rung`,
        description: 'What this task is, for a human reading the catalogue.',
        instructions: 'What the agent must actually do.',
        rewardCredits: 0,
        rewardReputation: 3,
        timeoutHours: 24,
        status: 'active' as const,
      })
      .returning({ id: tasks.id })
    if (row === undefined) throw new Error('inserting a task returned no row')
    return row.id
  }

  /** An agent holding the old slug, exactly as the two live holders held it. */
  const aHolderOf = async (skill: string, name: string) => {
    const agentId = await anAgent(name)
    const taskId = await aTask('image-gen', { grants: [skill] })
    const [submission] = await db
      .insert(submissions)
      .values({
        taskId,
        agentId,
        payload: {},
        attempt: 1,
        status: 'passed' as const,
        // `submissions_verified_at_matches_status` — a decided submission
        // carries the moment it was decided, and a pass is decided.
        verifiedAt: '2026-07-31T15:32:00.000Z',
      })
      .returning({ id: submissions.id })
    if (submission === undefined) throw new Error('inserting a submission returned no row')

    await db.insert(agentSkills).values({
      agentId,
      skill,
      submissionId: submission.id,
      grantedAt: '2026-07-31T15:32:00.000Z',
    })

    return { agentId, submissionId: submission.id }
  }

  const skillsOf = async (agentId: string) =>
    (
      await db
        .select({ skill: agentSkills.skill })
        .from(agentSkills)
        .where(eq(agentSkills.agentId, agentId))
    ).map((row) => row.skill)

  /**
   * The row is read back rather than the exit code (`#215`'s definition of done
   * says so outright, and an earlier session learned it the hard way with a
   * `DELETE` that reported success and changed nothing).
   */
  it('renames the skill for a holder', async () => {
    const { agentId } = await aHolderOf('image-gen', 'vireo-like')

    await renameImageGenToRaster(db)

    expect(await skillsOf(agentId)).toEqual(['raster'])
  })

  /**
   * **A rename is not a revocation**, and this is the assertion that says so.
   * The date the skill was earned and the submission that proves it are the
   * whole of a citizen's claim to it.
   */
  it('leaves what was earned untouched', async () => {
    const { agentId, submissionId } = await aHolderOf('image-gen', 'keeps-its-history')

    await renameImageGenToRaster(db)

    const [row] = await db
      .select({ grantedAt: agentSkills.grantedAt, submissionId: agentSkills.submissionId })
      .from(agentSkills)
      .where(and(eq(agentSkills.agentId, agentId), eq(agentSkills.skill, 'raster')))

    expect(row?.submissionId).toBe(submissionId)
    expect(row?.grantedAt).toContain('2026-07-31')
  })

  it('renames every holder, not the first one it finds', async () => {
    const first = await aHolderOf('image-gen', 'granted-in-july')
    const second = await aHolderOf('image-gen', 'granted-in-august')

    await renameImageGenToRaster(db)

    expect(await skillsOf(first.agentId)).toEqual(['raster'])
    expect(await skillsOf(second.agentId)).toEqual(['raster'])
  })

  it('touches no other skill', async () => {
    const { agentId } = await aHolderOf('vision', 'holds-something-else')

    await renameImageGenToRaster(db)

    expect(await skillsOf(agentId)).toEqual(['vision'])
  })

  it('renames the task type and what the task grants', async () => {
    await aTask('image-gen', { grants: ['image-gen'] })

    await renameImageGenToRaster(db)

    const [row] = await db
      .select({ type: tasks.type, grants: tasks.grantsSkills })
      .from(tasks)
      .where(eq(tasks.type, 'raster'))

    expect(row?.grants).toEqual(['raster'])
  })

  /**
   * A maintainer restoring a backup pastes this without first working out
   * whether it has already run. Every statement is guarded on the old value, so
   * the second run matches nothing — which is a property worth a test rather
   * than a sentence in a comment.
   */
  it('changes nothing on a second run', async () => {
    const { agentId } = await aHolderOf('image-gen', 'run-twice')

    await renameImageGenToRaster(db)
    await renameImageGenToRaster(db)

    expect(await skillsOf(agentId)).toEqual(['raster'])
  })
})
