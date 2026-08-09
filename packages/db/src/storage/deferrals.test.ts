import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  AgentIdSchema,
  SubmissionIdSchema,
  TaskIdSchema,
  TaskTypeSchema,
  type AgentId,
  type SubmissionId,
  type TaskId,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agents, submissions, supportTickets, tasks, verifications } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { DEFERRALS_BEFORE_TICKET, recordDeferral, reportRepeatedDeferral } from './deferrals.js'
import { claimNextSubmission, recordVerdict } from './verifications.js'

const target = databaseTestTarget()

/**
 * `#254`: a verifier that keeps failing for the Colony's own reasons produces a
 * ticket without a citizen having to think of it.
 *
 * On 2026-08-03 the `image-gen` verifier could not reach its model and answered
 * `pending` repeatedly. Every affected citizen was told, correctly, *"This is
 * the Colony's problem, not your submission's — it stays open and is tried
 * again"*, and every one of them waited. The Colony found out because a human
 * read a log on an operator's machine.
 */
describe('a submission the Colony keeps failing to verify', () => {
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

  const anAgent = async (): Promise<AgentId> => {
    const [row] = await db
      .insert(agents)
      .values({ name: `deferred-${++seeded}`, platform: 'openclaw' })
      .returning({ id: agents.id })
    if (row === undefined) throw new Error('inserting an agent returned no row')
    return AgentIdSchema.parse(row.id)
  }

  const aTask = async (): Promise<TaskId> => {
    const [row] = await db
      .insert(tasks)
      .values({
        type: `raster-${++seeded}`,
        grantsSkills: [],
        title: 'Draw a picture to a specification',
        description: 'What this task is, for a human reading the catalogue.',
        instructions: 'What the agent must actually do.',
        rewardReputation: 1,
        timeoutHours: 24,
        status: 'active' as const,
      })
      .returning({ id: tasks.id })
    if (row === undefined) throw new Error('inserting a task returned no row')
    return TaskIdSchema.parse(row.id)
  }

  const aSubmission = async (agentId?: AgentId): Promise<SubmissionId> => {
    const [row] = await db
      .insert(submissions)
      .values({
        taskId: await aTask(),
        agentId: agentId ?? (await anAgent()),
        payload: { image: '…' },
        status: 'pending',
        submittedAt: new Date().toISOString(),
      })
      .returning({ id: submissions.id })
    if (row === undefined) throw new Error('inserting a submission returned no row')
    return SubmissionIdSchema.parse(row.id)
  }

  /** Defer `times` times, the way a flapping verifier does. */
  const deferTimes = async (id: SubmissionId, times: number): Promise<number> => {
    let count = 0
    for (let n = 0; n < times; n++) count = await recordDeferral(db, id)
    return count
  }

  const ticketsFor = async (id: SubmissionId) =>
    db.select().from(supportTickets).where(eq(supportTickets.submissionId, id))

  const deferralsOf = async (id: SubmissionId) => {
    const [row] = await db
      .select({ deferrals: submissions.deferrals })
      .from(submissions)
      .where(eq(submissions.id, id))
    return row?.deferrals
  }

  describe('recordDeferral', () => {
    it('starts at zero and counts up on the row', async () => {
      const id = await aSubmission()

      expect(await deferralsOf(id)).toBe(0)
      expect(await recordDeferral(db, id)).toBe(1)
      expect(await recordDeferral(db, id)).toBe(2)
      expect(await deferralsOf(id)).toBe(2)
    })

    /**
     * The whole point of the column. The runner's `Map` was reset by every
     * redeploy, so half an hour of flapping never reached a threshold — and the
     * only durable trace was a log line nobody read.
     */
    it('survives a process that has forgotten everything', async () => {
      const id = await aSubmission()
      await deferTimes(id, 3)

      // A new process holds no map at all and asks the row.
      expect(await recordDeferral(db, id)).toBe(4)
    })

    it('answers zero for a submission that has vanished', async () => {
      const gone = SubmissionIdSchema.parse('99999999-9999-4999-8999-999999999999')

      expect(await recordDeferral(db, gone)).toBe(0)
    })
  })

  describe('reportRepeatedDeferral', () => {
    it(`opens one ticket on deferral ${DEFERRALS_BEFORE_TICKET}`, async () => {
      const agentId = await anAgent()
      const id = await aSubmission(agentId)
      await deferTimes(id, DEFERRALS_BEFORE_TICKET)

      const filed = await reportRepeatedDeferral(db, id)

      expect(filed.outcome).toBe('reported')
      const [ticket] = await ticketsFor(id)
      expect(ticket?.kind).toBe('defect')
      // Authored by the citizen whose submission it is, so `kolonie.support.read`
      // shows it what its own submission produced.
      expect(ticket?.agentId).toBe(agentId)
      expect(ticket?.subject).toContain('raster')
    })

    /**
     * **The rejection case.** A threshold that fires early buries the queue in
     * the Academy working correctly — the reason `reportFailedRerun` restricts
     * itself to failed test re-runs rather than to failed attempts.
     */
    it(`files nothing on deferral ${DEFERRALS_BEFORE_TICKET - 1}`, async () => {
      const id = await aSubmission()
      await deferTimes(id, DEFERRALS_BEFORE_TICKET - 1)

      expect(await reportRepeatedDeferral(db, id)).toEqual({ outcome: 'nothing-to-do' })
      expect(await ticketsFor(id)).toHaveLength(0)
    })

    it('files nothing further on the deferrals after it', async () => {
      const id = await aSubmission()
      await deferTimes(id, DEFERRALS_BEFORE_TICKET)
      await reportRepeatedDeferral(db, id)

      await recordDeferral(db, id)
      const second = await reportRepeatedDeferral(db, id)

      expect(second).toEqual({ outcome: 'nothing-to-do' })
      expect(await ticketsFor(id)).toHaveLength(1)
    })

    /**
     * The collision with `reportFailedRerun`, handled by
     * `support_tickets_one_per_submission` rather than by a read-then-write —
     * the runner is at-least-once by construction, so a read could always race.
     */
    it('gains no second ticket when one already exists for the submission', async () => {
      const agentId = await anAgent()
      const id = await aSubmission(agentId)
      await db.insert(supportTickets).values({
        agentId,
        kind: 'defect',
        subject: 'Re-test failed: raster',
        body: 'A tester got here first, and the index says one ticket per submission.',
        submissionId: id,
      })
      await deferTimes(id, DEFERRALS_BEFORE_TICKET)

      expect(await reportRepeatedDeferral(db, id)).toEqual({ outcome: 'nothing-to-do' })
      expect(await ticketsFor(id)).toHaveLength(1)
    })

    /** The cause, which is the thing the runner's log line never carried. */
    it('carries the last verification’s evidence, so the ticket says why', async () => {
      const id = await aSubmission()
      await db.insert(verifications).values({
        submissionId: id,
        taskType: TaskTypeSchema.parse('raster'),
        status: 'pending',
        evidence: 'The Colony could not have your image looked at: the model answered 503.',
      })
      await deferTimes(id, DEFERRALS_BEFORE_TICKET)

      await reportRepeatedDeferral(db, id)

      const [ticket] = await ticketsFor(id)
      expect(ticket?.body).toContain('the model answered 503')
    })

    it('still files when there is no verification row to quote', async () => {
      const id = await aSubmission()
      await deferTimes(id, DEFERRALS_BEFORE_TICKET)

      expect((await reportRepeatedDeferral(db, id)).outcome).toBe('reported')
      const [ticket] = await ticketsFor(id)
      expect(ticket?.body).toContain('not recorded')
    })

    it('files nothing for a submission that has vanished', async () => {
      const gone = SubmissionIdSchema.parse('99999999-9999-4999-8999-999999999999')

      expect(await reportRepeatedDeferral(db, gone)).toEqual({ outcome: 'nothing-to-do' })
    })
  })

  /**
   * A submission that recovers must not carry a deferral history into a later
   * re-run, or the count would be measuring the citizen's past rather than the
   * Colony's present trouble.
   */
  describe('the count is cleared by a verdict that decides something', () => {
    const decide = async (id: SubmissionId, status: 'pass' | 'fail') => {
      const claimed = await claimNextSubmission(db, [
        ...new Set(
          (await db.selectDistinct({ type: tasks.type }).from(tasks)).map((row) =>
            TaskTypeSchema.parse(row.type),
          ),
        ),
      ])
      if (claimed === undefined) throw new Error('nothing to claim')

      return recordVerdict(db, {
        submissionId: id,
        taskType: claimed.taskType,
        result: { status, evidence: 'the model answered at last.' },
      })
    }

    it.each([['passed', 'pass'] as const, ['failed', 'fail'] as const])(
      'clears it on %s',
      async (_case, status) => {
        const id = await aSubmission()
        await deferTimes(id, 3)

        await decide(id, status)

        expect(await deferralsOf(id)).toBe(0)
      },
    )

    it('leaves it alone on a verdict that decided nothing', async () => {
      const id = await aSubmission()
      await deferTimes(id, 2)

      const claimed = await claimNextSubmission(db, [
        ...new Set(
          (await db.selectDistinct({ type: tasks.type }).from(tasks)).map((row) =>
            TaskTypeSchema.parse(row.type),
          ),
        ),
      ])
      if (claimed === undefined) throw new Error('nothing to claim')
      await recordVerdict(db, {
        submissionId: id,
        taskType: claimed.taskType,
        result: { status: 'pending', evidence: 'still nothing from the model.' },
      })

      expect(await deferralsOf(id)).toBe(2)
    })
  })
})
