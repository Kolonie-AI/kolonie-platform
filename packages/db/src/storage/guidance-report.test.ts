import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import {
  GUIDANCE_CONTENT_MAX_LENGTH,
  SubmissionIdSchema,
  type AgentId,
  type ReportNarrative,
  type TaskId,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agents, submissions, taskAttempts, taskReports, tasks } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { fileReport, routeSubmissionReport } from './guidance.js'

const target = databaseTestTarget()

/**
 * A narrative with one field answered.
 *
 * Most tests are about something other than which question was answered, and a
 * fixture that made them all fill three would bury the ones that *are* about it.
 * `broke` is the default because a wall is the ordinary report.
 */
const aNarrative = (
  content: string,
  field: 'did' | 'broke' | 'changed' = 'broke',
): ReportNarrative => ({ did: null, broke: null, changed: null, [field]: content })

/**
 * A report attached to a submission, and what the verdict makes of it (#56).
 *
 * Its own describe block with its own fixtures, because everything here turns on
 * the *submission* rather than on an endpoint.
 *
 * **The routing this used to test is gone** (#110). The verdict decided which
 * table the text went into — a tip if it passed, a struggle if it failed — and
 * there is one table now. What survives is the part that was never about the
 * split: which submissions file anything at all, what a second one does to the
 * first, and that a runner which dies mid-write files once.
 */
