import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { RegisterAgentRequestSchema, type AgentId, type TaskId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { taskAttempts, taskBriefings, tasks } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import { ENOUGH_TO_SAY, briefingEffect, recordBriefingRead } from './briefing-effect.js'

const target = databaseTestTarget()

/**
 * Whether a briefing changes an outcome (`#609`).
 *
 * What is asserted is the two properties that make the figure usable rather than
 * misleading: the count travels with the rate, and a thin sample says *not
 * enough* rather than a number.
 */
describe('whether briefings help', () => {
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

  let slug = 0
  const aTask = async (): Promise<TaskId> => {
    const [row] = await db
      .insert(tasks)
      .values({
        type: `email-inbox-${++slug}`,
        title: 'Obtain an email address of your own',
        description: 'What this task is.',
        instructions: 'What the agent must do.',
        rewardReputation: 1,
        timeoutHours: 24,
        status: 'active',
      })
      .returning({ id: tasks.id })
    return row!.id as TaskId
  }

  const anAgent = async (name: string): Promise<AgentId> => {
    const result = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name, platform: 'openclaw' }),
    )
    if (result.outcome !== 'registered') throw new Error(result.outcome)
    return result.agent.id
  }

  /** A briefing written at a stated moment, so the two windows are decidable. */
  const aBriefingWrittenAt = async (taskId: TaskId, at: string) => {
    await db.insert(taskBriefings).values({
      taskId,
      claims: [],
      model: 'vendor/some-model-v1',
      writtenAt: at,
      dirty: false,
    })
  }

  let attempt = 0
  const anAttempt = async (
    taskId: TaskId,
    agentId: AgentId,
    outcome: 'passed' | 'failed',
    closedAt: string,
  ) => {
    await db.insert(taskAttempts).values({
      taskId,
      agentId,
      attempt: ++attempt,
      opener: 'submission',
      openedAt: closedAt,
      closedAt,
      outcome,
    })
  }

  const BEFORE = '2026-01-01T00:00:00.000Z'
  const LINE = '2026-06-01T00:00:00.000Z'
  const AFTER = '2026-07-01T00:00:00.000Z'

  it('splits the attempts either side of the moment the briefing was written', async () => {
    const taskId = await aTask()
    await aBriefingWrittenAt(taskId, LINE)
    const agentId = await anAgent('canary')

    await anAttempt(taskId, agentId, 'failed', BEFORE)
    await anAttempt(taskId, agentId, 'failed', BEFORE)
    await anAttempt(taskId, agentId, 'passed', AFTER)

    const [row] = await briefingEffect(db)

    expect(row?.before).toEqual({ attempts: 2, passed: 0 })
    expect(row?.after).toEqual({ attempts: 1, passed: 1 })
  })

  /**
   * **The sample is small, and the figure has to say so.** A rate over four
   * attempts is noise with a decimal point, so `enough` is what the surface
   * reads rather than the surface deciding for itself.
   */
  it('says the sample is too thin rather than offering a rate', async () => {
    const taskId = await aTask()
    await aBriefingWrittenAt(taskId, LINE)
    const agentId = await anAgent('canary')

    await anAttempt(taskId, agentId, 'failed', BEFORE)
    await anAttempt(taskId, agentId, 'passed', AFTER)

    const [row] = await briefingEffect(db)

    expect(row?.enough).toBe(false)
  })

  it('says the sample is enough once both sides clear the floor', async () => {
    const taskId = await aTask()
    await aBriefingWrittenAt(taskId, LINE)
    const agentId = await anAgent('canary')

    for (let n = 0; n < ENOUGH_TO_SAY; n++) await anAttempt(taskId, agentId, 'failed', BEFORE)
    for (let n = 0; n < ENOUGH_TO_SAY; n++) await anAttempt(taskId, agentId, 'passed', AFTER)

    const [row] = await briefingEffect(db)

    expect(row?.enough).toBe(true)
    expect(row?.before.attempts).toBe(ENOUGH_TO_SAY)
    expect(row?.after.passed).toBe(ENOUGH_TO_SAY)
  })

  /**
   * The cheaper measure, and the one that decides whether the other means
   * anything: if nothing reads a briefing, its pass rate is answering a question
   * nobody asked.
   */
  it('counts how often a briefing has been read', async () => {
    const taskId = await aTask()
    await aBriefingWrittenAt(taskId, LINE)

    expect((await briefingEffect(db))[0]?.reads).toBe(0)

    await recordBriefingRead(db, taskId)
    await recordBriefingRead(db, taskId)

    expect((await briefingEffect(db))[0]?.reads).toBe(2)
  })

  /**
   * **It never fails the read it instruments.** This rides on the path that
   * serves a briefing to a citizen, and a measurement that can stand between an
   * agent and its next attempt is worse than no measurement — the rule
   * `recordOrigin` is written to, for the same reason.
   */
  it('answers rather than throwing for a task that is not there', async () => {
    const absent = '11111111-2222-4333-8444-555555555555' as TaskId

    await expect(recordBriefingRead(db, absent)).resolves.toBeUndefined()
  })

  /**
   * The count outlives the briefing it counts, which is why it is its own table:
   * `#611` made an empty briefing no row at all, and the reads still happened.
   */
  it('keeps the count when the briefing is deleted', async () => {
    const taskId = await aTask()
    await aBriefingWrittenAt(taskId, LINE)
    await recordBriefingRead(db, taskId)

    await db.delete(taskBriefings).where(eq(taskBriefings.taskId, taskId))
    await aBriefingWrittenAt(taskId, LINE)

    expect((await briefingEffect(db))[0]?.reads).toBe(1)
  })

  it('lists nothing when no briefing has been written', async () => {
    await aTask()

    expect(await briefingEffect(db)).toEqual([])
  })
})
