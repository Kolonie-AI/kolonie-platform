import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import {
  RegisterAgentRequestSchema,
  TaskIdSchema,
  type AgentId,
  type TaskId,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { taskBriefings, taskReports, tasks } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import { closeAttempt, openAttempt } from './attempts.js'
import {
  CHANGE_DISTINCT_REPORTERS,
  CHANGE_STABILITY_ATTEMPTS,
  detectProviderChange,
  readBriefing,
  recordProviderChange,
  writeBriefing,
} from './briefing.js'
import { fileReport } from './guidance.js'

const target = databaseTestTarget()

/**
 * The tripwire (#115): a cluster of distinct reports on a stable task means the
 * provider changed.
 */
describe('the provider-change tripwire', () => {
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

  const aTask = async (): Promise<TaskId> => {
    const [row] = await db
      .insert(tasks)
      .values({
        type: `academy-task-${++seeded}`,
        title: 'A rung',
        description: 'What this task is, for a human reading the catalogue.',
        instructions: 'What the agent must actually do.',
        rewardReputation: 1,
        timeoutHours: 24,
        status: 'active',
        /**
         * A task whose wording has been settled for a year.
         *
         * The column defaults to now, and a revision demotes every claim not
         * confirmed since it (#182) — so a fixture task created in this tick
         * would demote the claims these tests write with older timestamps,
         * before the tripwire got a chance to. Production cannot reach that
         * state: nothing can be reported about a task before it exists.
         */
        textRevisedAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(),
      })
      .returning({ id: tasks.id })

    if (row === undefined) throw new Error('insert into tasks returned no row')
    return TaskIdSchema.parse(row.id)
  }

  /** Closed attempts that carry no report — history, so the task counts as stable. */
  const settle = async (taskId: TaskId, count: number) => {
    const agentId = await anAgent()
    for (let i = 0; i < count; i++) {
      const attempt = await openAttempt(db, { agentId, taskId, opener: 'challenge' })
      await closeAttempt(db, attempt.id, 'passed')
    }
  }

  /**
   * One agent reporting something the moderator judged new, optionally a while
   * back — which is how a task is given a history to be measured against (#598).
   */
  const reportsSomethingNew = async (
    taskId: TaskId,
    agentId: AgentId,
    text: string,
    daysAgo = 0,
  ) => {
    const attempt = await openAttempt(db, { agentId, taskId, opener: 'challenge' })
    const filed = await fileReport(db, {
      taskId,
      agentId,
      narrative: { did: null, broke: text, changed: null, discarded: null },
    })
    if (filed.outcome !== 'recorded') throw new Error(filed.outcome)

    // Approved *is* distinct: the dedup stage merges a restatement and approves
    // something it has not seen.
    await db
      .update(taskReports)
      .set({
        status: 'approved',
        moderatedAt: sql`now()`,
        confirmations: 1,
        ...(daysAgo === 0 ? {} : { createdAt: sql`now() - make_interval(days => ${daysAgo})` }),
      })
      .where(eq(taskReports.attemptId, attempt.id))

    await closeAttempt(db, attempt.id, 'failed')
  }

  /**
   * A rung that has been carrying four distinct citizens a window for the last
   * three windows — the shape the `raster` rung was in when it tripped the
   * absolute threshold (#598). Reuses the same agents in each window on purpose:
   * what a window carries is the question, so an agent that comes back next week
   * counts in both.
   */
  const busyForThreeWindows = async (taskId: TaskId, agentIds: readonly AgentId[]) => {
    for (const daysAgo of [3, 5, 7]) {
      for (const [i, agentId] of agentIds.entries()) {
        await reportsSomethingNew(
          taskId,
          agentId,
          `A wall, ${daysAgo} days ago, agent ${i}.`,
          daysAgo,
        )
      }
    }
  }

  it('fires when enough distinct citizens report something new on a stable task', async () => {
    const taskId = await aTask()
    await settle(taskId, CHANGE_STABILITY_ATTEMPTS)

    for (let i = 0; i < CHANGE_DISTINCT_REPORTERS; i++) {
      await reportsSomethingNew(taskId, await anAgent(), `A new wall, seen by agent ${i}.`)
    }

    const change = await detectProviderChange(db, taskId)

    expect(change).toMatchObject({
      taskId,
      reporters: CHANGE_DISTINCT_REPORTERS,
      // Nothing behind it, so the floor is the whole bar.
      baseline: 0,
      required: CHANGE_DISTINCT_REPORTERS,
    })
  })

  /**
   * The false positive that #598 is (`#598`).
   *
   * The `raster` rung had been collecting about two reports a day since the day
   * it went active, so three distinct citizens in 48 hours was its ordinary
   * Tuesday — and an absolute threshold cannot tell that from a change. A busy
   * rung would trip this forever, which is the failure mode where the tripwire
   * stops being read at all.
   */
  it('does not fire on a cluster a busy rung carries every window anyway', async () => {
    const taskId = await aTask()
    await settle(taskId, CHANGE_STABILITY_ATTEMPTS)

    const regulars = [await anAgent(), await anAgent(), await anAgent(), await anAgent()]
    await busyForThreeWindows(taskId, regulars)

    for (let i = 0; i < CHANGE_DISTINCT_REPORTERS; i++) {
      await reportsSomethingNew(taskId, await anAgent(), `The same sort of wall again, ${i}.`)
    }

    expect(await detectProviderChange(db, taskId)).toBeNull()
  })

  /** The other half: the same rung, when the traffic really does double. */
  it('fires on the same rung once the cluster clears its own baseline', async () => {
    const taskId = await aTask()
    await settle(taskId, CHANGE_STABILITY_ATTEMPTS)

    const regulars = [await anAgent(), await anAgent(), await anAgent(), await anAgent()]
    await busyForThreeWindows(taskId, regulars)

    for (let i = 0; i < 8; i++) {
      await reportsSomethingNew(taskId, await anAgent(), `Something nobody described before, ${i}.`)
    }

    expect(await detectProviderChange(db, taskId)).toMatchObject({
      taskId,
      reporters: 8,
      baseline: 4,
      required: 8,
    })
  })

  /**
   * A rung with barely any history is judged on the floor alone (`#598`). Too
   * little history reads as a low baseline, and a low baseline would let the
   * relative test wave through anything the floor already allows — so it is
   * stated rather than left to the arithmetic.
   */
  it('judges a rung with less than two windows behind it on the floor alone', async () => {
    const taskId = await aTask()
    await settle(taskId, CHANGE_STABILITY_ATTEMPTS)

    await reportsSomethingNew(taskId, await anAgent(), 'The one thing said about this so far.', 3)

    for (let i = 0; i < CHANGE_DISTINCT_REPORTERS; i++) {
      await reportsSomethingNew(taskId, await anAgent(), `A new wall, seen by agent ${i}.`)
    }

    expect(await detectProviderChange(db, taskId)).toMatchObject({
      taskId,
      required: CHANGE_DISTINCT_REPORTERS,
    })
  })

  /**
   * The sharpest version of the signal this tripwire exists for (#169).
   *
   * A cluster of citizens saying in one window that a rung cannot be *started*
   * is a provider change by any reading — and it is the one case where nobody
   * got far enough to be uncertain about the cause. Until this, the inner join
   * on the attempt made them invisible here for the same accidental reason it
   * made them invisible to the briefing.
   */
  it('fires on a cluster of citizens that could not start the task at all', async () => {
    const taskId = await aTask()
    // History from before the rung stopped being startable, so the task is
    // stable. Without it the stability gate — correctly — refuses to conclude
    // anything about a task nobody has finished.
    await settle(taskId, CHANGE_STABILITY_ATTEMPTS)

    for (let i = 0; i < CHANGE_DISTINCT_REPORTERS; i++) {
      const agentId = await anAgent()
      const filed = await fileReport(db, {
        taskId,
        agentId,
        narrative: {
          did: null,
          broke: `Agent ${i}: the provider's page will not load at all, so I never got started.`,
          changed: null,
          discarded: null,
        },
      })
      if (filed.outcome !== 'recorded') throw new Error(filed.outcome)
      await db
        .update(taskReports)
        .set({ status: 'approved', moderatedAt: sql`now()`, confirmations: 1 })
        .where(eq(taskReports.id, filed.entry.id))
    }

    expect(await detectProviderChange(db, taskId)).toMatchObject({
      taskId,
      reporters: CHANGE_DISTINCT_REPORTERS,
    })
  })

  /** One citizen that could not start is one citizen, here as everywhere else. */
  it('does not fire on a single citizen that could not start', async () => {
    const taskId = await aTask()
    await settle(taskId, CHANGE_STABILITY_ATTEMPTS)

    const agentId = await anAgent()
    const filed = await fileReport(db, {
      taskId,
      agentId,
      narrative: {
        did: null,
        broke: 'My runtime has no browser, so I cannot begin.',
        changed: null,
        discarded: null,
      },
    })
    if (filed.outcome !== 'recorded') throw new Error(filed.outcome)
    await db
      .update(taskReports)
      .set({ status: 'approved', moderatedAt: sql`now()`, confirmations: 1 })
      .where(eq(taskReports.id, filed.entry.id))

    expect(await detectProviderChange(db, taskId)).toBeNull()
  })

  /**
   * The thing that would have made this wrong.
   *
   * The merge path counts **distinct agents** since #110, and a detector reading
   * rows would see three where the Colony counts one. Three reports from one
   * agent stuck across three attempts are not a provider change — they are one
   * agent's bad week.
   */
  it('does not fire on one stuck agent reporting three times', async () => {
    const taskId = await aTask()
    await settle(taskId, CHANGE_STABILITY_ATTEMPTS)

    const stuck = await anAgent()
    for (let i = 0; i < CHANGE_DISTINCT_REPORTERS + 1; i++) {
      await reportsSomethingNew(taskId, stuck, `Still stuck on the same wall, attempt number ${i}.`)
    }

    expect(await detectProviderChange(db, taskId)).toBeNull()
  })

  /**
   * The rejection case #115 names by name. Everything on a task nobody has
   * reported on yet is distinct by definition, so a detector that fires on every
   * new task is a detector nobody reads.
   */
  it('cannot fire on a new task', async () => {
    const taskId = await aTask()

    for (let i = 0; i < CHANGE_DISTINCT_REPORTERS; i++) {
      await reportsSomethingNew(
        taskId,
        await anAgent(),
        `The first thing anybody has said about this task, ${i}.`,
      )
    }

    expect(await detectProviderChange(db, taskId)).toBeNull()
  })

  /** A provider change produces reports for days. The Colony should conclude it once. */
  it('does not fire a second time inside the cooldown', async () => {
    const taskId = await aTask()
    await settle(taskId, CHANGE_STABILITY_ATTEMPTS)

    for (let i = 0; i < CHANGE_DISTINCT_REPORTERS; i++) {
      await reportsSomethingNew(
        taskId,
        await anAgent(),
        `A new wall nobody had described before, seen by agent ${i}.`,
      )
    }

    expect(await detectProviderChange(db, taskId)).not.toBeNull()

    await recordProviderChange(db, taskId)

    // The cluster is still there and still growing; the conclusion is not redrawn.
    await reportsSomethingNew(
      taskId,
      await anAgent(),
      'And another agent walked into the same new wall today.',
    )
    expect(await detectProviderChange(db, taskId)).toBeNull()
  })

  /**
   * Demoted, never deleted. A claim last supported before the change leaves the
   * foreground now rather than in ninety days, and a later report confirming it
   * brings it straight back.
   */
  it('demotes the claims nothing has confirmed since the change', async () => {
    const taskId = await aTask()

    await writeBriefing(db, {
      taskId,
      model: 'fake/test-model',
      claims: [
        {
          section: 'wall',
          text: 'One provider asks for a phone number partway through.',
          reports: 4,
          platforms: { openclaw: 4 },
          lastSupportedAt: new Date(Date.now() - 60_000).toISOString(),
          sources: [crypto.randomUUID()],
        },
      ],
    })

    expect((await readBriefing(db, taskId))?.claims[0]?.current).toBe(true)

    await recordProviderChange(db, taskId)

    const after = await readBriefing(db, taskId)
    expect(after?.claims).toHaveLength(1)
    expect(after?.claims[0]?.current).toBe(false)
    // Readable, with its age visible — nothing was deleted.
    expect(after?.claims[0]?.text).toContain('phone number')
  })

  it('marks the briefing stale so the immediate re-synthesis has something to consume', async () => {
    const taskId = await aTask()
    await writeBriefing(db, { taskId, model: 'fake/test-model', claims: [] })

    await recordProviderChange(db, taskId)

    const [row] = await db
      .select({ dirty: taskBriefings.dirty })
      .from(taskBriefings)
      .where(eq(taskBriefings.taskId, taskId))

    expect(row?.dirty).toBe(true)
  })
})
