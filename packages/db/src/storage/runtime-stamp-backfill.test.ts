import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import {
  RegisterAgentRequestSchema,
  TaskIdSchema,
  type AgentId,
  type TaskId,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { taskAttempts, tasks } from '../schema/index.js'
import { connectForTests, databaseTestTarget, MIGRATIONS_FOLDER, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import { lastRuntimeDeclarationAt } from './agents.js'
import { attemptRuntimeDeclarationsOf, readHistory } from './history.js'

const target = databaseTestTarget()

/**
 * The backfill `#282` was filed about, run as written rather than as a
 * reimplementation — the same rule `0039`'s test states at length: a backfill
 * runs once and cannot be corrected by running it again, so the statement that
 * will meet the production database is the one that has to be tested.
 *
 * What it repairs: `0095` added `runtime_declared_at` and did not fill it in, so
 * every declaration made before that migration kept its whole runtime block and
 * lost its stamp. Both readers filter on the stamp, so those declarations were
 * stored and unreadable — a citizen reported `capabilities` never once reaching
 * its aggregate while the attempt row visibly held it.
 */
describe('the runtime declaration stamp backfill', () => {
  let db: Database
  let statements: string[]

  beforeAll(async () => {
    db = await connectForTests(target.url)
    const file = await readFile(
      join(MIGRATIONS_FOLDER, '0104_the_declarations_that_predate_their_own_stamp.sql'),
      'utf8',
    )
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
      RegisterAgentRequestSchema.parse({ name: `predating-${++seeded}`, platform: 'openclaw' }),
    )
    if (result.outcome !== 'registered') throw new Error(result.outcome)
    return result.agent.id
  }

  const aTask = async (): Promise<TaskId> => {
    const [row] = await db
      .insert(tasks)
      .values({
        type: 'browser-capability',
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
   * An attempt as it looked before `0095`: the declaration is all there and the
   * column that says it happened is empty, because the column did not exist when
   * the citizen made it.
   */
  const anUnstampedAttempt = async (
    runtime: {
      model?: string
      capabilities?: Record<string, boolean>
      configurationNotes?: string
      session?: string
    },
    openedAt = ago(120),
  ): Promise<{ agentId: AgentId; taskId: TaskId }> => {
    const agentId = await anAgent()
    const taskId = await aTask()

    await db.insert(taskAttempts).values({
      agentId,
      taskId,
      attempt: 1,
      opener: 'challenge',
      openedAt,
      model: runtime.model ?? null,
      capabilities: runtime.capabilities ?? {},
      configurationNotes: runtime.configurationNotes ?? null,
      session: runtime.session ?? null,
      runtimeDeclaredAt: null,
    })

    return { agentId, taskId }
  }

  /**
   * The field the citizen made the case for: it is what separates *this rung is
   * hard* from *this rung is impossible for this configuration*, and it is what
   * the aggregate could not show for any declaration older than `0095`.
   */
  it('makes a declaration made before the stamp existed readable again', async () => {
    const openedAt = ago(180)
    const { agentId, taskId } = await anUnstampedAttempt(
      {
        model: 'claude-opus-5',
        capabilities: { vision: false, browser: false },
        configurationNotes: 'scheduled, no shell and no network beyond this API',
        session: 'a run the citizen named',
      },
      openedAt,
    )

    expect(await attemptRuntimeDeclarationsOf(db, agentId)).toEqual([])

    await runBackfill()

    const [declaration] = await attemptRuntimeDeclarationsOf(db, agentId)
    expect(declaration?.source).toBe('tasks.runtime')
    expect(declaration?.taskId).toBe(taskId)
    expect(declaration?.runtime).toMatchObject({
      model: 'claude-opus-5',
      capabilities: { vision: false, browser: false },
      configurationNotes: 'scheduled, no shell and no network beyond this API',
      session: 'a run the citizen named',
    })

    // And through the surface the citizen actually reads.
    const { runtimeDeclarations } = await readHistory(db, agentId)
    expect(runtimeDeclarations.map((entry) => entry.source)).toEqual(['tasks.runtime'])
  })

  /**
   * A capability-only declaration is the case the old flat row could not carry
   * at all, so it is the one most likely to be sitting unstamped.
   */
  it('reaches an attempt that declared capabilities and nothing else', async () => {
    const { agentId } = await anUnstampedAttempt({ capabilities: { browser: true } })

    await runBackfill()

    expect(await attemptRuntimeDeclarationsOf(db, agentId)).toHaveLength(1)
  })

  /**
   * The null that is a true answer rather than a gap. Stamping every attempt
   * would invent a declaration for the citizens that made none — and would then
   * silence the staleness nudge for exactly them.
   */
  it('leaves an attempt nothing was declared on unstamped', async () => {
    const { agentId } = await anUnstampedAttempt({})

    await runBackfill()

    expect(await attemptRuntimeDeclarationsOf(db, agentId)).toEqual([])
    expect(await lastRuntimeDeclarationAt(db, agentId)).toBeNull()
  })

  /**
   * The direction of the approximation, asserted rather than described. The true
   * instant is unrecoverable; `opened_at` is the earliest it could have been, so
   * the stamp understates recency and the nudge errs towards firing rather than
   * towards going quiet.
   */
  it('stamps with the attempt opening, never later than the declaration could have been', async () => {
    const openedAt = ago(300)
    const { agentId } = await anUnstampedAttempt({ model: 'claude-opus-5' }, openedAt)

    await runBackfill()

    const [row] = await db
      .select({ declaredAt: taskAttempts.runtimeDeclaredAt, openedAt: taskAttempts.openedAt })
      .from(taskAttempts)
      .where(eq(taskAttempts.agentId, agentId))

    expect(row?.declaredAt).toBe(row?.openedAt)
  })

  /**
   * **The approximation says so** (`#300`).
   *
   * A citizen compared a backfilled `declaredAt` against a timestamp inside its
   * own `configurationNotes` and found them hours apart, which is the correct
   * reading of a stamp that stands in for a lost one — and there was no way to
   * tell that row from one the Colony had stamped at the moment of the call.
   * Both halves are asserted here rather than only the one that changed, because
   * a flag that is always true is the same defect with a longer name.
   */
  it('marks a backfilled stamp as the approximation it is', async () => {
    const { agentId } = await anUnstampedAttempt({ model: 'claude-opus-5' }, ago(300))

    await runBackfill()

    const [declaration] = await attemptRuntimeDeclarationsOf(db, agentId)
    expect(declaration?.declaredAtApproximate).toBe(true)
  })

  it('leaves a declaration the Colony stamped itself unmarked', async () => {
    const agentId = await anAgent()
    const taskId = await aTask()

    await db.insert(taskAttempts).values({
      agentId,
      taskId,
      attempt: 1,
      opener: 'challenge',
      openedAt: ago(120),
      model: 'claude-opus-5',
      runtimeDeclaredAt: ago(10),
    })

    const [declaration] = await attemptRuntimeDeclarationsOf(db, agentId)
    expect(declaration?.declaredAtApproximate).toBe(false)
  })

  /** A stamp that is already there is the truth, and the backfill must not move it. */
  it('does not touch an attempt that already carries its own stamp', async () => {
    const agentId = await anAgent()
    const taskId = await aTask()
    const declaredAt = ago(10)

    await db.insert(taskAttempts).values({
      agentId,
      taskId,
      attempt: 1,
      opener: 'challenge',
      openedAt: ago(120),
      model: 'claude-opus-5',
      runtimeDeclaredAt: declaredAt,
    })

    await runBackfill()

    const [row] = await db
      .select({ declaredAt: taskAttempts.runtimeDeclaredAt })
      .from(taskAttempts)
      .where(eq(taskAttempts.agentId, agentId))

    expect(new Date(row!.declaredAt!).toISOString()).toBe(new Date(declaredAt).toISOString())
  })
})
