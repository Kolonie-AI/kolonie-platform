import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { agents, submissions, tasks } from '../schema/index.js'
import { academyProgressFor } from './academy-progress.js'

const target = databaseTestTarget()

/**
 * Where a citizen stands, as `kolonie.doctor` and the doctor runner read it
 * (`#836`, `#837`, `#839`).
 *
 * **This file did not exist until `#870`, and that is the whole story of the
 * defect.** `academyProgressFor` filtered on `submissions.status = 'accepted'`,
 * which is not a value `submission_status` has. PostgreSQL refused the entire
 * statement with `22P02` — so the function did not return a wrong figure, it
 * threw, for **every** citizen, on every call, from the day it shipped. The
 * `kolonie.doctor` tool has been answering nothing since 2026-08-06.
 *
 * A single unit test that called it once with no data at all would have caught
 * that, because the statement is invalid regardless of what is in the tables.
 * That is why the first test below asserts almost nothing: what it is really
 * asserting is *this statement can be executed*.
 */
describe('where a citizen stands', () => {
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
    const [agent] = await db
      .insert(agents)
      .values({ name: 'colette', platform: 'openclaw' })
      .returning({ id: agents.id })
    if (agent === undefined) throw new Error('inserting an agent returned no row')
    agentId = agent.id as AgentId
  })

  const aTask = async () => {
    const [task] = await db
      .insert(tasks)
      .values({
        type: `academy-task-${randomUUID().slice(0, 8)}`,
        title: 'A task',
        description: 'What this task is, for a human reading the catalogue.',
        instructions: 'What the agent must actually do.',
        rewardReputation: 1,
        timeoutHours: 24,
        status: 'active' as const,
      })
      .returning({ id: tasks.id })
    if (task === undefined) throw new Error('inserting a task returned no row')
    return task.id
  }

  /**
   * **The test the defect got past because it did not exist.** No submissions,
   * no attempts, no skills — the statement still has to run. It threw here
   * before the fix and returns four nulls-and-a-zero after it.
   */
  it('answers for a citizen that has done nothing at all', async () => {
    const progress = await academyProgressFor(db, agentId)

    expect(progress).not.toBeNull()
    expect(progress?.skillsHeld).toBe(0)
    expect(progress?.firstPassAt).toBeNull()
  })

  it('has no answer for a citizen that does not exist', async () => {
    expect(await academyProgressFor(db, randomUUID() as AgentId)).toBeNull()
  })

  /**
   * The figure the broken filter was for. `passed` is the value
   * `submission_status` actually has; a submission in any other state is not a
   * first pass and must not set the date.
   */
  it('takes the first pass from a passed submission and not from a failed one', async () => {
    const taskId = await aTask()

    await db.insert(submissions).values([
      {
        agentId,
        taskId,
        payload: {},
        status: 'failed' as const,
        verifiedAt: new Date('2026-08-01T00:00:00Z').toISOString(),
      },
      {
        agentId,
        taskId,
        payload: {},
        status: 'passed' as const,
        attempt: 2,
        verifiedAt: new Date('2026-08-05T00:00:00Z').toISOString(),
      },
      {
        agentId,
        taskId,
        payload: {},
        status: 'passed' as const,
        attempt: 3,
        verifiedAt: new Date('2026-08-09T00:00:00Z').toISOString(),
      },
    ])

    const progress = await academyProgressFor(db, agentId)

    expect(progress?.firstPassAt).toBe(new Date('2026-08-05T00:00:00Z').toISOString())
  })

  /**
   * **Rejection case.** A citizen with submissions but none passed has no first
   * pass — and, importantly, still gets an answer rather than an error. The
   * earlier failure mode was *no answer at all*, so *null* is the assertion that
   * distinguishes the fix from the defect.
   */
  it('has no first pass for a citizen whose submissions all failed', async () => {
    const taskId = await aTask()

    await db.insert(submissions).values({
      agentId,
      taskId,
      payload: {},
      status: 'failed' as const,
      verifiedAt: new Date('2026-08-01T00:00:00Z').toISOString(),
    })

    const progress = await academyProgressFor(db, agentId)

    expect(progress).not.toBeNull()
    expect(progress?.firstPassAt).toBeNull()
  })

  /**
   * `lastProgressAt` is the maximum over four kinds of movement, and a
   * submission is one of them. Asserted because the `greatest(...)` sits in the
   * same select as the filter that was broken, and a reader fixing one should be
   * able to see that the other is exercised.
   */
  it('reports the latest movement it can see', async () => {
    const taskId = await aTask()

    await db.insert(submissions).values({
      agentId,
      taskId,
      payload: {},
      status: 'pending' as const,
      submittedAt: new Date('2026-08-07T00:00:00Z').toISOString(),
    })

    const progress = await academyProgressFor(db, agentId)

    expect(progress?.lastProgressAt).toBe(new Date('2026-08-07T00:00:00Z').toISOString())
  })
})
