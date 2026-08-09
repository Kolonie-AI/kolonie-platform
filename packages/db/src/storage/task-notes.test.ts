import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { RegisterAgentRequestSchema, type AgentId, type TaskId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import { tasks } from '../schema/tasks.js'
import { readTaskNote, writeTaskNote } from './task-notes.js'

const target = databaseTestTarget()

describe('a citizen’s private note on a rung', () => {
  let db: Database
  let taskId: TaskId
  let otherTaskId: TaskId

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  const aTask = async (type: string): Promise<TaskId> => {
    const [row] = await db
      .insert(tasks)
      .values({
        type,
        title: `Whatever ${type} asks for`,
        description: 'What this task is.',
        instructions: 'What the agent must do.',
        rewardReputation: 1,
        timeoutHours: 24,
        status: 'active',
      })
      .returning({ id: tasks.id })
    return row!.id as TaskId
  }

  beforeEach(async () => {
    await truncateAll(db)
    taskId = await aTask('a-rung')
    otherTaskId = await aTask('another-rung')
  })

  let seeded = 0

  const anAgent = async (): Promise<AgentId> => {
    const result = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name: `noting-${++seeded}`, platform: 'openclaw' }),
    )
    if (result.outcome !== 'registered') throw new Error(result.outcome)
    return result.agent.id
  }

  it('writes a note and reads the same one back', async () => {
    const agentId = await anAgent()

    const written = await writeTaskNote(db, agentId, taskId, 'IMAP is dead here; use the REST API')

    expect(written?.note).toBe('IMAP is dead here; use the REST API')
    expect(await readTaskNote(db, agentId, taskId)).toEqual(written)
  })

  it('answers with nothing where none was written', async () => {
    expect(await readTaskNote(db, await anAgent(), taskId)).toBeNull()
  })

  /** What the citizen asked for: newest replaces oldest, no history kept. */
  it('replaces the note rather than accumulating them', async () => {
    const agentId = await anAgent()
    await writeTaskNote(db, agentId, taskId, 'the first thing I thought')
    await writeTaskNote(db, agentId, taskId, 'what turned out to be true')

    expect((await readTaskNote(db, agentId, taskId))?.note).toBe('what turned out to be true')
    const [row] = await db.execute<{ count: string }>(sql`select count(*) from task_notes`)
    expect(row?.count).toBe('1')
  })

  it('clears the note when the write is null, and clearing twice is not an error', async () => {
    const agentId = await anAgent()
    await writeTaskNote(db, agentId, taskId, 'something')

    expect(await writeTaskNote(db, agentId, taskId, null)).toBeNull()
    expect(await readTaskNote(db, agentId, taskId)).toBeNull()
    expect(await writeTaskNote(db, agentId, taskId, null)).toBeNull()
  })

  /**
   * The property the whole table rests on. A note another citizen can read is a
   * report that skipped moderation, and there is no read here that can produce
   * one — `readTaskNote` takes the agent, and this asserts the agent is used.
   */
  it('is invisible to every citizen but its author', async () => {
    const author = await anAgent()
    const stranger = await anAgent()
    await writeTaskNote(db, author, taskId, 'what I worked out')

    expect(await readTaskNote(db, stranger, taskId)).toBeNull()
  })

  it('keeps one note per task rather than one per citizen', async () => {
    const agentId = await anAgent()
    await writeTaskNote(db, agentId, taskId, 'about the first rung')
    await writeTaskNote(db, agentId, otherTaskId, 'about the second')

    expect((await readTaskNote(db, agentId, taskId))?.note).toBe('about the first rung')
    expect((await readTaskNote(db, agentId, otherTaskId))?.note).toBe('about the second')
  })

  it('goes when its author does', async () => {
    const agentId = await anAgent()
    await writeTaskNote(db, agentId, taskId, 'something')

    await db.execute(sql`delete from agents where id = ${agentId}`)

    const [row] = await db.execute<{ count: string }>(sql`select count(*) from task_notes`)
    expect(row?.count).toBe('0')
  })
})
