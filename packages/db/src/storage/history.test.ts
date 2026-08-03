import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  HistoryRequestSchema,
  MEMORY_BLOCK_CLOSE,
  MEMORY_BLOCK_MAX_LENGTH,
  MEMORY_BLOCK_OPEN,
  MEMORY_BLOCK_TOOL,
  RegisterAgentRequestSchema,
  TaskIdSchema,
  type AgentId,
  type TaskId,
} from '@kolonie-ai/core'
import { eq, sql } from 'drizzle-orm'
import type { Database } from '../client.js'
import { taskAttempts, tasks } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent, updateAgentProfile } from './agents.js'
import { closeAttempt, declareOperator, declareRuntime, openAttempt } from './attempts.js'
import { fileReport } from './guidance.js'
import { readHistory } from './history.js'

const target = databaseTestTarget()

/**
 * A citizen reading its own trajectory back (#118).
 *
 * The Colony holds attempts, snapshots and the citizen's own reports anyway;
 * handing them back costs a query. For a citizen whose runtime forgets
 * everything, that is the difference between a tenth identical attempt and a
 * first informed one.
 */
describe('a citizen’s own history', () => {
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

  const anAgent = async (): Promise<AgentId> => {
    const result = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name: `canary-${++seeded}`, platform: 'openclaw' }),
    )
    if (result.outcome !== 'registered') throw new Error(result.outcome)
    return result.agent.id
  }

  const aTask = async (title = 'A rung'): Promise<TaskId> => {
    const [row] = await db
      .insert(tasks)
      .values({
        type: `academy-task-${++seeded}`,
        title,
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

  it('answers a citizen that has done nothing, plainly', async () => {
    const history = await readHistory(db, await anAgent())

    expect(history.tasks).toEqual([])
    expect(history.memory.text).toContain('not attempted anything')
    expect(history.memory.regenerateWith).toBe(MEMORY_BLOCK_TOOL)
  })

  it('returns its attempts in order, with runtime, operator and its own report', async () => {
    const agentId = await anAgent()
    const taskId = await aTask('Hold a mailbox')

    const first = await openAttempt(db, { agentId, taskId, opener: 'challenge' })
    await declareRuntime(db, agentId, taskId, {
      model: 'some-model-v3',
      capabilities: { vision: false },
    })
    await declareOperator(db, agentId, taskId, { asked: true, acted: false })
    await fileReport(db, {
      taskId,
      agentId,
      narrative: { did: null, broke: 'The signup form asked for a phone number.', changed: null },
    })
    await closeAttempt(db, first.id, 'failed')

    const second = await openAttempt(db, { agentId, taskId, opener: 'challenge' })
    await declareRuntime(db, agentId, taskId, { capabilities: { vision: true } })
    await closeAttempt(db, second.id, 'passed')

    const history = await readHistory(db, agentId, HistoryRequestSchema.parse({ full: true }))

    expect(history.tasks).toHaveLength(1)
    const task = history.tasks[0]!
    expect(task.title).toBe('Hold a mailbox')
    expect(task.passed).toBe(true)
    expect(task.attempts.map((attempt) => attempt.attempt)).toEqual([1, 2])
    expect(task.attempts[0]?.runtime.capabilities).toEqual({ vision: false })
    expect(task.attempts[0]?.operator).toEqual({ asked: true, askedFor: null, acted: false })
    expect(task.attempts[0]?.report?.narrative?.broke).toBe(
      'The signup form asked for a phone number.',
    )
    expect(task.attempts[1]?.report).toBeNull()
  })

  /**
   * The rejection case #118 names by name: no parameter exists that returns
   * another agent's history — and the storage read is where that has to be true,
   * because the route above it has nothing else to lean on.
   */
  it('never returns another citizen’s attempts', async () => {
    const mine = await anAgent()
    const theirs = await anAgent()
    const taskId = await aTask()

    const other = await openAttempt(db, { agentId: theirs, taskId, opener: 'challenge' })
    await fileReport(db, {
      taskId,
      agentId: theirs,
      narrative: { did: null, broke: 'Something only they saw.', changed: null },
    })
    await closeAttempt(db, other.id, 'failed')

    const own = await openAttempt(db, { agentId: mine, taskId, opener: 'challenge' })
    await closeAttempt(db, own.id, 'failed')

    const history = await readHistory(db, mine)

    expect(history.tasks).toHaveLength(1)
    expect(history.tasks[0]?.attempts).toHaveLength(1)
    expect(JSON.stringify(history)).not.toContain('Something only they saw.')
  })

  it('bounds the block whatever the history is', async () => {
    const agentId = await anAgent()

    for (let i = 0; i < 40; i++) {
      const taskId = await aTask(`A rung with a fairly long title, number ${i}`)
      const attempt = await openAttempt(db, { agentId, taskId, opener: 'challenge' })
      await declareRuntime(db, agentId, taskId, { capabilities: { vision: false, browser: false } })
      await closeAttempt(db, attempt.id, 'failed')
    }

    const history = await readHistory(db, agentId)

    expect(history.tasks).toHaveLength(40)
    expect(history.memory.text.length).toBeLessThanOrEqual(
      MEMORY_BLOCK_MAX_LENGTH + MEMORY_BLOCK_CLOSE.length + 2,
    )
    expect(history.memory.text.startsWith(MEMORY_BLOCK_OPEN)).toBe(true)
    expect(history.memory.text.endsWith(MEMORY_BLOCK_CLOSE)).toBe(true)
  })

  /**
   * A citizen's own words are served back to it — that is the view's whole point
   * — but never inside the block, which is the part that travels into a file and
   * is read on runs that know nothing of where it came from.
   */
  it('keeps prose out of the take-away block', async () => {
    const agentId = await anAgent()
    const taskId = await aTask()
    const attempt = await openAttempt(db, { agentId, taskId, opener: 'challenge' })
    await fileReport(db, {
      taskId,
      agentId,
      narrative: { did: null, broke: 'A distinctive sentence I wrote myself.', changed: null },
    })
    await closeAttempt(db, attempt.id, 'failed')

    const history = await readHistory(db, agentId, HistoryRequestSchema.parse({ full: true }))

    expect(history.tasks[0]?.attempts[0]?.report?.narrative?.broke).toBe(
      'A distinctive sentence I wrote myself.',
    )
    expect(history.memory.text).not.toContain('A distinctive sentence I wrote myself.')
  })

  /**
   * The three arguments `#259` added: a response that can never shrink, on the
   * one call a stateless citizen makes every run, finally has a way to be asked
   * for less.
   */
  describe('asking for less of it', () => {
    /** A task attempted once, with a report, at a stated distance in the past. */
    const anAttemptAgo = async (agentId: AgentId, hoursAgo: number, broke: string) => {
      const taskId = await aTask(`A rung ${hoursAgo}h ago`)
      const attempt = await openAttempt(db, { agentId, taskId, opener: 'challenge' })
      await fileReport(db, { taskId, agentId, narrative: { did: null, broke, changed: null } })
      await closeAttempt(db, attempt.id, 'failed')
      await db
        .update(taskAttempts)
        .set({ openedAt: sql`now() - make_interval(hours => ${hoursAgo})` })
        .where(eq(taskAttempts.id, attempt.id))
      return taskId
    }

    it('drops the long prose by default and keeps everything that identifies', async () => {
      const agentId = await anAgent()
      await anAttemptAgo(agentId, 1, 'A distinctive sentence I wrote myself.')

      const history = await readHistory(db, agentId)

      const report = history.tasks[0]?.attempts[0]?.report
      // Absent rather than null: *you did not ask* is not *there is none*.
      expect(report?.narrative).toBeUndefined()
      expect(report?.contributedTo).toBeUndefined()
      // What a citizen needs to decide whether to come back for the text.
      expect(report?.id).toBeDefined()
      expect(report?.status).toBeDefined()
      expect(history.tasks[0]?.title).toBeDefined()
      expect(history.tasks[0]?.attempts[0]?.outcome).toBe('failed')
    })

    it('hands back the whole of it when asked', async () => {
      const agentId = await anAgent()
      await anAttemptAgo(agentId, 1, 'A distinctive sentence I wrote myself.')

      const history = await readHistory(db, agentId, HistoryRequestSchema.parse({ full: true }))

      expect(history.tasks[0]?.attempts[0]?.report?.narrative?.broke).toBe(
        'A distinctive sentence I wrote myself.',
      )
      expect(history.tasks[0]?.attempts[0]?.report?.contributedTo).toEqual([])
    })

    it('answers with the attempts inside the window and no empty tasks beside them', async () => {
      const agentId = await anAgent()
      await anAttemptAgo(
        agentId,
        48,
        'The older wall, written out at a length the field constraint accepts.',
      )
      await anAttemptAgo(
        agentId,
        1,
        'The recent wall, written out at a length the field constraint accepts.',
      )

      const since = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString()
      const history = await readHistory(db, agentId, HistoryRequestSchema.parse({ since }))

      // The older task is gone entirely rather than present with no attempts: a
      // title with no tries reads like a task never attempted.
      expect(history.tasks).toHaveLength(1)
      expect(history.tasks[0]?.title).toBe('A rung 1h ago')
    })

    it('scopes to one task for a citizen about to attempt that rung again', async () => {
      const agentId = await anAgent()
      await anAttemptAgo(
        agentId,
        48,
        'The older wall, written out at a length the field constraint accepts.',
      )
      const wanted = await anAttemptAgo(
        agentId,
        1,
        'The recent wall, written out at a length the field constraint accepts.',
      )

      const history = await readHistory(db, agentId, HistoryRequestSchema.parse({ taskId: wanted }))

      expect(history.tasks.map((task) => task.taskId)).toEqual([wanted])
    })

    /**
     * The trap this whole design is arranged around. The block is *stored*, and
     * a citizen narrowing its reading and then pasting the result over its
     * memory file would replace a complete record with a fragment of one.
     */
    it('regenerates the memory block from the whole record whatever was asked', async () => {
      const agentId = await anAgent()
      await anAttemptAgo(
        agentId,
        48,
        'The older wall, written out at a length the field constraint accepts.',
      )
      const wanted = await anAttemptAgo(
        agentId,
        1,
        'The recent wall, written out at a length the field constraint accepts.',
      )

      const whole = await readHistory(db, agentId)
      const narrowed = await readHistory(
        db,
        agentId,
        HistoryRequestSchema.parse({ taskId: wanted }),
      )

      expect(narrowed.tasks).toHaveLength(1)
      expect(narrowed.memory).toEqual(whole.memory)
      // And the bio material with it: *tasks attempted since Tuesday* would be a
      // false statement about a citizen.
      expect(narrowed.material).toEqual(whole.material)
    })
  })

  /**
   * The aggregate `#228` was filed about: one sequence, both sources, each
   * saying which call made it.
   */
  describe('what it has said it runs on', () => {
    it('carries both kinds of declaration, newest first, each marked', async () => {
      const agentId = await anAgent()
      const taskId = await aTask()
      await openAttempt(db, { agentId, taskId, opener: 'challenge' })

      await updateAgentProfile(db, agentId, { model: 'declared-on-the-profile' })
      await declareRuntime(db, agentId, taskId, {
        model: 'declared-on-the-attempt',
        capabilities: { vision: true },
      })

      const { runtimeDeclarations } = await readHistory(db, agentId)

      // Both present, newest first, and a reader can tell which call wrote
      // which — `model` used to appear twice with nothing saying that.
      expect(runtimeDeclarations.map((row) => row.source)).toEqual(['tasks.runtime', 'profile'])

      const [attempt] = runtimeDeclarations
      if (attempt?.source !== 'tasks.runtime') throw new Error('expected the attempt declaration')
      expect(attempt.taskId).toBe(taskId)
      expect(attempt.attempt).toBe(1)
      expect(attempt.runtime.capabilities).toEqual({ vision: true })
    })

    it('says nothing about a citizen that has declared nothing', async () => {
      const { runtimeDeclarations } = await readHistory(db, await anAgent())

      expect(runtimeDeclarations).toEqual([])
    })
  })
})
