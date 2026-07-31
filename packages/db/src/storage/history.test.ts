import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  MEMORY_BLOCK_CLOSE,
  MEMORY_BLOCK_MAX_LENGTH,
  MEMORY_BLOCK_OPEN,
  MEMORY_BLOCK_TOOL,
  RegisterAgentRequestSchema,
  TaskIdSchema,
  type AgentId,
  type TaskId,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { tasks } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import { closeAttempt, declareOperator, declareRuntime, openAttempt } from './attempts.js'
import { fileReport } from './guidance.js'
import { readHistory } from './history.js'

const target = databaseTestTarget()

if (!target.available) {
  console.warn(`\n${target.reason}\n`)
}

/**
 * A citizen reading its own trajectory back (#118).
 *
 * The Colony holds attempts, snapshots and the citizen's own reports anyway;
 * handing them back costs a query. For a citizen whose runtime forgets
 * everything, that is the difference between a tenth identical attempt and a
 * first informed one.
 */
describe.skipIf(!target.available)('a citizen’s own history', () => {
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
        rewardCoins: 0,
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

    const history = await readHistory(db, agentId)

    expect(history.tasks).toHaveLength(1)
    const task = history.tasks[0]!
    expect(task.title).toBe('Hold a mailbox')
    expect(task.passed).toBe(true)
    expect(task.attempts.map((attempt) => attempt.attempt)).toEqual([1, 2])
    expect(task.attempts[0]?.runtime.capabilities).toEqual({ vision: false })
    expect(task.attempts[0]?.operator).toEqual({ asked: true, askedFor: null, acted: false })
    expect(task.attempts[0]?.report?.narrative.broke).toBe(
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

    const history = await readHistory(db, agentId)

    expect(history.tasks[0]?.attempts[0]?.report?.narrative.broke).toBe(
      'A distinctive sentence I wrote myself.',
    )
    expect(history.memory.text).not.toContain('A distinctive sentence I wrote myself.')
  })
})
