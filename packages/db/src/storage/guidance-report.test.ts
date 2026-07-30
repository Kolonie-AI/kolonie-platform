import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { SubmissionIdSchema, type AgentId, type TaskId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import {
  agentSkills,
  agents,
  submissions,
  taskStruggles,
  taskTips,
  tasks,
} from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { fileStruggle, routeSubmissionReport } from './guidance.js'

const target = databaseTestTarget()

if (!target.available) {
  console.warn(`\n${target.reason}\n`)
}

/**
 * A report attached to a submission, and what the verdict makes of it (#56).
 *
 * Its own describe block with its own fixtures, because everything here turns on
 * the *submission* rather than on an endpoint: the entitlement is the verdict,
 * so a test that reused the helpers above would be checking gates this path does
 * not go through.
 */
describe.skipIf(!target.available)('a report carried on a submission', () => {
  let db: Database
  let taskId: TaskId
  let agentId: AgentId

  const REPORT = 'The provider now asks for a phone number at the second step, which it did not.'
  const LATER = 'Correction: it only asks when the browser has no cookie from a previous visit.'

  beforeAll(async () => {
    if (!target.available) return
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

  /** A decided submission, optionally carrying a report, on `taskId` by default. */
  const submitted = async (
    status: 'passed' | 'failed' | 'timeout' | 'pending',
    report?: string,
    on: TaskId = taskId,
    by: AgentId = agentId,
  ) => {
    const [row] = await db
      .insert(submissions)
      .values({
        taskId: on,
        agentId: by,
        payload: {},
        attempt: ++slug,
        status,
        ...(report === undefined ? {} : { report }),
        ...(status === 'pending' ? {} : { verifiedAt: new Date().toISOString() }),
      })
      .returning({ id: submissions.id })
    return SubmissionIdSchema.parse(row!.id)
  }

  const struggles = async () =>
    db.select().from(taskStruggles).where(eq(taskStruggles.taskId, taskId))
  const tips = async () => db.select().from(taskTips).where(eq(taskTips.taskId, taskId))

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

  it('turns a report on a passed submission into a pending tip', async () => {
    const id = await submitted('passed', REPORT)

    expect(await routeSubmissionReport(db, id)).toEqual({ outcome: 'stored' })

    const [tip] = await tips()
    expect(tip).toMatchObject({ content: REPORT, status: 'pending', submissionId: id })
    expect(await struggles()).toHaveLength(0)
    expect(await outcomeOf(id)).toBe('stored')
  })

  it('turns a report on a failed submission into a pending struggle', async () => {
    const id = await submitted('failed', REPORT)

    expect(await routeSubmissionReport(db, id)).toEqual({ outcome: 'stored' })

    const [struggle] = await struggles()
    expect(struggle).toMatchObject({ content: REPORT, status: 'pending', submissionId: id })
    expect(await tips()).toHaveLength(0)
  })

  it('does nothing at all when the submission carried no report', async () => {
    const id = await submitted('failed')

    expect(await routeSubmissionReport(db, id)).toEqual({ outcome: 'nothing-to-do' })
    expect(await struggles()).toHaveLength(0)
    expect(await outcomeOf(id)).toBeNull()
  })

  /**
   * A submission that ran out of time carries no evidence either way. Filing its
   * report as a struggle would put the Colony's own slowness into the corpus as
   * though it were a fact about the task.
   */
  it('files nothing for a submission that timed out', async () => {
    const id = await submitted('timeout', REPORT)

    expect(await routeSubmissionReport(db, id)).toEqual({ outcome: 'nothing-to-do' })
    expect(await struggles()).toHaveLength(0)
  })

  it('replaces the content of a row that is still pending', async () => {
    const first = await submitted('failed', REPORT)
    await routeSubmissionReport(db, first)
    const second = await submitted('failed', LATER)

    expect(await routeSubmissionReport(db, second)).toEqual({ outcome: 'replaced' })

    const rows = await struggles()
    expect(rows).toHaveLength(1)
    // The pointer moves with the text: provenance names the attempt the words
    // came from, and after a replace that is the later one.
    expect(rows[0]).toMatchObject({ content: LATER, submissionId: second })
    expect(await outcomeOf(second)).toBe('replaced')
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
    await db
      .update(taskTips)
      .set({ status: 'approved', moderatedAt: new Date().toISOString() })
      .where(eq(taskTips.taskId, taskId))

    const second = await submitted('passed', LATER)
    expect(await routeSubmissionReport(db, second)).toEqual({ outcome: 'superseded' })

    const rows = await tips()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ content: REPORT, status: 'approved', submissionId: first })
    expect(await outcomeOf(second)).toBe('superseded')
  })

  /**
   * An agent that failed, wrote what blocked it, then got through and wrote how
   * has produced two true rows: the wall, and the way past it. Different tables,
   * different unique indexes, no interaction.
   */
  it('lets the same agent hold a struggle and a tip on one task', async () => {
    await routeSubmissionReport(db, await submitted('failed', REPORT))
    await routeSubmissionReport(db, await submitted('passed', LATER))

    expect(await struggles()).toHaveLength(1)
    expect(await tips()).toHaveLength(1)
  })

  /** At-least-once: a runner that dies after filing must not file again. */
  it('is idempotent — routing the same submission twice files one row', async () => {
    const id = await submitted('failed', REPORT)

    expect(await routeSubmissionReport(db, id)).toEqual({ outcome: 'stored' })
    expect(await routeSubmissionReport(db, id)).toEqual({ outcome: 'nothing-to-do' })
    expect(await struggles()).toHaveLength(1)
  })

  /**
   * The provenance column is what tells the moderator that a tip came from an
   * agent's fifth attempt rather than its first — and it is null for rows that
   * came in through #54's endpoints, which is why it is nullable.
   */
  it('leaves submission_id null on a row filed through the endpoint', async () => {
    const [skillSubmission] = await db
      .insert(submissions)
      .values({
        taskId,
        agentId,
        payload: {},
        attempt: ++slug,
        status: 'passed',
        verifiedAt: new Date().toISOString(),
      })
      .returning({ id: submissions.id })
    await db
      .insert(agentSkills)
      .values({ agentId, skill: 'profile', submissionId: skillSubmission!.id })

    const filed = await fileStruggle(db, { taskId, agentId, content: REPORT })

    expect(filed.outcome).toBe('recorded')
    const [row] = await struggles()
    expect(row!.submissionId).toBeNull()
  })
})
