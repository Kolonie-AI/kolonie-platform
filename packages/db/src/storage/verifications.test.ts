import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { asc, eq } from 'drizzle-orm'
import {
  REVISION_VAR,
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
import { agentSkills, imageChallenges, submissions, tasks, verifications } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import {
  citizenForGithubAuthor,
  COLONY_FAULT_GRACE_MS,
  MAX_VERIFICATION_ATTEMPTS,
  citizenForPaymentTxid,
  githubAccountOf,
  claimNextSubmission,
  expireOverdueSubmissions,
  recordVerdict,
  releaseSubmission,
  verificationsFor,
} from './verifications.js'

const target = databaseTestTarget()

const EXAMPLE_TASK = TaskTypeSchema.parse('example-task')

describe('the verifier-runner storage loop', () => {
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

      const other = createDatabase(target.url, {
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

    /**
     * `#715`. Reporter 1 measured a verifier three times across a fix and could
     * not tell whether the fix was running — *after the issue was closed* is not
     * *after the deploy*, and no surface said which build had judged anything.
     * Their own words: *"if other citizens confirmed 709 the same way, the
     * confirmations are worth as little as mine was."*
     */
    describe('which build decided it', () => {
      const withRevision = async <T>(
        value: string | undefined,
        run: () => Promise<T>,
      ): Promise<T> => {
        const before = process.env[REVISION_VAR]
        if (value === undefined) delete process.env[REVISION_VAR]
        else process.env[REVISION_VAR] = value
        try {
          return await run()
        } finally {
          if (before === undefined) delete process.env[REVISION_VAR]
          else process.env[REVISION_VAR] = before
        }
      }

      it('is on the verdict, beside whatever the verifier recorded', async () => {
        const id = await aSubmission()
        const claimed = await claim()

        const result = await withRevision('a1b2c3d4e5f6', () =>
          recordVerdict(db, {
            submissionId: id,
            taskType: claimed.taskType,
            result: { status: 'pass', evidence: 'it echoed.', metadata: { attempt: 1 } },
          }),
        )

        if (result.outcome !== 'recorded') throw new Error('expected a recorded verdict')
        expect(result.verification.metadata).toEqual({ attempt: 1, judgedBy: 'a1b2c3d4e5f6' })
      })

      /**
       * The rejection case, and the point of the whole field: *unknown* must not
       * be confusable with a sha, or a verdict naming a build would be as
       * unfalsifiable as the silence it replaces. A local build says nothing.
       */
      it('is left off entirely where there is no revision to name', async () => {
        const id = await aSubmission()
        const claimed = await claim()

        const result = await withRevision(undefined, () =>
          recordVerdict(db, {
            submissionId: id,
            taskType: claimed.taskType,
            result: { status: 'pass', evidence: 'it echoed.', metadata: { attempt: 1 } },
          }),
        )

        if (result.outcome !== 'recorded') throw new Error('expected a recorded verdict')
        expect(result.verification.metadata).toEqual({ attempt: 1 })
      })

      it('names the build even on a verdict the verifier gave no metadata for', async () => {
        const id = await aSubmission()
        const claimed = await claim()

        const result = await withRevision('deadbeef', () =>
          recordVerdict(db, {
            submissionId: id,
            taskType: claimed.taskType,
            result: { status: 'fail', evidence: 'nothing echoed.' },
          }),
        )

        if (result.outcome !== 'recorded') throw new Error('expected a recorded verdict')
        expect(result.verification.metadata).toEqual({ judgedBy: 'deadbeef' })
      })
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

    /**
     * The retry ceiling (`#217`). A verdict of `pending` means *ask again*, and
     * before this there was nothing in the system that ever stopped asking:
     * one submission collected 1830 verification rows.
     */
    describe('the ceiling on how often one submission is checked', () => {
      /** Claim and answer `pending`, the way a flapping verifier does. */
      const checkAgain = async (id: SubmissionId) => {
        const claimed = await claim()
        return recordVerdict(db, {
          submissionId: id,
          taskType: claimed.taskType,
          result: { status: 'pending', evidence: 'the model could not be reached.' },
        })
      }

      it(`decides the submission on the ${MAX_VERIFICATION_ATTEMPTS}th check`, async () => {
        const id = await aSubmission()

        for (let n = 1; n < MAX_VERIFICATION_ATTEMPTS; n++) await checkAgain(id)
        const last = await checkAgain(id)

        expect(last.outcome).toBe('recorded')
        if (last.outcome !== 'recorded') return
        // `timeout` rather than `failed`: terminal, and not the citizen's failure.
        expect(last.submission.status).toBe('timeout')
        expect(last.verification.status).toBe('timeout')
        expect(last.booking).toBeUndefined()
        expect(await verificationsFor(db, id)).toHaveLength(MAX_VERIFICATION_ATTEMPTS)
      })

      /**
       * The rejection case, and the one that would go unnoticed: a ceiling that
       * fires early cuts off a world that was merely slow.
       */
      it(`is still pending on the ${MAX_VERIFICATION_ATTEMPTS - 1}th`, async () => {
        const id = await aSubmission()

        for (let n = 1; n < MAX_VERIFICATION_ATTEMPTS - 1; n++) await checkAgain(id)
        const result = await checkAgain(id)

        expect(result.outcome).toBe('recorded')
        if (result.outcome !== 'recorded') return
        expect(result.submission.status).toBe('pending')
      })

      it('does not apply the retry ceiling to a declared healthy wait', async () => {
        const id = await aSubmission()

        for (let n = 1; n <= MAX_VERIFICATION_ATTEMPTS; n++) {
          const claimed = await claim()
          const result = await recordVerdict(db, {
            submissionId: id,
            taskType: claimed.taskType,
            result: {
              status: 'pending',
              evidence: 'The second probe has not opened yet.',
              metadata: { expectedWaitUntil: '2026-08-09T03:42:32.578Z' },
            },
          })

          expect(result.outcome).toBe('recorded')
          if (result.outcome === 'recorded') expect(result.submission.status).toBe('pending')
        }
      })

      it('keeps the last verifier’s own evidence and adds why nobody will look again', async () => {
        const id = await aSubmission()

        for (let n = 1; n < MAX_VERIFICATION_ATTEMPTS; n++) await checkAgain(id)
        const last = await checkAgain(id)

        if (last.outcome !== 'recorded') throw new Error(last.outcome)
        expect(last.verification.evidence).toContain('could not be reached')
        expect(last.verification.evidence).toContain('does not count as an attempt')
      })

      /**
       * The ceiling may only ever turn *undecided* into *decided*. A verdict
       * that judged the citizen is the verifier's to give, and this function
       * overruling one would be a submission failed by bookkeeping.
       */
      it('never overrides a verdict that decided something', async () => {
        const id = await aSubmission()

        for (let n = 1; n < MAX_VERIFICATION_ATTEMPTS; n++) await checkAgain(id)

        const claimed = await claim()
        const last = await recordVerdict(db, {
          submissionId: id,
          taskType: claimed.taskType,
          result: { status: 'pass', evidence: 'it answered on the last look.' },
        })

        if (last.outcome !== 'recorded') throw new Error(last.outcome)
        expect(last.submission.status).toBe('passed')
      })
    })

    /**
     * The repair a Colony-fault verdict promises the citizen in writing (`#217`):
     * *your specification stays usable, and you can hand the same image in
     * again*. Nothing else in the system would keep that promise — a challenge
     * expires on its own clock.
     */
    describe('a verdict the Colony’s own machinery ended', () => {
      const aChallengeExpiringIn = async (agentId: AgentId, ms: number) => {
        await db.insert(imageChallenges).values({
          agentId,
          background: 'green',
          shape: 'circle',
          shapeColor: 'red',
          position: 'top-left',
          secondary: 'none',
          prompt: 'a red circle',
          // Dated back, because `image_challenges_expiry_after_creation` will
          // not accept a row that expired before it was written — which is
          // exactly the row the already-run-out case needs.
          createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
          expiresAt: new Date(Date.now() + ms).toISOString(),
        })
      }

      const expiryFor = async (agentId: AgentId) => {
        const [row] = await db
          .select({ expiresAt: imageChallenges.expiresAt })
          .from(imageChallenges)
          .where(eq(imageChallenges.agentId, agentId))
        return row === undefined ? null : Date.parse(new Date(row.expiresAt).toISOString())
      }

      const recordFault = async (id: SubmissionId) => {
        const claimed = await claim()
        return recordVerdict(db, {
          submissionId: id,
          taskType: claimed.taskType,
          result: {
            status: 'timeout',
            evidence: "the vendor refused the Colony's request with 400.",
            metadata: { colonyFault: true, challenge: 'image', vendorStatus: 400 },
          },
          now: new Date().toISOString(),
        })
      }

      it('extends a specification with less than the grace period left', async () => {
        const agentId = await anAgent()
        const id = await aSubmission({ agentId })
        await aChallengeExpiringIn(agentId, 5 * 60 * 1000)

        const before = Date.now()
        await recordFault(id)

        expect(await expiryFor(agentId)).toBeGreaterThanOrEqual(before + COLONY_FAULT_GRACE_MS)
      })

      /**
       * A floor, not a grant. A citizen with fifty minutes left keeps fifty
       * minutes; shortening one would be the repair doing harm.
       */
      it('leaves a specification with more time than that alone', async () => {
        const agentId = await anAgent()
        const id = await aSubmission({ agentId })
        await aChallengeExpiringIn(agentId, 2 * 60 * 60 * 1000)

        const before = await expiryFor(agentId)
        await recordFault(id)

        expect(await expiryFor(agentId)).toBe(before)
      })

      /**
       * The rejection case. A verdict arriving late must not undecide something
       * the citizen has long since let go — an expired specification is over.
       */
      it('does not resurrect a specification that has already run out', async () => {
        const agentId = await anAgent()
        const id = await aSubmission({ agentId })
        await aChallengeExpiringIn(agentId, -60 * 1000)

        const before = await expiryFor(agentId)
        await recordFault(id)

        expect(await expiryFor(agentId)).toBe(before)
      })

      it('touches nothing when the verdict claims no fault of ours', async () => {
        const agentId = await anAgent()
        const id = await aSubmission({ agentId })
        await aChallengeExpiringIn(agentId, 5 * 60 * 1000)

        const before = await expiryFor(agentId)
        const claimed = await claim()
        await recordVerdict(db, {
          submissionId: id,
          taskType: claimed.taskType,
          result: { status: 'fail', evidence: 'two of the five constraints did not hold.' },
        })

        expect(await expiryFor(agentId)).toBe(before)
      })
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

    /**
     * The mirror-image question, and the one `code-contribution` asks (#48):
     * not *whose account is this* but *which account is this citizen's*.
     */
    it('reads back which account a citizen certified', async () => {
      const agentId = await passedWith('octocat')

      expect(await githubAccountOf(db, agentId)).toBe('octocat')
    })

    it('answers with nothing for a citizen that never proved an account', async () => {
      expect(await githubAccountOf(db, await anAgent())).toBeUndefined()
    })

    /**
     * **A citizen cannot acquire a second certified account**, and this is where
     * that is visible. `agent_skills` is keyed on `(agent_id, skill)`, so a
     * later pass naming a different login grants nothing new, writes no row, and
     * leaves the answer alone. `code-contribution` therefore always searches the
     * account the citizen actually proved.
     */
    it('keeps the account that granted the skill when a later pass names another', async () => {
      const agentId = await anAgent()
      const first = await aSubmission({
        agentId,
        taskId: await aGrantingTask(GITHUB),
        status: 'passed',
        ...terminalFields('passed'),
      })
      const second = await aSubmission({
        agentId,
        taskId: await aGrantingTask(GITHUB_ACCOUNT),
        status: 'passed',
        ...terminalFields('passed'),
      })
      await aVerdict(first, 'pass', { author: 'octocat' }, '2026-07-01T00:00:00.000Z')
      await aVerdict(
        second,
        'pass',
        { author: 'hubot' },
        '2026-07-02T00:00:00.000Z',
        GITHUB_ACCOUNT,
      )
      await db
        .insert(agentSkills)
        .values({
          agentId,
          skill: 'github',
          submissionId: first,
          grantedAt: '2026-07-01T00:00:00.000Z',
        })
        .onConflictDoNothing()
      await db
        .insert(agentSkills)
        .values({
          agentId,
          skill: 'github',
          submissionId: second,
          grantedAt: '2026-07-02T00:00:00.000Z',
        })
        .onConflictDoNothing()

      expect(await githubAccountOf(db, agentId)).toBe('octocat')
    })

    it('ignores a verdict that did not pass when reading a citizen’s account', async () => {
      const agentId = await anAgent()
      const submissionId = await aSubmission({
        agentId,
        taskId: await aGrantingTask(GITHUB),
        status: 'failed',
        ...terminalFields('failed'),
      })
      await aVerdict(submissionId, 'fail', { author: 'octocat' })

      expect(await githubAccountOf(db, agentId)).toBeUndefined()
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

  describe('one payment certifies one earning', () => {
    const TXID = '5wHu1qwD4kLmNbVcXzAsDfGhJkLpQwErTyUiOpAsDfGhJkLzXcVbNmQwErTyUiOp'
    const OTHER_TXID = '3zZzQqWwEeRrTtYyUuIiOoPpAaSsDdFfGgHhJjKkLlZzXxCcVvBbNnMm11223344'

    /** A task granting `payment`, which is what all four earning rungs grant. */
    const anEarningTask = (type: string): Promise<TaskId> => aTask({ type, grants: ['payment'] })

    const earnedWith = async (options: {
      readonly txid: string
      readonly agentId?: AgentId
      readonly taskType?: string
      readonly status?: 'pass' | 'fail'
      readonly createdAt?: string
      readonly grant?: boolean
    }): Promise<AgentId> => {
      const agent = options.agentId ?? (await anAgent())
      const taskType = options.taskType ?? 'api-monetize'
      const status = options.status ?? 'pass'
      const submissionId = await aSubmission({
        agentId: agent,
        taskId: await anEarningTask(taskType),
        status: status === 'pass' ? 'passed' : 'failed',
        ...terminalFields(status === 'pass' ? 'passed' : 'failed'),
      })
      await db.insert(verifications).values({
        submissionId,
        taskType,
        status,
        evidence: 'written by a fixture',
        metadata: { txid: options.txid },
        ...(options.createdAt === undefined ? {} : { createdAt: options.createdAt }),
      })
      if (options.grant !== false) {
        await db
          .insert(agentSkills)
          .values({ agentId: agent, skill: 'payment', submissionId })
          .onConflictDoNothing()
      }
      return agent
    }

    it('answers with nobody for a transaction never submitted here', async () => {
      expect(await citizenForPaymentTxid(db, TXID)).toBeUndefined()
    })

    it('names the citizen a transaction has already earned for', async () => {
      const agentId = await earnedWith({ txid: TXID })

      expect(await citizenForPaymentTxid(db, TXID)).toBe(agentId)
    })

    /**
     * **The reason this reads verdicts and not grants**, and the case that would
     * be silently wrong if it did.
     *
     * Four tasks share one skill. A citizen granted `payment` by `api-monetize`
     * is granted nothing new when it clears `bounty-hunter`, so no
     * `agent_skills` row is written for the second — `grantSkills` is
     * `on conflict do nothing`. A guard reading grants the way
     * `citizenForGithubAuthor` does would never learn that the second
     * transaction was spent, and `workflow-seller` would take it again.
     */
    it('spends a transaction even when the pass granted nothing new', async () => {
      const agentId = await earnedWith({ txid: TXID })
      await earnedWith({
        txid: OTHER_TXID,
        agentId,
        taskType: 'bounty-hunter',
        // The agent already holds `payment`. This is what the real path writes.
        grant: false,
      })

      expect(await citizenForPaymentTxid(db, OTHER_TXID)).toBe(agentId)
    })

    it('ignores a verdict that did not pass', async () => {
      await earnedWith({ txid: TXID, status: 'fail', grant: false })

      // A failed attempt does not spend the transaction. An agent that
      // submitted a txid before it confirmed must be able to submit it again.
      expect(await citizenForPaymentTxid(db, TXID)).toBeUndefined()
    })

    it('does not fold case, because base58 is case-sensitive', async () => {
      await earnedWith({ txid: TXID })

      // Unlike a GitHub login. `5wHu…` and `5WHU…` are different signatures,
      // and treating them as one would refuse an honest second payment.
      expect(await citizenForPaymentTxid(db, TXID.toUpperCase())).toBeUndefined()
    })

    it('gives the transaction to whoever claimed it first', async () => {
      const first = await earnedWith({ txid: TXID, createdAt: '2026-07-01T00:00:00.000Z' })
      const second = await earnedWith({
        txid: TXID,
        taskType: 'workflow-seller',
        createdAt: '2026-07-02T00:00:00.000Z',
      })

      expect(await citizenForPaymentTxid(db, TXID)).toBe(first)
      expect(await citizenForPaymentTxid(db, TXID)).not.toBe(second)
    })

    it('is unbothered by a verdict that recorded no metadata at all', async () => {
      const submissionId = await aSubmission({
        taskId: await anEarningTask('api-monetize'),
        status: 'passed',
        ...terminalFields('passed'),
      })
      await db.insert(verifications).values({
        submissionId,
        taskType: 'api-monetize',
        status: 'pass',
        evidence: 'written by a fixture',
        metadata: null,
      })

      // `metadata` is nullable and `->>` on null is null rather than an error.
      // A query that threw here would take down every earning verdict at once.
      expect(await citizenForPaymentTxid(db, TXID)).toBeUndefined()
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
