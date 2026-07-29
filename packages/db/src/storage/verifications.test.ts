import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { asc, eq } from 'drizzle-orm'
import {
  RegisterAgentRequestSchema,
  SubmissionIdSchema,
  TaskIdSchema,
  TaskTypeSchema,
  type AgentId,
  type SubmissionId,
  type SubmissionStatus,
  type TaskId,
} from '@kolonie-ai/core'
import { createDatabase, type Database } from '../client.js'
import { agentSkills, submissions, tasks, verifications } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import {
  citizenForGithubAuthor,
  claimNextSubmission,
  expireOverdueSubmissions,
  recordVerdict,
  releaseSubmission,
  verificationsFor,
} from './verifications.js'

const target = databaseTestTarget()

if (!target.available) {
  console.warn(`\n${target.reason}\n`)
}

const EXAMPLE_TASK = TaskTypeSchema.parse('example-task')

describe.skipIf(!target.available)('the verifier-runner storage loop', () => {
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

  const aTask = async (
    options: { type?: string; timeoutHours?: number; grants?: readonly string[] } = {},
  ): Promise<TaskId> => {
    const [row] = await db
      .insert(tasks)
      .values({
        type: options.type ?? `academy-task-${++seeded}`,
        // What a task grants is not decoration in these tests:
        // `citizenForGithubAuthor` reads this column to decide which passes
        // stake a claim on a GitHub account (#42).
        grantsSkills: [...(options.grants ?? [])],
        title: 'Complete your profile',
        description: 'What this task is, for a human reading the catalogue.',
        instructions: 'What the agent must actually do.',
        rewardCoins: 1,
        rewardReputation: 1,
        timeoutHours: options.timeoutHours ?? 24,
        status: 'active',
      })
      .returning({ id: tasks.id })

    if (row === undefined) throw new Error('insert into tasks returned no row')
    return TaskIdSchema.parse(row.id)
  }

  /**
   * A submission in a chosen state at a chosen time.
   *
   * Written straight to the table rather than through `createSubmission`,
   * because half of these are states that function will not produce — a row
   * abandoned in `verifying`, a row submitted three days ago. The point of these
   * tests is what the loop does with rows it finds, including ones no correct
   * caller created.
   */
  const aSubmission = async (
    options: {
      taskId?: TaskId
      agentId?: AgentId
      status?: SubmissionStatus
      submittedAt?: string
      verifiedAt?: string
    } = {},
  ): Promise<SubmissionId> => {
    const taskId = options.taskId ?? (await aTask())
    const agentId = options.agentId ?? (await anAgent())
    const status = options.status ?? 'pending'

    const [row] = await db
      .insert(submissions)
      .values({
        taskId,
        agentId,
        payload: { echo: 'hello' },
        status,
        submittedAt: options.submittedAt ?? new Date().toISOString(),
        verifiedAt: options.verifiedAt ?? null,
      })
      .returning({ id: submissions.id })

    if (row === undefined) throw new Error('insert into submissions returned no row')
    return SubmissionIdSchema.parse(row.id)
  }

  /**
   * Stands in for the runner's deployed verifier set: every task type the
   * fixture created. The filter itself gets its own test below — this helper is
   * for the cases that are about something else.
   */
  const claimAny = async () => {
    const types = await db.selectDistinct({ type: tasks.type }).from(tasks)
    return claimNextSubmission(
      db,
      types.map((row) => TaskTypeSchema.parse(row.type)),
    )
  }

  const statusOf = async (id: SubmissionId) => {
    const [row] = await db
      .select({ status: submissions.status, verifiedAt: submissions.verifiedAt })
      .from(submissions)
      .where(eq(submissions.id, id))
    if (row === undefined) throw new Error('submission vanished')
    // Postgres' own rendering is not ISO 8601 — see `toTimestamp` in rows.ts.
    return {
      status: row.status,
      verifiedAt: row.verifiedAt === null ? null : new Date(row.verifiedAt).toISOString(),
    }
  }

  describe('claimNextSubmission', () => {
    it('claims nothing when the queue is empty', async () => {
      expect(await claimAny()).toBeUndefined()
    })

    it('claims a pending submission and marks it verifying', async () => {
      const taskId = await aTask({ type: 'example-task' })
      const id = await aSubmission({ taskId })

      const claimed = await claimAny()

      expect(claimed?.submission.id).toBe(id)
      expect(claimed?.submission.status).toBe('verifying')
      expect(claimed?.taskType).toBe(EXAMPLE_TASK)
      expect((await statusOf(id)).status).toBe('verifying')
    })

    it('serves the oldest submission first', async () => {
      const newer = await aSubmission({ submittedAt: '2026-07-20T10:00:00.000Z' })
      const older = await aSubmission({ submittedAt: '2026-07-19T10:00:00.000Z' })

      expect((await claimAny())?.submission.id).toBe(older)
      expect((await claimAny())?.submission.id).toBe(newer)
    })

    it('never claims a submission that is not pending', async () => {
      for (const status of ['verifying', 'passed', 'failed', 'timeout'] as const) {
        await aSubmission({ status, ...terminalFields(status) })
      }

      expect(await claimAny()).toBeUndefined()
    })

    /**
     * `AGENTS.md` §6: a missing verifier is not an error. The submission is not
     * claimed, not failed, and not touched — it waits for the deploy that can
     * answer it, and it does not sit at the head of the queue while it waits.
     */
    it('does not claim a submission whose verifier is not deployed', async () => {
      const taskId = await aTask({ type: 'instagram-follow' })
      const id = await aSubmission({ taskId })

      expect(await claimNextSubmission(db, [EXAMPLE_TASK])).toBeUndefined()
      expect((await statusOf(id)).status).toBe('pending')
    })

    it('walks past it to a submission it can verify', async () => {
      const unverifiable = await aTask({ type: 'instagram-follow' })
      await aSubmission({ taskId: unverifiable, submittedAt: '2026-07-19T10:00:00.000Z' })
      const verifiable = await aTask({ type: 'example-task' })
      const next = await aSubmission({
        taskId: verifiable,
        submittedAt: '2026-07-20T10:00:00.000Z',
      })

      const claimed = await claimNextSubmission(db, [EXAMPLE_TASK])
      expect(claimed?.submission.id).toBe(next)
    })

    it('claims nothing when it has no verifiers at all', async () => {
      await aSubmission()
      expect(await claimNextSubmission(db, [])).toBeUndefined()
    })

    /**
     * The reason `SKIP LOCKED` is in the query at all. A second runner holding
     * the oldest row must walk past it rather than block on it or claim it too —
     * one submission verified twice is one reward paid twice.
     */
    it('skips a row another runner is holding rather than waiting for it', async () => {
      const held = await aSubmission({ submittedAt: '2026-07-19T10:00:00.000Z' })
      const free = await aSubmission({ submittedAt: '2026-07-20T10:00:00.000Z' })

      const other = createDatabase(target.available ? target.url : '', {
        max: 1,
        onnotice: () => {},
      })

      let release = (): void => {}
      const lockTaken = new Promise<void>((resolve) => {
        void other.transaction(async (tx) => {
          await tx.select().from(submissions).where(eq(submissions.id, held)).for('update')
          resolve()
          await new Promise<void>((done) => {
            release = done
          })
        })
      })

      try {
        await lockTaken
        const claimed = await claimAny()
        expect(claimed?.submission.id).toBe(free)
      } finally {
        release()
        await other.close()
      }
    })
  })

  describe('recordVerdict', () => {
    const claim = async () => {
      const claimed = await claimAny()
      if (claimed === undefined) throw new Error('nothing to claim')
      return claimed
    }

    it('books a pass with its evidence, in one transaction', async () => {
      const taskId = await aTask({ type: 'example-task' })
      const id = await aSubmission({ taskId })
      const claimed = await claim()

      const result = await recordVerdict(db, {
        submissionId: id,
        taskType: claimed.taskType,
        result: {
          status: 'pass',
          evidence: 'Payload carried a 5-character echo.',
          metadata: { attempt: 1 },
        },
        now: '2026-07-28T12:00:00.000Z',
      })

      expect(result.outcome).toBe('recorded')
      if (result.outcome !== 'recorded') return
      expect(result.submission.status).toBe('passed')
      expect(result.submission.verifiedAt).toBe('2026-07-28T12:00:00.000Z')
      expect(result.verification.evidence).toContain('5-character echo')
      expect(result.verification.metadata).toEqual({ attempt: 1 })
      expect(result.verification.taskType).toBe(EXAMPLE_TASK)
    })

    it('records evidence on a fail too', async () => {
      const id = await aSubmission()
      const claimed = await claim()

      await recordVerdict(db, {
        submissionId: id,
        taskType: claimed.taskType,
        result: { status: 'fail', evidence: 'No non-empty echo string in the payload.' },
      })

      const trail = await verificationsFor(db, id)
      expect(trail).toHaveLength(1)
      expect(trail[0]?.status).toBe('fail')
      expect(trail[0]?.evidence).toContain('No non-empty echo')
      expect(trail[0]?.metadata).toBeNull()
      expect((await statusOf(id)).status).toBe('failed')
    })

    /**
     * A verifier that answers "the world has not replied yet" is not a verdict
     * on the agent. The submission goes back in the queue, and the check that
     * said so is still on the record — that history is what explains why the
     * payout carries a later timestamp than the submission.
     */
    it('returns a pending verdict to the queue, keeping the evidence', async () => {
      const id = await aSubmission()
      const claimed = await claim()

      await recordVerdict(db, {
        submissionId: id,
        taskType: claimed.taskType,
        result: { status: 'pending', evidence: 'The transaction has not confirmed yet.' },
      })

      const row = await statusOf(id)
      expect(row.status).toBe('pending')
      expect(row.verifiedAt).toBeNull()
      expect(await verificationsFor(db, id)).toHaveLength(1)
    })

    it('accumulates the trail rather than overwriting it', async () => {
      const id = await aSubmission()

      for (const evidence of ['first look: not confirmed', 'second look: not confirmed']) {
        const claimed = await claim()
        await recordVerdict(db, {
          submissionId: id,
          taskType: claimed.taskType,
          result: { status: 'pending', evidence },
        })
      }

      const claimed = await claim()
      await recordVerdict(db, {
        submissionId: id,
        taskType: claimed.taskType,
        result: { status: 'pass', evidence: 'third look: confirmed' },
      })

      const trail = await verificationsFor(db, id)
      expect(trail.map((entry) => entry.evidence)).toEqual([
        'first look: not confirmed',
        'second look: not confirmed',
        'third look: confirmed',
      ])
    })

    it('refuses to decide a submission that is no longer verifying', async () => {
      const id = await aSubmission({
        status: 'timeout',
        submittedAt: '2026-07-01T00:00:00.000Z',
        verifiedAt: '2026-07-02T00:00:00.000Z',
      })

      const result = await recordVerdict(db, {
        submissionId: id,
        taskType: EXAMPLE_TASK,
        result: { status: 'pass', evidence: 'A slow verifier finally answered.' },
      })

      expect(result.outcome).toBe('stale')
      if (result.outcome !== 'stale') return
      expect(result.status).toBe('timeout')
      expect(await verificationsFor(db, id)).toHaveLength(0)
    })
  })

  describe('releaseSubmission', () => {
    it('puts a claimed submission back without recording a verdict', async () => {
      const id = await aSubmission()
      await claimAny()

      expect(await releaseSubmission(db, id)).toBe(true)
      expect((await statusOf(id)).status).toBe('pending')
      expect(await verificationsFor(db, id)).toHaveLength(0)
    })

    it('does nothing to a submission that has already been decided', async () => {
      const id = await aSubmission()
      const claimed = await claimAny()
      await recordVerdict(db, {
        submissionId: id,
        taskType: claimed?.taskType ?? EXAMPLE_TASK,
        result: { status: 'fail', evidence: 'Nothing usable in the payload.' },
      })

      expect(await releaseSubmission(db, id)).toBe(false)
      expect((await statusOf(id)).status).toBe('failed')
    })
  })

  describe('expireOverdueSubmissions', () => {
    const NOW = '2026-07-28T12:00:00.000Z'

    it('leaves a submission inside its window alone', async () => {
      const taskId = await aTask({ timeoutHours: 24 })
      const id = await aSubmission({ taskId, submittedAt: '2026-07-28T00:00:00.000Z' })

      expect(await expireOverdueSubmissions(db, { now: NOW })).toEqual([])
      expect((await statusOf(id)).status).toBe('pending')
    })

    it('times out a pending submission past its deadline, with evidence', async () => {
      const taskId = await aTask({ type: 'example-task', timeoutHours: 1 })
      const id = await aSubmission({ taskId, submittedAt: '2026-07-28T10:00:00.000Z' })

      const expired = await expireOverdueSubmissions(db, { now: NOW })

      expect(expired).toEqual([
        { submissionId: id, taskType: EXAMPLE_TASK, previousStatus: 'pending' },
      ])
      const row = await statusOf(id)
      expect(row.status).toBe('timeout')
      expect(row.verifiedAt).toBe(NOW)

      const trail = await verificationsFor(db, id)
      expect(trail[0]?.status).toBe('timeout')
      expect(trail[0]?.evidence).toContain('1-hour window')
    })

    /**
     * The crashed-runner case. Nothing else reclaims a row abandoned in
     * `verifying`, and an agent polling for a verdict that can never arrive is
     * the failure this sweep exists to end.
     */
    it('reclaims a submission a dead runner left in verifying', async () => {
      const taskId = await aTask({ timeoutHours: 1 })
      const id = await aSubmission({
        taskId,
        status: 'verifying',
        submittedAt: '2026-07-28T09:00:00.000Z',
      })

      const expired = await expireOverdueSubmissions(db, { now: NOW })

      expect(expired[0]?.previousStatus).toBe('verifying')
      expect((await statusOf(id)).status).toBe('timeout')
    })

    it('never touches a submission that already has a verdict', async () => {
      const taskId = await aTask({ timeoutHours: 1 })
      const id = await aSubmission({
        taskId,
        status: 'passed',
        submittedAt: '2026-07-01T00:00:00.000Z',
        verifiedAt: '2026-07-01T01:00:00.000Z',
      })

      expect(await expireOverdueSubmissions(db, { now: NOW })).toEqual([])
      expect((await statusOf(id)).status).toBe('passed')
    })

    it('sweeps in batches so one long backlog cannot hold a transaction open', async () => {
      const taskId = await aTask({ timeoutHours: 1 })
      for (let i = 0; i < 3; i++) {
        await aSubmission({ taskId, submittedAt: '2026-07-28T09:00:00.000Z' })
      }

      expect(await expireOverdueSubmissions(db, { now: NOW, limit: 2 })).toHaveLength(2)
      expect(await expireOverdueSubmissions(db, { now: NOW, limit: 2 })).toHaveLength(1)
    })

    it('writes exactly one verification per expired submission', async () => {
      const taskId = await aTask({ timeoutHours: 1 })
      await aSubmission({ taskId, submittedAt: '2026-07-28T09:00:00.000Z' })

      await expireOverdueSubmissions(db, { now: NOW })
      await expireOverdueSubmissions(db, { now: NOW })

      const rows = await db.select().from(verifications).orderBy(asc(verifications.createdAt))
      expect(rows).toHaveLength(1)
    })
  })

  describe('citizenForGithubAuthor', () => {
    const GITHUB = 'github-contribution'
    /**
     * A second task type granting the same skill — the shape `kolonie-docs#39`
     * proposes, and the one this lookup used to be blind to.
     */
    const GITHUB_ACCOUNT = 'github-account'

    /** A task that grants `github`, which is what stakes a claim on an account. */
    const aGrantingTask = (type: string): Promise<TaskId> => aTask({ type, grants: ['github'] })

    /** A recorded verdict, written straight to the table the audit read uses. */
    const aVerdict = async (
      submissionId: SubmissionId,
      status: 'pass' | 'fail',
      metadata: Record<string, unknown> | null,
      createdAt?: string,
      taskType: string = GITHUB,
    ) => {
      await db.insert(verifications).values({
        submissionId,
        taskType,
        status,
        evidence: 'written by a fixture',
        metadata,
        ...(createdAt === undefined ? {} : { createdAt }),
      })
    }

    /**
     * The grant itself, which is what the lookup reads.
     *
     * A pass and a grant are two rows and the fixtures keep them apart on
     * purpose: an account is claimed by the skill actually having been
     * conferred, not merely by a verdict having said `pass`.
     */
    const aGrant = async (agentId: AgentId, submissionId: SubmissionId, grantedAt?: string) => {
      await db
        .insert(agentSkills)
        .values({
          agentId,
          skill: 'github',
          submissionId,
          ...(grantedAt === undefined ? {} : { grantedAt }),
        })
        .onConflictDoNothing()
    }

    const passedWith = async (
      author: string,
      agentId?: AgentId,
      taskType: string = GITHUB,
    ): Promise<AgentId> => {
      const agent = agentId ?? (await anAgent())
      const submissionId = await aSubmission({
        agentId: agent,
        taskId: await aGrantingTask(taskType),
        status: 'passed',
        ...terminalFields('passed'),
      })
      await aVerdict(submissionId, 'pass', { author }, undefined, taskType)
      await aGrant(agent, submissionId)
      return agent
    }

    it('answers with nobody when the account has never been used here', async () => {
      expect(await citizenForGithubAuthor(db, 'octocat')).toBeUndefined()
    })

    it('names the citizen an account has already passed for', async () => {
      const agentId = await passedWith('octocat')

      expect(await citizenForGithubAuthor(db, 'octocat')).toBe(agentId)
    })

    it('treats Octocat and octocat as one account', async () => {
      const agentId = await passedWith('octocat')

      // GitHub does. An anti-farming rule that does not is no rule at all — and
      // a citizen would clear Level 2 twice by capitalising differently.
      expect(await citizenForGithubAuthor(db, 'OCTOCAT')).toBe(agentId)
    })

    it('ignores a verdict that did not pass', async () => {
      const submissionId = await aSubmission({
        taskId: await aGrantingTask(GITHUB),
        status: 'failed',
        ...terminalFields('failed'),
      })
      await aVerdict(submissionId, 'fail', { author: 'octocat' })

      // A failed attempt does not spend the account. Otherwise one agent's
      // rejected submission would lock its own GitHub login out permanently.
      expect(await citizenForGithubAuthor(db, 'octocat')).toBeUndefined()
    })

    it('ignores a non-pass row on a submission that did go on to grant', async () => {
      const agent = await anAgent()
      const submissionId = await aSubmission({
        agentId: agent,
        taskId: await aGrantingTask(GITHUB),
        status: 'passed',
        ...terminalFields('passed'),
      })
      // A submission carries every check made on it, not just the last. An
      // earlier row naming a different account must not claim that account on
      // the strength of a pass that came afterwards and named another.
      await aVerdict(submissionId, 'fail', { author: 'ghost' }, '2026-07-01T00:00:00.000Z')
      await aVerdict(submissionId, 'pass', { author: 'octocat' }, '2026-07-02T00:00:00.000Z')
      await aGrant(agent, submissionId)

      expect(await citizenForGithubAuthor(db, 'ghost')).toBeUndefined()
      expect(await citizenForGithubAuthor(db, 'octocat')).toBe(agent)
    })

    it('ignores a passing verdict for a task that grants no github', async () => {
      const submissionId = await aSubmission({
        taskId: await aTask({ type: 'example-task' }),
        status: 'passed',
        ...terminalFields('passed'),
      })
      await db.insert(verifications).values({
        submissionId,
        taskType: 'example-task',
        status: 'pass',
        evidence: 'written by a fixture',
        metadata: { author: 'octocat' },
      })

      // A task that grants nothing stakes no claim, however its metadata is
      // shaped. `author` in the blob of an unrelated verdict must not lock an
      // account out — the rule is about the skill, not about a JSON key.
      expect(await citizenForGithubAuthor(db, 'octocat')).toBeUndefined()
    })

    it('sees an account certified by a second granting task type', async () => {
      const agentId = await passedWith('octocat', undefined, GITHUB_ACCOUNT)

      // The regression #42 exists for, and the reason it was worth writing
      // before any second granting type shipped: a filter naming one task type
      // answers `undefined` here, `undefined` means "free to claim", and every
      // other check in the verifier still passes. No error, no log line — one
      // agent's account quietly available to certify a second.
      expect(await citizenForGithubAuthor(db, 'octocat')).toBe(agentId)
    })

    it('keeps the claim when the task that granted it stops granting', async () => {
      const agentId = await passedWith('octocat')

      // `github-contribution` granted `github` until 2026-07-29 and is a badge
      // now (D-031). A lookup keyed on what the task grants *today* would free
      // every account certified before the split — the accounts of the agents
      // who actually walked the rung — the moment the seed was edited. The
      // grant happened, and the row recording it is what this reads.
      await db.update(tasks).set({ grantsSkills: [] }).where(eq(tasks.type, GITHUB))

      expect(await citizenForGithubAuthor(db, 'octocat')).toBe(agentId)
    })

    it('stakes no claim when the pass granted the agent nothing new', async () => {
      const agent = await passedWith('octocat')
      const second = await aSubmission({
        agentId: agent,
        taskId: await aGrantingTask(GITHUB_ACCOUNT),
        status: 'passed',
        ...terminalFields('passed'),
      })
      await aVerdict(second, 'pass', { author: 'hubot' }, undefined, GITHUB_ACCOUNT)
      // No grant row: the agent already held `github`, and `grantSkills` says
      // `on conflict do nothing`.

      // A deliberate narrowing rather than an oversight. Nothing was certified
      // by `hubot`, so nothing is spoken for — one citizen does not reserve two
      // accounts by passing twice.
      expect(await citizenForGithubAuthor(db, 'hubot')).toBeUndefined()
      expect(await citizenForGithubAuthor(db, 'octocat')).toBe(agent)
    })

    it('gives the account to whoever claimed it first across granting types', async () => {
      const first = await anAgent()
      const second = await anAgent()
      const firstSubmission = await aSubmission({
        agentId: first,
        taskId: await aGrantingTask(GITHUB_ACCOUNT),
        status: 'passed',
        ...terminalFields('passed'),
      })
      const secondSubmission = await aSubmission({
        agentId: second,
        taskId: await aGrantingTask(GITHUB),
        status: 'passed',
        ...terminalFields('passed'),
      })
      await aVerdict(
        firstSubmission,
        'pass',
        { author: 'octocat' },
        '2026-07-01T00:00:00.000Z',
        GITHUB_ACCOUNT,
      )
      await aVerdict(secondSubmission, 'pass', { author: 'octocat' }, '2026-07-02T00:00:00.000Z')
      await aGrant(first, firstSubmission, '2026-07-01T00:00:00.000Z')
      await aGrant(second, secondSubmission, '2026-07-02T00:00:00.000Z')

      // The ordering is over every grant of the skill, not per task type.
      // "Whichever type was looked at first" is not an ordering, and the older
      // claim is the one that has to survive.
      expect(await citizenForGithubAuthor(db, 'octocat')).toBe(first)
      expect(await citizenForGithubAuthor(db, 'octocat')).not.toBe(second)
    })

    it('is unbothered by a verdict that recorded no metadata at all', async () => {
      const submissionId = await aSubmission({
        taskId: await aGrantingTask(GITHUB),
        status: 'passed',
        ...terminalFields('passed'),
      })
      await aVerdict(submissionId, 'pass', null)

      // `metadata` is nullable, and `->>` on null is null rather than an error.
      // Asserted because a query that threw here would take the whole verifier
      // down for every submission, not just this one.
      expect(await citizenForGithubAuthor(db, 'octocat')).toBeUndefined()
    })

    it('gives the account to whoever claimed it first', async () => {
      const first = await anAgent()
      const second = await anAgent()
      const firstSubmission = await aSubmission({
        agentId: first,
        taskId: await aGrantingTask(GITHUB),
        status: 'passed',
        ...terminalFields('passed'),
      })
      const secondSubmission = await aSubmission({
        agentId: second,
        taskId: await aGrantingTask(GITHUB),
        status: 'passed',
        ...terminalFields('passed'),
      })
      await aVerdict(firstSubmission, 'pass', { author: 'octocat' }, '2026-07-01T00:00:00.000Z')
      await aVerdict(secondSubmission, 'pass', { author: 'octocat' }, '2026-07-02T00:00:00.000Z')
      await aGrant(first, firstSubmission, '2026-07-01T00:00:00.000Z')
      await aGrant(second, secondSubmission, '2026-07-02T00:00:00.000Z')

      // Two agents racing one account is the abuse this exists to stop, and
      // "whoever asked most recently" would let the second take the first's
      // answer — turning the rule into a way of stealing a level rather than a
      // way of preventing one being farmed.
      expect(await citizenForGithubAuthor(db, 'octocat')).toBe(first)
    })
  })
})

/**
 * The `submissions_verified_at_matches_status` constraint refuses a terminal row
 * without a verdict time, so a fixture in one has to carry one.
 */
function terminalFields(status: SubmissionStatus): { verifiedAt?: string } {
  return status === 'passed' || status === 'failed' || status === 'timeout'
    ? { verifiedAt: '2026-07-01T00:00:00.000Z' }
    : {}
}