describe('a report carried on a submission', () => {
  let db: Database
  let taskId: TaskId
  let agentId: AgentId

  const REPORT = 'The provider now asks for a phone number at the second step, which it did not.'
  const LATER = 'Correction: it only asks when the browser has no cookie from a previous visit.'

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  let slug = 0

  const aTask = async () => {
    const [row] = await db
      .insert(tasks)
      .values({
        type: `report-task-${++slug}`,
        title: 'A task',
        description: 'What this task is.',
        instructions: 'What the agent must do.',
        rewardCoins: 0,
        rewardReputation: 1,
        timeoutHours: 24,
        status: 'active',
      })
      .returning({ id: tasks.id })
    return row!.id as TaskId
  }

  const anAgent = async () => {
    const [row] = await db
      .insert(agents)
      .values({ name: `reporter-${++slug}`, platform: 'openclaw' })
      .returning({ id: agents.id })
    return row!.id as AgentId
  }

  /**
   * A decided submission with its attempt, optionally carrying a report.
   *
   * The attempt is written here rather than left to `createSubmission`, for the
   * reason the old fixture wrote submissions directly: half of these are states
   * that function will not produce — a `timeout`, a second submission on a task
   * already passed. What the routing does with rows it *finds* is the point.
   */
  const submitted = async (
    status: 'passed' | 'failed' | 'timeout' | 'pending',
    report?: string,
    on: TaskId = taskId,
    by: AgentId = agentId,
  ) => {
    const opened = new Date().toISOString()
    const [highest] = await db
      .select({ attempt: taskAttempts.attempt })
      .from(taskAttempts)
      .where(eq(taskAttempts.agentId, by))
      .orderBy(taskAttempts.attempt)

    const outcome = status === 'passed' ? 'passed' : status === 'failed' ? 'failed' : null
    const [attempt] = await db
      .insert(taskAttempts)
      .values({
        taskId: on,
        agentId: by,
        attempt: (highest?.attempt ?? 0) + 1,
        opener: 'submission',
        openedAt: opened,
        ...(outcome === null ? {} : { outcome, closedAt: opened }),
      })
      .returning({ id: taskAttempts.id })

    const [row] = await db
      .insert(submissions)
      .values({
        taskId: on,
        agentId: by,
        payload: {},
        attemptId: attempt!.id,
        attempt: ++slug,
        status,
        ...(report === undefined ? {} : { report }),
        ...(status === 'pending' ? {} : { verifiedAt: new Date().toISOString() }),
      })
      .returning({ id: submissions.id })
    return SubmissionIdSchema.parse(row!.id)
  }

  const reports = async () =>
    db
      .select({
        id: taskReports.id,
        did: taskReports.did,
        broke: taskReports.broke,
        changed: taskReports.changed,
        status: taskReports.status,
        attemptId: taskReports.attemptId,
      })
      .from(taskReports)
      .innerJoin(taskAttempts, eq(taskAttempts.id, taskReports.attemptId))
      .where(eq(taskAttempts.taskId, taskId))

  const attemptOf = async (submissionId: string) => {
    const [row] = await db
      .select({ attemptId: submissions.attemptId })
      .from(submissions)
      .where(eq(submissions.id, submissionId))
    return row!.attemptId
  }

  const outcomeOf = async (submissionId: string) => {
    const [row] = await db
      .select({ outcome: submissions.reportOutcome })
      .from(submissions)
      .where(eq(submissions.id, submissionId))
    return row!.outcome
  }

  beforeEach(async () => {
    await truncateAll(db)
    taskId = await aTask()
    agentId = await anAgent()
  })

  /**
   * **What kind of report it is, is not written down anywhere here.** It used to
   * be the choice of table; it is now read from the attempt's outcome, which the
   * verdict has just set. So both of these store a row, and the only difference
   * is what the attempt says happened.
   */
  it('files a report from a passed submission, against its own attempt', async () => {
    const id = await submitted('passed', REPORT)

    expect(await routeSubmissionReport(db, id)).toEqual({ outcome: 'stored' })

    /**
     * **Into `did`, because the attempt passed.** `#56`'s field asks one open
     * question and gets one open answer, so which of the three it belongs in has
     * to be inferred — and the outcome is the only honest thing to infer it
     * from. An agent that got through wrote an account of what it did.
     */
    const [report] = await reports()
    expect(report).toMatchObject({ did: REPORT, broke: null, status: 'pending' })
    expect(report!.attemptId).toBe(await attemptOf(id))
    expect(await outcomeOf(id)).toBe('stored')
  })

  it('files a report from a failed submission the same way', async () => {
    const id = await submitted('failed', REPORT)

    expect(await routeSubmissionReport(db, id)).toEqual({ outcome: 'stored' })

    const [report] = await reports()
    expect(report).toMatchObject({ broke: REPORT, status: 'pending' })
    expect(report!.attemptId).toBe(await attemptOf(id))
  })

  it('does nothing at all when the submission carried no report', async () => {
    const id = await submitted('failed')

    expect(await routeSubmissionReport(db, id)).toEqual({ outcome: 'nothing-to-do' })
    expect(await reports()).toHaveLength(0)
    expect(await outcomeOf(id)).toBeNull()
  })

  /**
   * A submission that ran out of time carries no evidence either way. Filing its
   * report would put the Colony's own slowness into the corpus as though it were
   * a fact about the task.
   */
  it('files nothing for a submission that timed out', async () => {
    const id = await submitted('timeout', REPORT)

    expect(await routeSubmissionReport(db, id)).toEqual({ outcome: 'nothing-to-do' })
    expect(await reports()).toHaveLength(0)
  })

  /**
   * **Two submissions are two attempts, so they are two reports** — and that is
   * exactly what #110 changed. Under one report per *task* the second would have
   * replaced the first and the sequence would have been lost; under one per
   * attempt each stands on its own.
   */
  it('gives a second submission its own report rather than replacing the first', async () => {
    const first = await submitted('failed', REPORT)
    await routeSubmissionReport(db, first)
    const second = await submitted('failed', LATER)

    expect(await routeSubmissionReport(db, second)).toEqual({ outcome: 'stored' })

    const rows = await reports()
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.broke).sort()).toEqual([REPORT, LATER].sort())
  })

  /**
   * Replacement is what happens when two submissions share an attempt — which
   * `createSubmission` prevents, and which this path still has to answer for a
   * row it merely finds. The pending row takes the newer text.
   */
  it('replaces the content of a pending row on the same attempt', async () => {
    const first = await submitted('failed', REPORT)
    await routeSubmissionReport(db, first)

    const attemptId = await attemptOf(first)
    const [second] = await db
      .insert(submissions)
      .values({
        taskId,
        agentId,
        payload: {},
        attemptId,
        attempt: ++slug,
        status: 'failed',
        report: LATER,
        verifiedAt: new Date().toISOString(),
      })
      .returning({ id: submissions.id })

    expect(await routeSubmissionReport(db, SubmissionIdSchema.parse(second!.id))).toEqual({
      outcome: 'replaced',
    })

    const rows = await reports()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ broke: LATER })
    expect(await outcomeOf(second!.id)).toBe('replaced')
  })

  /**
   * An approved row may already carry votes, and rewriting content underneath
   * votes makes the votes describe text nobody read. The agent is told
   * `superseded` rather than being refused silently, so it can go and revise
   * through the endpoint if it means to.
   */
  it('leaves a judged row untouched and says superseded', async () => {
    const first = await submitted('passed', REPORT)
    await routeSubmissionReport(db, first)
    await db.update(taskReports).set({ status: 'approved', moderatedAt: new Date().toISOString() })

    const attemptId = await attemptOf(first)
    const [second] = await db
      .insert(submissions)
      .values({
        taskId,
        agentId,
        payload: {},
        attemptId,
        attempt: ++slug,
        status: 'passed',
        report: LATER,
        verifiedAt: new Date().toISOString(),
      })
      .returning({ id: submissions.id })

    expect(await routeSubmissionReport(db, SubmissionIdSchema.parse(second!.id))).toEqual({
      outcome: 'superseded',
    })

    const rows = await reports()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ did: REPORT, status: 'approved' })
    expect(await outcomeOf(second!.id)).toBe('superseded')
  })

  /**
   * An agent that failed, wrote what blocked it, then got through and wrote how
   * has produced two true rows: the wall, and the way past it.
   *
   * **They used to live in different tables with different unique indexes.** Now
   * they are two rows in one table, kept apart by belonging to different
   * attempts — which is the same fact expressed by the thing that was actually
   * different about them all along.
   */
  it('lets the same agent hold a wall and advice on one task', async () => {
    await routeSubmissionReport(db, await submitted('failed', REPORT))
    await routeSubmissionReport(db, await submitted('passed', LATER))

    expect(await reports()).toHaveLength(2)
  })

  /** At-least-once: a runner that dies after filing must not file again. */
  it('is idempotent — routing the same submission twice files one row', async () => {
    const id = await submitted('failed', REPORT)

    expect(await routeSubmissionReport(db, id)).toEqual({ outcome: 'stored' })
    expect(await routeSubmissionReport(db, id)).toEqual({ outcome: 'nothing-to-do' })
    expect(await reports()).toHaveLength(1)
  })

  /**
   * **The endpoint and this path now agree about who may write**, where they
   * used to differ.
   *
   * The old comment recorded the gap honestly: filing a struggle required
   * `profile`, an agent can fail `profile-complete` without holding it, so the
   * submission path could write a row the endpoint would have refused.
   * `fileReport` requires an attempt instead — and a submission is an attempt —
   * so there is nothing left to differ about.
   */
  it('accepts an endpoint write from an agent with an attempt and no skills', async () => {
    await submitted('failed')

    const filed = await fileReport(db, { taskId, agentId, narrative: aNarrative(REPORT) })

    expect(filed.outcome).toBe('recorded')
    expect(await reports()).toHaveLength(1)
  })

  /**
   * Was a refusal until #156. A citizen that has not attempted the task is the
   * agent the refusal's own text described, and it is now recorded — bounded to
   * one such row per citizen per task by the index rather than by a gate.
   */
  it('records an endpoint write from an agent that never attempted the task', async () => {
    const stranger = await anAgent()

    const filed = await fileReport(db, { taskId, agentId: stranger, narrative: aNarrative(REPORT) })

    expect(filed.outcome).toBe('recorded')
    // Counted through the report's own task, not through `reports()`: that
    // helper joins attempts, which is the right shape for every other test here
    // and by construction cannot see this row.
    const unattempted = await db
      .select({ id: taskReports.id })
      .from(taskReports)
      .where(and(eq(taskReports.taskId, taskId), eq(taskReports.agentId, stranger)))
    expect(unattempted).toHaveLength(1)
  })

  /**
   * The constraint the whole programme is built around, asserted on the routing
   * path rather than assumed (#58).
   *
   * **A pass stays a pass whatever the report does.** No verdict, skill grant or
   * reputation booking waits on a report — that would hang the Academy's reward
   * path off an LLM moderation queue, and an agent that passed would not get its
   * skill because a runner was down.
   */
  describe('what a report may never cost a verdict', () => {
    const statusOf = async (submissionId: string) => {
      const [row] = await db
        .select({ status: submissions.status })
        .from(submissions)
        .where(eq(submissions.id, submissionId))
      return row!.status
    }

    it('books the pass when there is no report at all', async () => {
      const id = await submitted('passed')

      expect(await routeSubmissionReport(db, id)).toEqual({ outcome: 'nothing-to-do' })
      expect(await statusOf(id)).toBe('passed')
    })

    it('books the pass when the report is at the ceiling', async () => {
      // The submission column's own bound, not the merged report's — this is the
      // #56 field, and it is the one a verdict has to survive.
      const id = await submitted('passed', 'x'.repeat(GUIDANCE_CONTENT_MAX_LENGTH))

      expect(await routeSubmissionReport(db, id)).toEqual({ outcome: 'stored' })
      expect(await statusOf(id)).toBe('passed')
    })

    /**
     * Routing twice is the at-least-once case: a process that dies between
     * recording a verdict and routing leaves the row to the sweep. The second
     * pass must change neither the report nor the verdict.
     */
    it('books the pass when routing runs a second time', async () => {
      const id = await submitted('passed', REPORT)

      await routeSubmissionReport(db, id)
      expect(await routeSubmissionReport(db, id)).toEqual({ outcome: 'nothing-to-do' })

      expect(await statusOf(id)).toBe('passed')
      expect(await reports()).toHaveLength(1)
    })
  })
})
