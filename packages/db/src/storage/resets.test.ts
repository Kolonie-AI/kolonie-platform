import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { and, eq, sql } from 'drizzle-orm'
import { AgentIdSchema, TaskIdSchema, type AgentId, type Role, type TaskId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import {
  agents,
  agentSkills,
  ledgerEntries,
  reputationEvents,
  submissions,
  supportTickets,
  taskResets,
  tasks,
} from '../schema/index.js'
import { listOwnResets, reportFailedRerun, resetTaskCompletion } from './resets.js'
import { bookTaskReward } from './rewards.js'
import { createSubmission, unattendedPasses } from './submissions.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'

const target = databaseTestTarget()

describe('a tester re-running a task', () => {
  let db: Database
  let seeded = 0

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
  })

  const anAgent = async (roles: Role[] = []): Promise<AgentId> => {
    const [row] = await db
      .insert(agents)
      .values({ name: `agent-${++seeded}`, platform: 'openclaw', roles })
      .returning({ id: agents.id })
    if (row === undefined) throw new Error('inserting an agent returned no row')
    return AgentIdSchema.parse(row.id)
  }

  const aTask = async (grants: string[] = ['mailbox']): Promise<TaskId> => {
    const [row] = await db
      .insert(tasks)
      .values({
        type: `retestable-${++seeded}`,
        grantsSkills: grants,
        title: 'A task worth re-testing',
        description: 'What this task is, for a human reading the catalogue.',
        instructions: 'What the agent must actually do.',
        rewardCoins: 0,
        rewardReputation: 4,
        timeoutHours: 24,
        status: 'active' as const,
      })
      .returning({ id: tasks.id })
    if (row === undefined) throw new Error('inserting a task returned no row')
    return TaskIdSchema.parse(row.id)
  }

  /** A pass, booked the way the runner books one. */
  const passed = async (taskId: TaskId, agentId: AgentId) => {
    const created = await createSubmission(db, {
      taskId,
      agentId,
      payload: {},
      assistance: 'none',
    })
    if (created.outcome !== 'accepted')
      throw new Error(`fixture could not submit: ${created.outcome}`)

    const bookedAt = new Date().toISOString()
    const booked = await db.transaction(async (tx) => {
      await tx
        .update(submissions)
        .set({ status: 'passed', verifiedAt: bookedAt })
        .where(eq(submissions.id, created.submission.id))
      return bookTaskReward(tx, { submissionId: created.submission.id, bookedAt })
    })

    return { submissionId: created.submission.id, booked }
  }

  const reputationOf = async (agentId: AgentId) => {
    const [row] = await db
      .select({ total: sql<number>`coalesce(sum(${reputationEvents.delta}), 0)::int` })
      .from(reputationEvents)
      .where(eq(reputationEvents.agentId, agentId))
    return row?.total ?? 0
  }

  const reset = (agentId: AgentId, taskId: TaskId, reason = 'The provider changed its flow') =>
    resetTaskCompletion(db, { agentId, taskId, reason })

  it('refuses an agent that does not hold the tester role', async () => {
    const agentId = await anAgent()
    const taskId = await aTask()
    await passed(taskId, agentId)

    expect(await reset(agentId, taskId)).toEqual({ outcome: 'not-a-tester' })
  })

  it('refuses when the tester has never passed the task', async () => {
    const agentId = await anAgent(['tester'])

    expect(await reset(agentId, await aTask())).toEqual({ outcome: 'nothing-to-reset' })
  })

  it('sets aside a pass, and names the submission it superseded', async () => {
    const agentId = await anAgent(['tester'])
    const taskId = await aTask()
    const { submissionId } = await passed(taskId, agentId)

    expect(await reset(agentId, taskId)).toEqual({
      outcome: 'reset',
      supersededSubmissionId: submissionId,
    })
  })

  it('is idempotent until the task is re-attempted', async () => {
    const agentId = await anAgent(['tester'])
    const taskId = await aTask()
    await passed(taskId, agentId)

    expect((await reset(agentId, taskId)).outcome).toBe('reset')
    expect(await reset(agentId, taskId)).toEqual({ outcome: 'already-reset' })

    // One row, not two: the second call drew no second line.
    const rows = await db.select().from(taskResets).where(eq(taskResets.agentId, agentId))
    expect(rows).toHaveLength(1)
  })

  /**
   * **The core of #47.** D-015 still holds — many attempts, one pass — but the pass
   * that counts is the one since the last reset.
   */
  it('lets the task be submitted again after a reset, and refuses before one', async () => {
    const agentId = await anAgent(['tester'])
    const taskId = await aTask()
    await passed(taskId, agentId)

    const before = await createSubmission(db, { taskId, agentId, payload: {} })
    expect(before.outcome).toBe('already-passed')

    await reset(agentId, taskId)

    const after = await createSubmission(db, { taskId, agentId, payload: {} })
    expect(after.outcome).toBe('accepted')
  })

  it('marks the re-attempt as a test re-run, and the original as not one', async () => {
    const agentId = await anAgent(['tester'])
    const taskId = await aTask()
    const first = await passed(taskId, agentId)
    await reset(agentId, taskId)
    const second = await createSubmission(db, { taskId, agentId, payload: {} })
    if (second.outcome !== 'accepted') throw new Error('expected the re-attempt to be accepted')

    const rows = await db
      .select({ id: submissions.id, testRerun: submissions.testRerun })
      .from(submissions)
      .where(eq(submissions.taskId, taskId))

    expect(rows.find((row) => row.id === first.submissionId)?.testRerun).toBe(false)
    expect(rows.find((row) => row.id === second.submission.id)?.testRerun).toBe(true)
  })

  /**
   * **A test pass books nothing** (`kolonie-docs#17`): no ledger entry, no reputation
   * event, and no shadow account that every future query would have to filter out.
   */
  it('books no reputation and no ledger entry for a test pass', async () => {
    const agentId = await anAgent(['tester'])
    const taskId = await aTask()
    await passed(taskId, agentId)
    const earned = await reputationOf(agentId)
    expect(earned).toBe(4)

    await reset(agentId, taskId)
    const rerun = await passed(taskId, agentId)

    expect(rerun.booked.reputation).toBe(0)
    expect(rerun.booked.coins).toBe(0)
    expect(rerun.booked.transactionId).toBeNull()
    // Unchanged: the earlier pass's reputation stands, and the re-run added none.
    expect(await reputationOf(agentId)).toBe(earned)
    expect(await db.select().from(ledgerEntries)).toEqual([])
  })

  /**
   * The skill is **held**, not revoked. `kolonie-docs#17`: the capability did not go
   * away because the task changed. A re-run must not be able to take away standing.
   */
  it('leaves the skill the first pass granted in place throughout', async () => {
    const agentId = await anAgent(['tester'])
    const taskId = await aTask(['mailbox'])
    await passed(taskId, agentId)

    const heldAfterFirst = await db
      .select({ skill: agentSkills.skill })
      .from(agentSkills)
      .where(eq(agentSkills.agentId, agentId))
    expect(heldAfterFirst.map((row) => row.skill)).toEqual(['mailbox'])

    await reset(agentId, taskId)
    const created = await createSubmission(db, { taskId, agentId, payload: {} })
    if (created.outcome !== 'accepted') throw new Error('expected the re-attempt to be accepted')

    // Still held while the task is being re-attempted, before any verdict.
    const heldDuring = await db
      .select({ skill: agentSkills.skill })
      .from(agentSkills)
      .where(eq(agentSkills.agentId, agentId))
    expect(heldDuring.map((row) => row.skill)).toEqual(['mailbox'])
  })

  /** Real climbs only: `ROADMAP.md` makes this count part of the definition of done. */
  it('keeps a test re-run out of unattendedPasses', async () => {
    const agentId = await anAgent(['tester'])
    const taskId = await aTask()
    await passed(taskId, agentId)
    expect((await unattendedPasses(db))[0]?.passes).toBe(1)

    await reset(agentId, taskId)
    await passed(taskId, agentId)

    expect((await unattendedPasses(db))[0]?.passes).toBe(1)
  })

  describe('when a re-run fails', () => {
    /** A failed test re-run must not vanish into a container log. */
    const failedRerun = async () => {
      const agentId = await anAgent(['tester'])
      const taskId = await aTask()
      await passed(taskId, agentId)
      await reset(agentId, taskId, 'The signup flow started asking for a phone number')

      const created = await createSubmission(db, { taskId, agentId, payload: {} })
      if (created.outcome !== 'accepted') throw new Error('expected acceptance')
      await db
        .update(submissions)
        .set({ status: 'failed', verifiedAt: new Date().toISOString() })
        .where(eq(submissions.id, created.submission.id))

      return { agentId, taskId, submissionId: created.submission.id }
    }

    it('opens a ticket in the tester’s name, carrying the reason', async () => {
      const { agentId, submissionId } = await failedRerun()

      const reported = await reportFailedRerun(db, submissionId)

      expect(reported.outcome).toBe('reported')
      const [ticket] = await db
        .select()
        .from(supportTickets)
        .where(eq(supportTickets.submissionId, submissionId))
      expect(ticket?.agentId).toBe(agentId)
      expect(ticket?.kind).toBe('defect')
      expect(ticket?.status).toBe('open')
      expect(ticket?.body).toContain('The signup flow started asking for a phone number')
    })

    /**
     * The runner is at-least-once, so a crash between the verdict and the ticket
     * leaves the row to be picked up again. A second call must not file a duplicate —
     * enforced by `support_tickets_one_per_submission`, not by a read.
     */
    it('files one ticket however many times it is called', async () => {
      const { submissionId } = await failedRerun()

      await reportFailedRerun(db, submissionId)
      expect(await reportFailedRerun(db, submissionId)).toEqual({ outcome: 'nothing-to-do' })

      expect(await db.select().from(supportTickets)).toHaveLength(1)
    })

    it('files nothing for an ordinary failed attempt', async () => {
      const agentId = await anAgent()
      const taskId = await aTask()
      const created = await createSubmission(db, { taskId, agentId, payload: {} })
      if (created.outcome !== 'accepted') throw new Error('expected acceptance')
      await db
        .update(submissions)
        .set({ status: 'failed', verifiedAt: new Date().toISOString() })
        .where(eq(submissions.id, created.submission.id))

      expect(await reportFailedRerun(db, created.submission.id)).toEqual({
        outcome: 'nothing-to-do',
      })
      expect(await db.select().from(supportTickets)).toEqual([])
    })

    it('files nothing for a re-run that passed', async () => {
      const agentId = await anAgent(['tester'])
      const taskId = await aTask()
      await passed(taskId, agentId)
      await reset(agentId, taskId)
      const rerun = await passed(taskId, agentId)

      expect(await reportFailedRerun(db, rerun.submissionId)).toEqual({ outcome: 'nothing-to-do' })
      expect(await db.select().from(supportTickets)).toEqual([])
    })
  })

  it('lists a tester’s own resets, newest first', async () => {
    const agentId = await anAgent(['tester'])
    const first = await aTask()
    const second = await aTask()
    await passed(first, agentId)
    await passed(second, agentId)
    await reset(agentId, first, 'The first thing changed')
    await reset(agentId, second, 'The second thing changed')

    const listed = await listOwnResets(db, agentId)

    expect(listed).toHaveLength(2)
    expect(listed[0]?.reason).toBe('The second thing changed')
  })

  it('keeps one tester’s reset out of another agent’s way', async () => {
    const tester = await anAgent(['tester'])
    const other = await anAgent(['tester'])
    const taskId = await aTask()
    await passed(taskId, tester)
    await passed(taskId, other)
    await reset(tester, taskId)

    // The other agent's pass stands: a reset is scoped to the pair, not to the task.
    const theirs = await createSubmission(db, { taskId, agentId: other, payload: {} })
    expect(theirs.outcome).toBe('already-passed')
  })

  /**
   * A reset drawn *before* a later pass must not keep the task open forever. The gate
   * compares the reset against the time of the pass, not against nothing.
   */
  it('closes the task again once the re-run has passed', async () => {
    const agentId = await anAgent(['tester'])
    const taskId = await aTask()
    await passed(taskId, agentId)
    await reset(agentId, taskId)
    await passed(taskId, agentId)

    const third = await createSubmission(db, { taskId, agentId, payload: {} })

    expect(third.outcome).toBe('already-passed')
  })

  it('allows a second reset after the re-run has passed', async () => {
    const agentId = await anAgent(['tester'])
    const taskId = await aTask()
    await passed(taskId, agentId)
    await reset(agentId, taskId)
    await passed(taskId, agentId)

    expect((await reset(agentId, taskId, 'It changed again')).outcome).toBe('reset')
  })

  it('records who is being reset and never anybody else', async () => {
    const tester = await anAgent(['tester'])
    const taskId = await aTask()
    await passed(taskId, tester)
    await reset(tester, taskId)

    const rows = await db
      .select({ agentId: taskResets.agentId })
      .from(taskResets)
      .where(and(eq(taskResets.taskId, taskId)))

    // There is no column for a third party, so this is the shape of the guarantee
    // rather than a check: every reset names its own author.
    expect(rows.map((row) => row.agentId)).toEqual([tester])
  })
})
