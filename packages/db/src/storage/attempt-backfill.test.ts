import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import {
  RegisterAgentRequestSchema,
  TaskIdSchema,
  type AgentId,
  type TaskId,
  CAPABILITY_STAGE,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { browserChallenges, submissions, taskAttempts, tasks } from '../schema/index.js'
import { connectForTests, databaseTestTarget, MIGRATIONS_FOLDER, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import { attemptsFor } from './attempts.js'

const target = databaseTestTarget()

/**
 * The backfill, tested by running the migration's own SQL rather than a
 * reimplementation of it.
 *
 * A test that rebuilt the walk in TypeScript would pass while the statement that
 * actually runs against the production database was wrong — which is the only
 * failure mode worth guarding here, because the backfill runs exactly once and
 * cannot be corrected by running it again. So the file is read from `drizzle/`
 * and executed as written.
 *
 * `truncateAll` clears `task_attempts` along with everything else, so each case
 * seeds the history it wants and re-runs the statements against it. That is not
 * the migration running twice in production — Drizzle's journal prevents that —
 * it is the same SQL applied to a database whose attempt table is empty, which
 * is the state it was written for.
 */
describe('the attempt backfill', () => {
  let db: Database
  let statements: string[]

  beforeAll(async () => {
    db = await connectForTests(target.url)
    const file = await readFile(join(MIGRATIONS_FOLDER, '0039_backfill_task_attempts.sql'), 'utf8')
    statements = file
      .split('--> statement-breakpoint')
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
  })

  const runBackfill = async (): Promise<void> => {
    for (const statement of statements) {
      await db.execute(sql.raw(statement))
    }
  }

  let seeded = 0

  const anAgent = async (): Promise<AgentId> => {
    const result = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name: `historic-${++seeded}`, platform: 'openclaw' }),
    )
    if (result.outcome !== 'registered') throw new Error(result.outcome)
    return result.agent.id
  }

  const aTask = async (type: string): Promise<TaskId> => {
    const [row] = await db
      .insert(tasks)
      .values({
        type,
        title: 'A rung',
        description: 'What this task is, for a human reading the catalogue.',
        instructions: 'What the agent must actually do.',
        rewardCredits: 0,
        rewardReputation: 1,
        timeoutHours: 24,
        status: 'active',
      })
      .returning({ id: tasks.id })

    if (row === undefined) throw new Error('insert into tasks returned no row')
    return TaskIdSchema.parse(row.id)
  }

  const ago = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString()

  /**
   * The 28 challenges that were issued and never completed are the reason the
   * table exists. If the backfill cannot see them, the first briefing is written
   * from an empty corpus.
   */
  it('reconstructs a challenge that expired with nothing following as abandoned', async () => {
    const agentId = await anAgent()
    const taskId = await aTask('browser-capability')

    await db
      .insert(browserChallenges)
      .values({ agentId, kind: CAPABILITY_STAGE, createdAt: ago(120), expiresAt: ago(110) })

    await runBackfill()

    const [attempt] = await attemptsFor(db, agentId, taskId)
    expect(attempt?.outcome).toBe('abandoned')
    expect(attempt?.opener).toBe('challenge')
  })

  it('marks every reconstructed row as backfilled', async () => {
    const agentId = await anAgent()
    const taskId = await aTask('browser-capability')

    await db
      .insert(browserChallenges)
      .values({ agentId, kind: CAPABILITY_STAGE, createdAt: ago(120), expiresAt: ago(110) })

    await runBackfill()

    expect((await attemptsFor(db, agentId, taskId))[0]?.backfilled).toBe(true)
  })

  /** A challenge and the submission that followed it are one try, not two. */
  it('folds a submission into the challenge that preceded it', async () => {
    const agentId = await anAgent()
    const taskId = await aTask('browser-capability')

    await db
      .insert(browserChallenges)
      .values({ agentId, kind: CAPABILITY_STAGE, createdAt: ago(60), expiresAt: ago(50) })
    await db.insert(submissions).values({
      agentId,
      taskId,
      payload: {},
      status: 'passed',
      attempt: 1,
      submittedAt: ago(55),
      verifiedAt: ago(54),
    })

    await runBackfill()

    const attempts = await attemptsFor(db, agentId, taskId)
    expect(attempts).toHaveLength(1)
    expect(attempts[0]?.outcome).toBe('passed')
    expect(attempts[0]?.opener).toBe('challenge')
  })

  it('gives a task with no challenge behind it an attempt opened by its submission', async () => {
    const agentId = await anAgent()
    const taskId = await aTask('profile-complete')

    await db.insert(submissions).values({
      agentId,
      taskId,
      payload: {},
      status: 'passed',
      attempt: 1,
      submittedAt: ago(30),
      verifiedAt: ago(29),
    })

    await runBackfill()

    const [attempt] = await attemptsFor(db, agentId, taskId)
    expect(attempt?.opener).toBe('submission')
    expect(attempt?.outcome).toBe('passed')
  })

  it('numbers a sequence of tries in the order they happened', async () => {
    const agentId = await anAgent()
    const taskId = await aTask('profile-complete')

    for (const [index, minutes] of [90, 60, 30].entries()) {
      await db.insert(submissions).values({
        agentId,
        taskId,
        payload: {},
        status: index === 2 ? 'passed' : 'failed',
        attempt: index + 1,
        submittedAt: ago(minutes),
        verifiedAt: ago(minutes - 1),
      })
    }

    await runBackfill()

    const attempts = await attemptsFor(db, agentId, taskId)
    expect(attempts.map((a) => a.attempt)).toEqual([1, 2, 3])
    expect(attempts.map((a) => a.outcome)).toEqual(['failed', 'failed', 'passed'])
  })

  /**
   * The rejection case: nothing is invented where the evidence is silent. A
   * submission still waiting for a verdict closes no attempt, because the
   * Colony not having decided is not the citizen's failure.
   */
  it('leaves an attempt open when the submission was never decided', async () => {
    const agentId = await anAgent()
    const taskId = await aTask('profile-complete')

    await db.insert(submissions).values({
      agentId,
      taskId,
      payload: {},
      status: 'pending',
      attempt: 1,
      submittedAt: ago(10),
    })

    await runBackfill()

    const [attempt] = await attemptsFor(db, agentId, taskId)
    expect(attempt?.outcome).toBeNull()
    expect(attempt?.closedAt).toBeNull()
  })

  it('attaches the submission to the attempt it reconstructed', async () => {
    const agentId = await anAgent()
    const taskId = await aTask('profile-complete')

    await db.insert(submissions).values({
      agentId,
      taskId,
      payload: {},
      status: 'passed',
      attempt: 1,
      submittedAt: ago(30),
      verifiedAt: ago(29),
    })

    await runBackfill()

    const [row] = await db
      .select({ attemptId: submissions.attemptId, attempt: submissions.attempt })
      .from(submissions)
      .where(eq(submissions.agentId, agentId))
    const [attempt] = await attemptsFor(db, agentId, taskId)

    expect(row?.attemptId).toBe(attempt?.id)
    expect(row?.attempt).toBe(attempt?.attempt)
  })

  /**
   * A challenge kind with no completion column can open an attempt honestly and
   * can never close one on its own. Nothing here should guess that it passed.
   */
  it('opens but does not decide an attempt for a challenge that records no completion', async () => {
    const agentId = await anAgent()
    const taskId = await aTask('website-verify')

    await db.execute(sql`
      insert into website_challenges (agent_id, token, created_at, expires_at)
      values (${agentId}, ${'kol_verify_deadbeef'}, ${ago(20)}, ${new Date(Date.now() + 600_000).toISOString()})
    `)

    await runBackfill()

    const [attempt] = await attemptsFor(db, agentId, taskId)
    expect(attempt?.opener).toBe('challenge')
    expect(attempt?.outcome).toBeNull()
  })

  it('reconstructs nothing at all from an empty history', async () => {
    await runBackfill()

    const rows = await db.select({ id: taskAttempts.id }).from(taskAttempts)
    expect(rows).toEqual([])
  })
})
