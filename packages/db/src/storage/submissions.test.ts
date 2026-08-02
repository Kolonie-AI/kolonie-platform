import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import {
  AgentIdSchema,
  RegisterAgentRequestSchema,
  SubmissionSchema,
  TaskIdSchema,
  type AgentId,
  type Assistance,
  type SubmissionStatus,
  type TaskId,
  type TaskStatus,
} from '@kolonie-ai/core'
import { randomUUID } from 'node:crypto'
import type { Database } from '../client.js'
import { agents, agentSkills, submissions, tasks, verifications } from '../schema/index.js'
import { connectForTests, databaseTestTarget, expectRejection, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import { createSubmission, listSubmissions, unattendedPasses } from './submissions.js'

const target = databaseTestTarget()

describe('createSubmission', () => {
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

  const anAgent = async (name = `canary-${++seeded}`): Promise<AgentId> => {
    const result = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name, platform: 'openclaw' }),
    )
    if (result.outcome !== 'registered') throw new Error(result.outcome)
    return result.agent.id
  }

  const aTask = async (
    options: {
      requires?: string[]
      grants?: string[]
      minReputation?: number
      status?: TaskStatus
      assistanceAllowed?: boolean
    } = {},
  ): Promise<TaskId> => {
    const [row] = await db
      .insert(tasks)
      .values({
        type: `academy-task-${++seeded}`,
        requiresSkills: options.requires ?? [],
        grantsSkills: options.grants ?? [],
        minReputation: options.minReputation ?? 0,
        title: 'Complete your profile',
        description: 'What this task is, for a human reading the catalogue.',
        instructions: 'What the agent must actually do.',
        rewardCredits: 0,
        rewardReputation: 1,
        assistanceAllowed: options.assistanceAllowed ?? true,
        timeoutHours: 24,
        status: options.status ?? 'active',
      })
      .returning({ id: tasks.id })

    if (row === undefined) throw new Error('insert into tasks returned no row')
    return TaskIdSchema.parse(row.id)
  }

  const submit = (
    taskId: TaskId,
    agentId: AgentId,
    options: { payload?: Record<string, unknown>; assistance?: Assistance } = {},
  ) =>
    createSubmission(db, {
      taskId,
      agentId,
      payload: options.payload ?? { result: 'done' },
      // Passed through only when a test names it, so the default that decides
      // what silence means is read from one place — the column.
      ...(options.assistance !== undefined && { assistance: options.assistance }),
    })

  /**
   * Give an agent a skill the way a pass does.
   *
   * Through a submission, because `agent_skills.submission_id` is `not null`:
   * there is no way to conjure a capability from nowhere, and a fixture that
   * could would be testing a system this one is not.
   */
  const grantSkill = async (agentId: AgentId, skill: string): Promise<void> => {
    const taskId = await aTask({ grants: [skill], status: 'draft' })
    const [row] = await db
      .insert(submissions)
      .values({
        taskId,
        agentId,
        payload: {},
        attempt: 1,
        status: 'passed',
        verifiedAt: new Date().toISOString(),
      })
      .returning({ id: submissions.id })
    if (row === undefined) throw new Error('insert into submissions returned no row')

    await db
      .insert(agentSkills)
      .values({ agentId, skill, submissionId: row.id })
      .onConflictDoNothing()
  }

  /** Force a verdict the way the runner (#7) and the ledger (#8) eventually will. */
  const decide = async (taskId: TaskId, agentId: AgentId, status: SubmissionStatus) => {
    await db
      .update(submissions)
      .set({ status, verifiedAt: new Date().toISOString() })
      .where(and(eq(submissions.taskId, taskId), eq(submissions.agentId, agentId)))
  }

  it('records the submission in the domain shape, not the row', async () => {
    const agentId = await anAgent()
    const taskId = await aTask()

    const result = await submit(taskId, agentId, { payload: { issueUrl: 'https://x.invalid/1' } })

    expect(result.outcome).toBe('accepted')
    if (result.outcome !== 'accepted') return
    expect(() => SubmissionSchema.parse(result.submission)).not.toThrow()
    expect(result.submission).toMatchObject({
      taskId,
      agentId,
      payload: { issueUrl: 'https://x.invalid/1' },
      attempt: 1,
      verifiedAt: null,
    })
  })

  it('stores it as pending — only the runner may claim a row into verifying', async () => {
    const agentId = await anAgent()
    const taskId = await aTask()

    const result = await submit(taskId, agentId)

    if (result.outcome !== 'accepted') throw new Error(result.outcome)
    expect(result.submission.status).toBe('pending')
  })

  it('refuses a task that does not exist', async () => {
    const agentId = await anAgent()

    const result = await submit(TaskIdSchema.parse(randomUUID()), agentId)

    expect(result.outcome).toBe('unknown-task')
  })

  it('answers for a draft task exactly as it answers for a missing one', async () => {
    const agentId = await anAgent()
    const draft = await aTask({ status: 'draft' })

    // Byte for byte. Any difference is an oracle for unreleased Academy content.
    expect(await submit(draft, agentId)).toEqual(
      await submit(TaskIdSchema.parse(randomUUID()), agentId),
    )
  })

  it('refuses a retired task as gone rather than as missing', async () => {
    const agentId = await anAgent()
    const retired = await aTask({ status: 'retired' })

    // A retired task *was* real and its old submissions still resolve, so an
    // agent that read it from a stale list is told it is over, not that it
    // imagined it.
    expect((await submit(retired, agentId)).outcome).toBe('task-retired')
  })

  it('refuses a task whose required skill the agent lacks, and names it', async () => {
    const agentId = await anAgent()
    const taskId = await aTask({ requires: ['profile', 'browser'] })
    await grantSkill(agentId, 'profile')

    const result = await submit(taskId, agentId)

    expect(result).toEqual({ outcome: 'missing-skills', missing: ['browser'] })
  })

  it('accepts the same task once the skill is held', async () => {
    const agentId = await anAgent()
    const taskId = await aTask({ requires: ['browser'] })

    expect((await submit(taskId, agentId)).outcome).toBe('missing-skills')

    await grantSkill(agentId, 'browser')

    expect((await submit(taskId, agentId)).outcome).toBe('accepted')
  })

  it('reads the skills as they are now, not as the caller believed them to be', async () => {
    // The gate moved inside the transaction with D-030. There is no parameter
    // through which a caller can present skills it does not hold, and a pass
    // that landed a moment ago counts — under the old shape the level had
    // already been copied out of the agent row before the request began.
    const agentId = await anAgent()
    const taskId = await aTask({ requires: ['keypair'] })
    await grantSkill(agentId, 'keypair')

    expect((await submit(taskId, agentId)).outcome).toBe('accepted')
  })

  it('refuses a task under its reputation floor, and says what the floor is', async () => {
    const agentId = await anAgent()
    const taskId = await aTask({ minReputation: 10 })

    expect(await submit(taskId, agentId)).toEqual({
      outcome: 'reputation-too-low',
      minReputation: 10,
      reputation: 0,
    })
  })

  it('refuses a second submission while the first is undecided', async () => {
    const agentId = await anAgent()
    const taskId = await aTask()
    await submit(taskId, agentId)

    expect((await submit(taskId, agentId)).outcome).toBe('already-open')
  })

  it('refuses one while a verifier is actively working on it', async () => {
    const agentId = await anAgent()
    const taskId = await aTask()
    await submit(taskId, agentId)
    await db.update(submissions).set({ status: 'verifying' })

    expect((await submit(taskId, agentId)).outcome).toBe('already-open')
  })

  it('lets a failed attempt be retried, on the next attempt number', async () => {
    const agentId = await anAgent()
    const taskId = await aTask()
    await submit(taskId, agentId)
    await decide(taskId, agentId, 'failed')

    const retry = await submit(taskId, agentId)

    if (retry.outcome !== 'accepted') throw new Error(retry.outcome)
    expect(retry.submission.attempt).toBe(2)
    expect(retry.submission.status).toBe('pending')
  })

  it('lets a timed-out attempt be retried — the agent was not the failure', async () => {
    const agentId = await anAgent()
    const taskId = await aTask()
    await submit(taskId, agentId)
    await decide(taskId, agentId, 'timeout')

    expect((await submit(taskId, agentId)).outcome).toBe('accepted')
  })

  it('refuses to reopen a task the agent has passed', async () => {
    const agentId = await anAgent()
    const taskId = await aTask()
    await submit(taskId, agentId)
    await decide(taskId, agentId, 'passed')

    // D-015. A pass has been paid; a second one for the same task is farming.
    expect((await submit(taskId, agentId)).outcome).toBe('already-passed')
  })

  it('keeps the whole attempt history rather than overwriting it', async () => {
    const agentId = await anAgent()
    const taskId = await aTask()
    await submit(taskId, agentId)
    await decide(taskId, agentId, 'failed')
    await submit(taskId, agentId)

    const rows = await db.select().from(submissions).where(eq(submissions.taskId, taskId))

    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.attempt).sort()).toEqual([1, 2])
  })

  it('keeps two agents attempting the same task independent', async () => {
    const taskId = await aTask()
    const first = await anAgent()
    const second = await anAgent()
    await submit(taskId, first)

    const result = await submit(taskId, second)

    if (result.outcome !== 'accepted') throw new Error(result.outcome)
    expect(result.submission.attempt).toBe(1)
  })

  it('does not commit a submission the transaction refused', async () => {
    const agentId = await anAgent()
    const taskId = await aTask({ requires: ['browser'] })

    await submit(taskId, agentId)

    expect(await db.select().from(submissions)).toHaveLength(0)
  })

  it('treats a vanished agent as broken, not as an ordinary refusal', async () => {
    const taskId = await aTask()

    // Not reachable through the API — the credential resolved to this agent one
    // query ago. If it ever happens, it is a deletion mid-request, and the agent
    // must not be told its task does not exist.
    await expectRejection(() => submit(taskId, AgentIdSchema.parse(randomUUID())), /no agent row/)
  })

  /**
   * The declaration (`#39`).
   *
   * An operator may help, and the Academy certifies control of a capability
   * rather than the autonomy of its acquisition (`kolonie-docs#36`). What that
   * costs is measurement, and these are the rows the measurement is read from.
   */
  describe('the assistance declaration', () => {
    it('records unknown when the agent declared nothing', async () => {
      const agentId = await anAgent()
      const taskId = await aTask()

      const result = await submit(taskId, agentId)

      // Not `none`. Every agent submitting today omits the field, and reading
      // that silence as an unattended pass would manufacture the Colony's own
      // MVP evidence.
      expect(result).toMatchObject({ outcome: 'accepted', submission: { assistance: 'unknown' } })
    })

    it.each(['none', 'operator-provided', 'operator-performed'] as const)(
      'stores %s exactly as it was declared',
      async (assistance) => {
        const agentId = await anAgent()
        const taskId = await aTask()

        const result = await submit(taskId, agentId, { assistance })

        expect(result).toMatchObject({ outcome: 'accepted', submission: { assistance } })
      },
    )

    it('refuses an assisted submission on a task that does not accept one', async () => {
      const agentId = await anAgent()
      const taskId = await aTask({ assistanceAllowed: false })

      const result = await submit(taskId, agentId, { assistance: 'operator-performed' })

      expect(result).toEqual({ outcome: 'assistance-refused', declared: 'operator-performed' })
      // Refused before anything was written: the agent may come back and do the
      // work itself without having burnt an attempt on the declaration.
      expect(await db.select().from(submissions)).toHaveLength(0)
    })

    it('accepts an unattended submission on the same task', async () => {
      const agentId = await anAgent()
      const taskId = await aTask({ assistanceAllowed: false })

      const result = await submit(taskId, agentId, { assistance: 'none' })

      expect(result).toMatchObject({ outcome: 'accepted' })
    })

    /**
     * Silence is not a declaration of assistance, so it is not refused here —
     * it is priced. A task the Colony wants done unaided cannot be climbed by
     * saying nothing either, because saying nothing never earns the unattended
     * rate.
     */
    it('accepts a silent submission on a task that refuses assistance', async () => {
      const agentId = await anAgent()
      const taskId = await aTask({ assistanceAllowed: false })

      const result = await submit(taskId, agentId)

      expect(result).toMatchObject({ outcome: 'accepted', submission: { assistance: 'unknown' } })
    })
  })

  /**
   * The query `ROADMAP.md`'s definition of done is checked with — the reason the
   * column exists at all (`kolonie-docs#37`).
   */
  describe('counting passes with no human in the loop', () => {
    const passWith = async (taskId: TaskId, assistance: Assistance) => {
      const agentId = await anAgent()
      await submit(taskId, agentId, { assistance })
      await decide(taskId, agentId, 'passed')
    }

    it('counts declared-unattended passes per task, and every pass alongside them', async () => {
      const mailbox = await aTask()
      await passWith(mailbox, 'none')
      await passWith(mailbox, 'none')
      await passWith(mailbox, 'operator-provided')
      await passWith(mailbox, 'unknown')

      const [tally] = await unattendedPasses(db)

      expect(tally).toMatchObject({ passes: 4, unattended: 2 })
    })

    it('ignores submissions that never passed', async () => {
      const taskId = await aTask()
      const failed = await anAgent()
      await submit(taskId, failed, { assistance: 'none' })
      await decide(taskId, failed, 'failed')

      const open = await anAgent()
      await submit(taskId, open, { assistance: 'none' })

      expect(await unattendedPasses(db)).toEqual([])
    })

    it('ignores passes by test accounts (Issue #20)', async () => {
      const mailbox = await aTask()

      // Citizen pass
      const citizen = await anAgent()
      await submit(mailbox, citizen, { assistance: 'none' })
      await decide(mailbox, citizen, 'passed')

      // Test pass
      const tester = await anAgent()
      await db.update(agents).set({ type: 'test' }).where(eq(agents.id, tester))
      await submit(mailbox, tester, { assistance: 'none' })
      await decide(mailbox, tester, 'passed')

      const [tally] = await unattendedPasses(db)

      // 2 passes exist, but only 1 from a citizen should be counted
      expect(tally).toMatchObject({ passes: 1, unattended: 1 })
    })
  })

  /**
   * What `GET /v1/agents/me/submissions` reads.
   *
   * The order is the part worth a database to test. The API tests drive a fake
   * that hands back its list untouched, so they would stay green if the
   * `order by` were deleted — only a real table can tell whether "newest first"
   * is true. The timestamps here are written explicitly rather than left to
   * `defaultNow()`, so the assertion rests on the query and not on how fast
   * three inserts happen to run.
   */
  describe('listSubmissions', () => {
    const submittedAt = async (agentId: AgentId, at: string): Promise<TaskId> => {
      const taskId = await aTask()
      await db.insert(submissions).values({
        taskId,
        agentId,
        payload: {},
        attempt: 1,
        status: 'pending',
        submittedAt: at,
      })
      return taskId
    }

    it('returns an agent every submission it has made, newest first', async () => {
      const agentId = await anAgent()
      // Inserted oldest-first, so insertion order cannot pass for sorted order.
      const oldest = await submittedAt(agentId, '2026-07-01T00:00:00.000Z')
      const middle = await submittedAt(agentId, '2026-07-15T00:00:00.000Z')
      const newest = await submittedAt(agentId, '2026-07-29T00:00:00.000Z')

      const found = await listSubmissions(db, agentId)

      expect(found.map((s) => s.taskId)).toEqual([newest, middle, oldest])
    })

    it('is empty for an agent that has not submitted anything', async () => {
      expect(await listSubmissions(db, await anAgent())).toEqual([])
    })

    /**
     * #208. Every verifier writes why it decided what it decided, and
     * `verifications` has stored it since #8 — but a citizen reading its own
     * submissions saw a status and nothing else. The `image-gen` instructions go
     * further and promise a per-constraint diagnosis, which its verifier does
     * produce, in exactly this string; the promise was kept everywhere except
     * where it could be read, so an agent retrying guessed across five
     * constraints.
     */
    it('carries the verdict’s own words, so a failure says why', async () => {
      const agentId = await anAgent()
      const taskId = await submittedAt(agentId, '2026-07-20T00:00:00.000Z')
      const [row] = await db
        .select({ id: submissions.id })
        .from(submissions)
        .where(eq(submissions.taskId, taskId))
      await db.insert(verifications).values({
        submissionId: row!.id,
        taskType: 'image-gen',
        status: 'fail',
        evidence: '2 of the five constraints did not hold: shape colour; position.',
      })

      const [found] = await listSubmissions(db, agentId)

      expect(found?.evidence).toBe(
        '2 of the five constraints did not hold: shape colour; position.',
      )
    })

    /**
     * `verifications` is append-only, so a submission re-checked after a
     * `pending` carries more than one row. What a citizen needs is where it
     * stands now — and a plain join would have multiplied the list instead.
     */
    it('carries the latest verdict and not the one it replaced', async () => {
      const agentId = await anAgent()
      const taskId = await submittedAt(agentId, '2026-07-20T00:00:00.000Z')
      const [row] = await db
        .select({ id: submissions.id })
        .from(submissions)
        .where(eq(submissions.taskId, taskId))
      await db.insert(verifications).values({
        submissionId: row!.id,
        taskType: 'image-gen',
        status: 'pending',
        evidence: 'The Colony could not have your image looked at.',
        createdAt: '2026-07-20T01:00:00.000Z',
      })
      await db.insert(verifications).values({
        submissionId: row!.id,
        taskType: 'image-gen',
        status: 'pass',
        evidence: 'A vision model read your image and found all five constraints.',
        createdAt: '2026-07-20T02:00:00.000Z',
      })

      const found = await listSubmissions(db, agentId)

      expect(found).toHaveLength(1)
      expect(found[0]?.evidence).toBe(
        'A vision model read your image and found all five constraints.',
      )
    })

    it('says nothing rather than guessing while no verdict has been reached', async () => {
      const agentId = await anAgent()
      await submittedAt(agentId, '2026-07-20T00:00:00.000Z')

      const [found] = await listSubmissions(db, agentId)

      expect(found?.evidence).toBeNull()
    })

    /**
     * #210. The list stays whole and the heaviest field became opt-in, which is
     * what keeps D-033 intact: a cap without a cursor would have made *did
     * anything fail* answerable wrongly rather than partially.
     */
    it('leaves the payload out unless it is asked for', async () => {
      const agentId = await anAgent()
      const taskId = await aTask()
      await db.insert(submissions).values({
        taskId,
        agentId,
        payload: { proof: 'a long piece of evidence' },
        attempt: 1,
        status: 'pending',
      })

      const [lean] = await listSubmissions(db, agentId)
      const [full] = await listSubmissions(db, agentId, { full: true })

      // Absent, not empty: "you did not ask" must not read as "you sent nothing".
      expect(lean).not.toHaveProperty('payload')
      expect(full?.payload).toEqual({ proof: 'a long piece of evidence' })
    })

    it('still returns every submission when the payload is left out', async () => {
      const agentId = await anAgent()
      await submittedAt(agentId, '2026-07-01T00:00:00.000Z')
      await submittedAt(agentId, '2026-07-15T00:00:00.000Z')
      await submittedAt(agentId, '2026-07-29T00:00:00.000Z')

      expect(await listSubmissions(db, agentId)).toHaveLength(3)
    })

    it('narrows to what came after a moment when asked, and to everything when not', async () => {
      const agentId = await anAgent()
      await submittedAt(agentId, '2026-07-01T00:00:00.000Z')
      const newer = await submittedAt(agentId, '2026-07-29T00:00:00.000Z')

      const since = await listSubmissions(db, agentId, { since: '2026-07-15T00:00:00.000Z' })

      expect(since.map((one) => one.taskId)).toEqual([newer])
      expect(await listSubmissions(db, agentId)).toHaveLength(2)
    })

    it('never shows one agent the submissions of another', async () => {
      const mine = await anAgent()
      const theirs = await anAgent()
      const own = await submittedAt(mine, '2026-07-20T00:00:00.000Z')
      await submittedAt(theirs, '2026-07-21T00:00:00.000Z')

      const found = await listSubmissions(db, mine)

      expect(found.map((s) => s.taskId)).toEqual([own])
    })
  })
})
