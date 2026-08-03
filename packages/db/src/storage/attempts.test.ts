import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import {
  CURRENT_CLAIM_ATTEMPTS,
  isKnownPassableAlone,
  MINIMUM_PASSES_FOR_SHARE,
  RegisterAgentRequestSchema,
  SNAPSHOT_TEXT_MAX_LENGTH,
  TaskIdSchema,
  TaskTypeSchema,
  type AgentId,
  type Assistance,
  type TaskId,
  type TaskStatus,
  CAPABILITY_STAGE,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import {
  agents,
  reputationEvents,
  submissions,
  taskAttempts,
  taskReports,
  tasks,
} from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import {
  lastRuntimeDeclarationAt,
  registerAgent,
  runtimeDeclarationsOf,
  updateAgentProfile,
} from './agents.js'
import { attemptRuntimeDeclarationsOf } from './history.js'
import {
  attemptStanding,
  attemptTallies,
  attemptsFor,
  capabilityDivides,
  capabilityOutcomes,
  closeAttempt,
  declareOperator,
  declareRuntime,
  declineAttempt,
  latestDeclaredCapabilities,
  operatorBreak,
  sovereigntyFor,
  runtimeChanges,
  gateFor,
  GATE_ATTEMPTS_BY_AGENT,
  medianAttemptsToPass,
  openAttempt,
  openAttemptFor,
  sweepAbandonedAttempts,
  unaidedPassRates,
} from './attempts.js'
import { reputationOfAgent } from './balance.js'
import { openAttemptForChallenge, recordObstructedAttemptForTaskType } from './challenge-tasks.js'
import { mintChallenge } from './challenges.js'
import { createSubmission } from './submissions.js'
import { fileReport } from './guidance.js'
import { claimNextSubmission, recordVerdict } from './verifications.js'
import { listTasks, readTask } from './tasks.js'

const target = databaseTestTarget()

describe('task attempts', () => {
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

  const anAgent = async (options: { type?: 'citizen' | 'test' } = {}): Promise<AgentId> => {
    const result = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name: `canary-${++seeded}`, platform: 'openclaw' }),
    )
    if (result.outcome !== 'registered') throw new Error(result.outcome)
    if (options.type === 'test') {
      await db.update(agents).set({ type: 'test' }).where(eq(agents.id, result.agent.id))
    }
    return result.agent.id
  }

  const aTask = async (options: { type?: string; status?: TaskStatus } = {}): Promise<TaskId> => {
    const [row] = await db
      .insert(tasks)
      .values({
        type: options.type ?? `academy-task-${++seeded}`,
        title: 'A rung',
        description: 'What this task is, for a human reading the catalogue.',
        instructions: 'What the agent must actually do.',
        rewardCredits: 0,
        rewardReputation: 1,
        timeoutHours: 24,
        status: options.status ?? 'active',
      })
      .returning({ id: tasks.id })

    if (row === undefined) throw new Error('insert into tasks returned no row')
    return TaskIdSchema.parse(row.id)
  }

  const submit = (taskId: TaskId, agentId: AgentId) =>
    createSubmission(db, { taskId, agentId, payload: { result: 'done' } })

  /**
   * A submission with a declared assistance, taken to a verdict.
   *
   * Written out rather than reusing `submit` because `#116` is entirely about
   * what was *declared*, and a helper that defaulted it would test the default.
   */
  const submitWith = async (
    agentId: AgentId,
    taskId: TaskId,
    taskType: string,
    assistance: Assistance,
    verdict: 'passed' | 'failed',
  ) => {
    const created = await createSubmission(db, {
      taskId,
      agentId,
      payload: { result: 'done' },
      assistance,
    })
    if (created.outcome !== 'accepted') throw new Error(created.outcome)

    const claimed = await claimNextSubmission(db, [TaskTypeSchema.parse(taskType)])
    if (claimed === undefined) throw new Error('nothing to claim')

    await recordVerdict(db, {
      submissionId: created.submission.id,
      taskType: claimed.taskType,
      result:
        verdict === 'passed'
          ? { status: 'pass', evidence: 'Everything the task asked for.' }
          : { status: 'fail', evidence: 'Not what the task asked for.' },
    })
  }

  /** What #112 requires before a next attempt opens on a task agents fail. */
  const sayWhatHappened = async (agentId: AgentId, taskId: TaskId) => {
    const filed = await fileReport(db, {
      taskId,
      agentId,
      narrative: { did: null, broke: 'The provider asked for a phone number.', changed: null },
    })
    if (filed.outcome !== 'recorded') throw new Error(filed.outcome)
  }

  /** The same, for a pass — which is the only kind `unattendedPasses` counts. */
  const passWith = (agentId: AgentId, taskId: TaskId, taskType: string, assistance: Assistance) =>
    submitWith(agentId, taskId, taskType, assistance, 'passed')

  const countAttempts = async (): Promise<number> => {
    const rows = await db.select({ id: taskAttempts.id }).from(taskAttempts)
    return rows.length
  }

  describe('what opens one', () => {
    it('opens an attempt when a challenge is minted', async () => {
      const agentId = await anAgent()
      await aTask({ type: 'browser-capability' })

      expect(await countAttempts()).toBe(0)

      await mintChallenge(db, agentId, CAPABILITY_STAGE)

      expect(await countAttempts()).toBe(1)
    })

    it('opens one when a submission arrives with no attempt open', async () => {
      const agentId = await anAgent()
      const taskId = await aTask()

      const result = await submit(taskId, agentId)

      expect(result.outcome).toBe('accepted')
      const [attempt] = await attemptsFor(db, agentId, taskId)
      expect(attempt?.opener).toBe('submission')
      expect(attempt?.attempt).toBe(1)
    })

    /**
     * The rejection case #108 names by name.
     *
     * Reading the catalogue must open nothing, or the abandonment rate — the
     * number the whole table exists to produce — measures curiosity instead of
     * difficulty. `listTasks` and `readTask` are the reads behind
     * `GET /v1/tasks` and `kolonie.tasks.get`, so this asserts against the real
     * paths rather than against the absence of a call nobody wrote.
     */
    it('opens nothing when an agent merely reads the catalogue', async () => {
      const agentId = await anAgent()
      const taskId = await aTask()

      const listed = await listTasks(db, { agentId, availableOnly: false, limit: 10 })
      const single = await readTask(db, { taskId, hints: true })

      expect(listed.outcome).not.toBe('invalid-cursor')
      expect(single).toBeDefined()
      expect(await countAttempts()).toBe(0)
    })

    it('does not open a second attempt while one is still open', async () => {
      const agentId = await anAgent()
      await aTask({ type: 'browser-capability' })

      await mintChallenge(db, agentId, CAPABILITY_STAGE)
      await mintChallenge(db, agentId, CAPABILITY_STAGE)

      expect(await countAttempts()).toBe(1)
    })

    /**
     * A submission lands on the challenge's attempt rather than starting
     * another. A mailbox rung that took three challenges and one submission is
     * one try, and counting it as two would inflate every denominator here.
     */
    it('lets a submission join the attempt a challenge opened', async () => {
      const agentId = await anAgent()
      const taskId = await aTask({ type: 'browser-capability' })

      await mintChallenge(db, agentId, CAPABILITY_STAGE)
      await submit(taskId, agentId)

      const attempts = await attemptsFor(db, agentId, taskId)
      expect(attempts).toHaveLength(1)
      expect(attempts[0]?.opener).toBe('challenge')
    })

    /**
     * The second submission is the second try, whatever became of the first.
     * Reusing the open attempt would merge two tries into one row and collide
     * on `submissions_task_agent_attempt_unique` besides.
     */
    it('starts a new attempt for a second submission on the same task', async () => {
      const agentId = await anAgent()
      const taskId = await aTask()

      await submit(taskId, agentId)
      await db.update(submissions).set({ status: 'failed', verifiedAt: new Date().toISOString() })

      const second = await submit(taskId, agentId)

      expect(second.outcome).toBe('accepted')
      const attempts = await attemptsFor(db, agentId, taskId)
      expect(attempts.map((a) => a.attempt)).toEqual([1, 2])
    })

    it('numbers attempts per agent and task rather than globally', async () => {
      const one = await anAgent()
      const other = await anAgent()
      const taskId = await aTask()

      await submit(taskId, one)
      await submit(taskId, other)

      expect((await attemptsFor(db, one, taskId))[0]?.attempt).toBe(1)
      expect((await attemptsFor(db, other, taskId))[0]?.attempt).toBe(1)
    })

    /**
     * Instrumentation must never cost a citizen its rung. A task type that is
     * not seeded in this environment leaves the mint working and simply
     * uncounted.
     */
    it('mints the challenge anyway when the task it belongs to is not seeded', async () => {
      const agentId = await anAgent()

      const minted = await mintChallenge(db, agentId, CAPABILITY_STAGE)

      expect(minted.id).toBeTruthy()
      expect(await countAttempts()).toBe(0)
    })
  })

  describe('what closes one', () => {
    it('closes as passed or failed when the verdict decides', async () => {
      const agentId = await anAgent()
      const taskId = await aTask()

      const attempt = await openAttempt(db, { agentId, taskId, opener: 'submission' })
      expect(await closeAttempt(db, attempt.id, 'failed')).toBe(true)

      const [closed] = await attemptsFor(db, agentId, taskId)
      expect(closed?.outcome).toBe('failed')
      expect(closed?.closedAt).not.toBeNull()
    })

    it('closes an expired attempt as abandoned without the agent coming back', async () => {
      const agentId = await anAgent()
      const taskId = await aTask()

      await openAttempt(db, {
        agentId,
        taskId,
        opener: 'challenge',
        expiresAt: new Date(Date.now() - 1000).toISOString() as never,
      })

      expect(await sweepAbandonedAttempts(db)).toBe(1)
      expect((await attemptsFor(db, agentId, taskId))[0]?.outcome).toBe('abandoned')
    })

    it('leaves an unexpired attempt alone', async () => {
      const agentId = await anAgent()
      const taskId = await aTask()

      await openAttempt(db, {
        agentId,
        taskId,
        opener: 'challenge',
        expiresAt: new Date(Date.now() + 60_000).toISOString() as never,
      })

      expect(await sweepAbandonedAttempts(db)).toBe(0)
      expect(await openAttemptFor(db, agentId, taskId)).not.toBeNull()
    })

    /**
     * An attempt a submission opened has no expiry and is never swept: it is
     * waiting on the verifier, not on the citizen.
     */
    it('never sweeps an attempt that is waiting on a verdict', async () => {
      const agentId = await anAgent()
      const taskId = await aTask()

      await submit(taskId, agentId)

      expect(await sweepAbandonedAttempts(db)).toBe(0)
      expect((await attemptStanding(db, agentId, taskId)).closed).toBe(0)
    })

    /**
     * The rule #108 inherits rather than restates, asserted through the real
     * verdict path.
     *
     * This is the difference between a statistic and an accusation. A verifier
     * that cannot reach what it reads answers `pending`, and closing the attempt
     * on that would count the Colony's own outage as the citizen's failure —
     * raising the task's measured failure rate and, once #112 lands, gating the
     * citizen's next try on a report about something that never happened.
     */
    it('leaves the attempt open on a pending verdict', async () => {
      const agentId = await anAgent()
      const taskId = await aTask({ type: 'example-task' })
      const created = await submit(taskId, agentId)
      if (created.outcome !== 'accepted') throw new Error(created.outcome)

      const claimed = await claimNextSubmission(db, [TaskTypeSchema.parse('example-task')])
      if (claimed === undefined) throw new Error('nothing to claim')

      await recordVerdict(db, {
        submissionId: created.submission.id,
        taskType: claimed.taskType,
        result: { status: 'pending', evidence: 'The transaction has not confirmed yet.' },
      })

      const [attempt] = await attemptsFor(db, agentId, taskId)
      expect(attempt?.outcome).toBeNull()
      expect((await attemptStanding(db, agentId, taskId)).closed).toBe(0)
    })

    it('closes the attempt when the verdict decided something', async () => {
      const agentId = await anAgent()
      const taskId = await aTask({ type: 'example-task' })
      const created = await submit(taskId, agentId)
      if (created.outcome !== 'accepted') throw new Error(created.outcome)

      const claimed = await claimNextSubmission(db, [TaskTypeSchema.parse('example-task')])
      if (claimed === undefined) throw new Error('nothing to claim')

      await recordVerdict(db, {
        submissionId: created.submission.id,
        taskType: claimed.taskType,
        result: { status: 'fail', evidence: 'No non-empty echo string in the payload.' },
      })

      const [attempt] = await attemptsFor(db, agentId, taskId)
      expect(attempt?.outcome).toBe('failed')
      expect(attempt?.closedAt).not.toBeNull()
    })

    it('refuses to close an attempt twice, keeping the first outcome', async () => {
      const agentId = await anAgent()
      const taskId = await aTask()

      const attempt = await openAttempt(db, { agentId, taskId, opener: 'submission' })
      expect(await closeAttempt(db, attempt.id, 'passed')).toBe(true)
      expect(await closeAttempt(db, attempt.id, 'failed')).toBe(false)

      expect((await attemptsFor(db, agentId, taskId))[0]?.outcome).toBe('passed')
    })
  })

  describe('erasure', () => {
    /**
     * `ARCHITECTURE.md`: *"if the row is the citizen's, it cascades"*. The
     * counter has to go with it — a statistic that still counts an attempt by
     * an agent that no longer exists is a citizen surviving its own erasure in
     * the only place it would not be noticed.
     */
    it('takes a citizen’s attempts with it, leaving no counter behind', async () => {
      const agentId = await anAgent()
      const taskId = await aTask()

      await openAttempt(db, { agentId, taskId, opener: 'submission' })
      expect(await countAttempts()).toBe(1)

      await db.delete(agents).where(eq(agents.id, agentId))

      expect(await countAttempts()).toBe(0)
      expect(await attemptTallies(db)).toEqual([])
    })
  })

  /**
   * Refusing a task, on the record and at no cost (#128).
   *
   * **Every assertion here is about a price not being charged.** The outcome is
   * cheap to add and easy to make expensive by accident — one call to
   * `isUnsuccessful`, one reputation event, one denominator — and each of those
   * would turn the honest move back into the costly one, which is the exact
   * incentive the outcome exists to remove.
   */
  describe('a citizen that refuses', () => {
    /**
     * Reputation is summed from `reputation_events` and lives in no column
     * (D-012), which makes the stronger assertion the natural one: not that the
     * total came out unchanged, but that refusing wrote no event at all. A
     * balancing pair of events would leave the total right and the record wrong.
     */
    const reputationEventCount = async (agentId: AgentId): Promise<number> => {
      const rows = await db
        .select({ id: reputationEvents.id })
        .from(reputationEvents)
        .where(eq(reputationEvents.agentId, agentId))
      return rows.length
    }

    it('closes its open attempt as declined, with the reason it gave', async () => {
      const agentId = await anAgent()
      const taskId = await aTask()
      await openAttempt(db, { agentId, taskId, opener: 'challenge' })

      const declined = await declineAttempt(
        db,
        agentId,
        taskId,
        'The form requires ticking "I am a human".',
      )

      expect(declined?.outcome).toBe('declined')
      expect(declined?.declineReason).toBe('The form requires ticking "I am a human".')
      expect(declined?.closedAt).not.toBeNull()
      expect(await openAttemptFor(db, agentId, taskId)).toBeNull()
    })

    it('pays nothing and loses nothing for it', async () => {
      const agentId = await anAgent()
      const taskId = await aTask()
      await openAttempt(db, { agentId, taskId, opener: 'challenge' })

      await declineAttempt(db, agentId, taskId, 'Not this one.')

      expect(await reputationEventCount(agentId)).toBe(0)
      expect(await reputationOfAgent(db, agentId)).toBe(0)
    })

    /**
     * The criterion the whole outcome rests on. A refusal that quietly bought
     * the citizen an obligation before its next try would be a price, and a
     * priced refusal is one nobody makes honestly.
     */
    it('is not barred from attempting the same task again', async () => {
      const agentId = await anAgent()
      const taskId = await aTask()
      await openAttempt(db, { agentId, taskId, opener: 'challenge' })
      await declineAttempt(db, agentId, taskId, 'Not today.')

      expect(await gateFor(db, agentId, taskId)).toEqual({ outcome: 'open' })

      const again = await openAttempt(db, { agentId, taskId, opener: 'challenge' })
      expect(again.attempt).toBe(2)
      expect(again.outcome).toBeNull()
    })

    it('may refuse as often as it likes', async () => {
      const agentId = await anAgent()
      const taskId = await aTask()

      for (let i = 0; i < 5; i++) {
        await openAttempt(db, { agentId, taskId, opener: 'challenge' })
        expect(await declineAttempt(db, agentId, taskId, `Refusal ${i}.`)).not.toBeNull()
      }

      expect(await reputationEventCount(agentId)).toBe(0)
    })

    it('cannot refuse what it has not started', async () => {
      const agentId = await anAgent()
      const taskId = await aTask()

      expect(await declineAttempt(db, agentId, taskId, 'Not this one.')).toBeNull()
      expect((await attemptStanding(db, agentId, taskId)).closed).toBe(0)
    })

    it('cannot refuse an attempt that is already closed', async () => {
      const agentId = await anAgent()
      const taskId = await aTask()
      const attempt = await openAttempt(db, { agentId, taskId, opener: 'submission' })
      await closeAttempt(db, attempt.id, 'passed')

      expect(await declineAttempt(db, agentId, taskId, 'Changed my mind.')).toBeNull()
      expect((await attemptsFor(db, agentId, taskId))[0]?.outcome).toBe('passed')
    })

    /**
     * The sweep closes what expired with nothing following it. A refusal has
     * already closed, so there is nothing for it to reach — but the sweep is
     * the one process that writes an outcome nobody asked for, and a refusal
     * silently rewritten as an abandonment would lose exactly the intent this
     * exists to record.
     */
    it('is never reclassified as abandoned by the sweep', async () => {
      const agentId = await anAgent()
      const taskId = await aTask()
      await openAttempt(db, {
        agentId,
        taskId,
        opener: 'challenge',
        expiresAt: new Date(Date.now() - 1000).toISOString() as never,
      })
      await declineAttempt(db, agentId, taskId, 'The task asks for something I will not do.')

      expect(await sweepAbandonedAttempts(db)).toBe(0)

      const [row] = await attemptsFor(db, agentId, taskId)
      expect(row?.outcome).toBe('declined')
      expect(row?.declineReason).toBe('The task asks for something I will not do.')
    })

    /**
     * The reason is the entire difference between `declined` and `abandoned`,
     * so the table refuses a row without one rather than trusting the writer —
     * and refuses one that carries a reason without the outcome to match.
     */
    it('cannot be stored without a reason, or with one on any other outcome', async () => {
      const agentId = await anAgent()
      const taskId = await aTask()
      const attempt = await openAttempt(db, { agentId, taskId, opener: 'challenge' })

      /**
       * The constraint name, dug out of the error chain — the same helper
       * `email.test.ts` needs and for the same reason: Drizzle wraps the
       * driver's error in its own "Failed query: …", and the constraint lives
       * on the `cause`. Matching the top-level message would assert that
       * *something* was refused, which on a table with six constraints is not
       * the assertion being made.
       */
      const constraintFrom = (error: unknown): string | undefined => {
        let current: unknown = error
        while (current !== null && typeof current === 'object') {
          const named = current as { constraint_name?: string; cause?: unknown }
          if (typeof named.constraint_name === 'string') return named.constraint_name
          current = named.cause
        }
        return undefined
      }

      await expect(
        db
          .update(taskAttempts)
          .set({ outcome: 'declined', closedAt: new Date().toISOString() })
          .where(eq(taskAttempts.id, attempt.id)),
      ).rejects.toSatisfy(
        (error: unknown) =>
          constraintFrom(error) === 'task_attempts_decline_reason_matches_outcome',
      )

      await expect(
        db
          .update(taskAttempts)
          .set({
            outcome: 'abandoned',
            declineReason: 'Not a refusal.',
            closedAt: new Date().toISOString(),
          })
          .where(eq(taskAttempts.id, attempt.id)),
      ).rejects.toSatisfy(
        (error: unknown) =>
          constraintFrom(error) === 'task_attempts_decline_reason_matches_outcome',
      )
    })

    /**
     * `erasure.md` on free text: this is the door identity re-enters a design
     * through, so it leaves with the citizen. It hangs on a row that cascades,
     * which is what makes that true without a second deletion path to forget.
     */
    it('takes its reason with it when the citizen erases itself', async () => {
      const agentId = await anAgent()
      const taskId = await aTask()
      await openAttempt(db, { agentId, taskId, opener: 'challenge' })
      await declineAttempt(db, agentId, taskId, 'My operator is at example.invalid and said no.')

      await db.delete(agents).where(eq(agents.id, agentId))

      const [remaining] = await db
        .select({ reason: taskAttempts.declineReason })
        .from(taskAttempts)
        .where(eq(taskAttempts.declineReason, 'My operator is at example.invalid and said no.'))
      expect(remaining).toBeUndefined()
    })
  })

  describe('the numbers it makes answerable', () => {
    it('counts starters, completions and abandonments per task', async () => {
      const taskId = await aTask({ type: 'the-rung' })
      const passer = await anAgent()
      const failer = await anAgent()
      const quitter = await anAgent()

      const a = await openAttempt(db, { agentId: passer, taskId, opener: 'submission' })
      await closeAttempt(db, a.id, 'passed')
      const b = await openAttempt(db, { agentId: failer, taskId, opener: 'submission' })
      await closeAttempt(db, b.id, 'failed')
      const c = await openAttempt(db, { agentId: quitter, taskId, opener: 'challenge' })
      await closeAttempt(db, c.id, 'abandoned')

      const [tally] = await attemptTallies(db)

      expect(tally?.starters).toBe(3)
      expect(tally?.passed).toBe(1)
      expect(tally?.abandoned).toBe(1)
      expect(tally?.completionRate).toBeCloseTo(1 / 3)
      expect(tally?.abandonmentRate).toBeCloseTo(1 / 3)
    })

    /**
     * A rung forty citizens refuse is a defect in the rung, and until this
     * number existed nothing anywhere said so (#128).
     *
     * **It stays out of both rates**, which is the assertion that matters here.
     * Those measure whether a rung *can* be climbed; a refusal is a statement
     * about whether it *should* be. Counting refusals as failures would make a
     * task nobody is willing to do look like a task nobody is able to do, and
     * the two call for opposite repairs.
     */
    it('counts refusals per task without letting them move the rates', async () => {
      const taskId = await aTask({ type: 'the-refused-rung' })
      const passer = await anAgent()
      const refuser = await anAgent()

      const a = await openAttempt(db, { agentId: passer, taskId, opener: 'submission' })
      await closeAttempt(db, a.id, 'passed')
      await openAttempt(db, { agentId: refuser, taskId, opener: 'challenge' })
      await declineAttempt(db, refuser, taskId, 'This asks me to claim I am a human.')

      const [tally] = await attemptTallies(db)

      expect(tally?.declined).toBe(1)
      expect(tally?.starters).toBe(2)
      // One pass, one refusal: the rung is passable by everyone who tried it.
      expect(tally?.completionRate).toBe(1)
      expect(tally?.abandonmentRate).toBe(0)
    })

    /**
     * An undecided attempt is not a result. Counting it in either direction
     * would make a task look harder or easier depending only on how recently
     * somebody started it.
     */
    it('keeps open attempts out of both rates', async () => {
      const taskId = await aTask()
      const agentId = await anAgent()
      const other = await anAgent()

      const a = await openAttempt(db, { agentId, taskId, opener: 'submission' })
      await closeAttempt(db, a.id, 'passed')
      await openAttempt(db, { agentId: other, taskId, opener: 'submission' })

      const [tally] = await attemptTallies(db)

      expect(tally?.open).toBe(1)
      expect(tally?.completionRate).toBe(1)
    })

    it('reports no rate at all for a task nothing has closed', async () => {
      const taskId = await aTask()
      await openAttempt(db, { agentId: await anAgent(), taskId, opener: 'challenge' })

      const [tally] = await attemptTallies(db)

      expect(tally?.completionRate).toBeNull()
      expect(tally?.abandonmentRate).toBeNull()
    })

    it('reports the median number of attempts to a pass', async () => {
      const taskId = await aTask()
      const quick = await anAgent()
      const slow = await anAgent()

      const first = await openAttempt(db, { agentId: quick, taskId, opener: 'submission' })
      await closeAttempt(db, first.id, 'passed')

      const one = await openAttempt(db, { agentId: slow, taskId, opener: 'submission' })
      await closeAttempt(db, one.id, 'failed')
      const two = await openAttempt(db, { agentId: slow, taskId, opener: 'submission' })
      await closeAttempt(db, two.id, 'failed')
      const three = await openAttempt(db, { agentId: slow, taskId, opener: 'submission' })
      await closeAttempt(db, three.id, 'passed')

      const [median] = await medianAttemptsToPass(db)

      expect(median?.median).toBe(2)
    })

    it('lists one agent’s attempts at one task in order', async () => {
      const agentId = await anAgent()
      const taskId = await aTask()

      const one = await openAttempt(db, { agentId, taskId, opener: 'submission' })
      await closeAttempt(db, one.id, 'failed')
      const two = await openAttempt(db, { agentId, taskId, opener: 'submission' })
      await closeAttempt(db, two.id, 'failed')

      expect((await attemptsFor(db, agentId, taskId)).map((a) => a.attempt)).toEqual([1, 2])
    })

    /**
     * The same exclusion `unattendedPasses` applies, for the same reason: a
     * tester's climbs are not evidence about how hard a rung is.
     */
    it('excludes test accounts', async () => {
      const taskId = await aTask()
      const tester = await anAgent({ type: 'test' })

      const attempt = await openAttempt(db, { agentId: tester, taskId, opener: 'submission' })
      await closeAttempt(db, attempt.id, 'passed')

      expect(await attemptTallies(db)).toEqual([])
      expect(await medianAttemptsToPass(db)).toEqual([])
    })
  })

  describe('the challenge-to-task mapping', () => {
    it('resolves a challenge to the task it belongs to', async () => {
      const agentId = await anAgent()
      const taskId = await aTask({ type: 'email-inbox' })

      const resolved = await openAttemptForChallenge(db, 'email', agentId, null)

      expect(resolved).toBe(taskId)
    })

    it('resolves nothing, and opens nothing, for a task in draft', async () => {
      const agentId = await anAgent()
      await aTask({ type: 'email-inbox', status: 'draft' })

      expect(await openAttemptForChallenge(db, 'email', agentId, null)).toBeNull()
      expect(await countAttempts()).toBe(0)
    })
  })
  describe('the runtime snapshot', () => {
    it('records what the agent declared, on the attempt rather than the agent', async () => {
      const agentId = await anAgent()
      const taskId = await aTask()
      await openAttempt(db, { agentId, taskId, opener: 'challenge' })

      expect(
        await declareRuntime(db, agentId, taskId, {
          model: 'some-model-v3',
          capabilities: { vision: false, browser: true },
        }),
      ).toEqual({ outcome: 'recorded' })

      const [attempt] = await attemptsFor(db, agentId, taskId)
      expect(attempt?.runtime.model).toBe('some-model-v3')
      expect(attempt?.runtime.capabilities).toEqual({ vision: false, browser: true })
    })

    /**
     * Declaring what you know when you know it must not be the lossy option.
     * A partial declaration that erased an earlier one would teach agents to
     * batch, which is the opposite of what this collects.
     */
    it('merges a later partial declaration into an earlier one', async () => {
      const agentId = await anAgent()
      const taskId = await aTask()
      await openAttempt(db, { agentId, taskId, opener: 'challenge' })

      await declareRuntime(db, agentId, taskId, { model: 'some-model-v3' })
      await declareRuntime(db, agentId, taskId, { capabilities: { shell: true } })

      const [attempt] = await attemptsFor(db, agentId, taskId)
      expect(attempt?.runtime.model).toBe('some-model-v3')
      expect(attempt?.runtime.capabilities).toEqual({ shell: true })
    })

    it('reports rather than throws when there is no open attempt', async () => {
      const agentId = await anAgent()
      const taskId = await aTask()

      expect(await declareRuntime(db, agentId, taskId, { model: 'some-model-v3' })).toEqual({
        outcome: 'no-open-attempt',
        reason: 'not-started',
      })
    })

    /**
     * #204: the two aggregate surfaces are fed by this path, not only by the
     * profile edit.
     *
     * `agent_runtime_declarations` used to be written by `kolonie.profile.update`
     * alone, so a citizen declaring its model here on every attempt — the call
     * the skills tell it to make — left `runtimeDeclaredAt` null and
     * `runtimeDeclarations[]` empty. The two surfaces whose whole job is to
     * summarise declaration state were blind to the path producing most of it,
     * and `runtimeDeclaredAt` is on `kolonie.me`, which every citizen calls at
     * every wake-up.
     */
    it('feeds the citizen-wide declaration history, not only the attempt', async () => {
      const agentId = await anAgent()
      const taskId = await aTask()
      await openAttempt(db, { agentId, taskId, opener: 'challenge' })

      expect(await lastRuntimeDeclarationAt(db, agentId)).toBeNull()

      await declareRuntime(db, agentId, taskId, { model: 'some-model-v3' })

      expect(await lastRuntimeDeclarationAt(db, agentId)).not.toBeNull()
      const history = await attemptRuntimeDeclarationsOf(db, agentId)
      expect(history).toHaveLength(1)
      expect(history[0]?.runtime.model).toBe('some-model-v3')
      expect(history[0]?.taskId).toBe(taskId)
      expect(history[0]?.attempt).toBe(1)

      // And **not** in the profile-sourced history, which is the correction
      // #228 made to this fix: a row there was indistinguishable from a profile
      // edit, so `model` appeared twice with nothing saying which call wrote
      // either.
      expect(await runtimeDeclarationsOf(db, agentId)).toEqual([])
    })

    /**
     * The field this whole aggregate exists for, and the one #204's fix could
     * not carry (`#228`).
     *
     * `kolonie.tasks.runtime` tells a citizen to declare on every attempt
     * because *"an attempt that says no vision route followed by one that says
     * vision route configured is the most useful thing the Colony can learn from
     * anybody"*. That sentence is `capabilities`, and it reached the citizen's
     * own history nowhere at all while the aggregate was fed by a `model` row.
     */
    it('carries the capabilities, the notes and the session, not only the model', async () => {
      const agentId = await anAgent()
      const taskId = await aTask()
      await openAttempt(db, { agentId, taskId, opener: 'challenge' })

      await declareRuntime(db, agentId, taskId, {
        model: 'some-model-v3',
        capabilities: { vision: true, shell: false },
        configurationNotes: 'A vision route configured through a local proxy.',
        session: 'headless, no shell on this run',
      })

      const [declaration] = await attemptRuntimeDeclarationsOf(db, agentId)
      expect(declaration?.source).toBe('tasks.runtime')
      expect(declaration?.runtime.capabilities).toEqual({ vision: true, shell: false })
      expect(declaration?.runtime.configurationNotes).toBe(
        'A vision route configured through a local proxy.',
      )
      expect(declaration?.runtime.session).toBe('headless, no shell on this run')
    })

    /**
     * The false positive that mirrors #204's false negative: a citizen that only
     * ever edited its profile must not look like one that declared per attempt.
     */
    it('keeps a profile edit and a per-attempt declaration apart', async () => {
      const agentId = await anAgent()
      const taskId = await aTask()
      await openAttempt(db, { agentId, taskId, opener: 'challenge' })

      await updateAgentProfile(db, agentId, { model: 'declared-on-the-profile' })
      await declareRuntime(db, agentId, taskId, { model: 'declared-on-the-attempt' })

      const profile = await runtimeDeclarationsOf(db, agentId)
      const attempts = await attemptRuntimeDeclarationsOf(db, agentId)

      expect(profile.map((row) => row.source)).toEqual(['profile'])
      expect(profile[0]?.value).toBe('declared-on-the-profile')
      expect(attempts.map((row) => row.source)).toEqual(['tasks.runtime'])
      expect(attempts[0]?.runtime.model).toBe('declared-on-the-attempt')
    })

    /**
     * A declaration carrying no model says nothing about the model, so it must
     * not stamp the history — otherwise `runtimeDeclaredAt` would answer *you
     * told us recently* for a citizen that has never named one, and the nudge
     * that field exists to drive would go silent for exactly the agents it is
     * meant to reach.
     */
    it('appends nothing when the declaration names no model', async () => {
      const agentId = await anAgent()
      const taskId = await aTask()
      await openAttempt(db, { agentId, taskId, opener: 'challenge' })

      await declareRuntime(db, agentId, taskId, { capabilities: { shell: true } })

      expect(await lastRuntimeDeclarationAt(db, agentId)).toBeNull()
      expect(await runtimeDeclarationsOf(db, agentId)).toEqual([])

      // It is in the citizen's own history all the same (`#228`), which is the
      // half of this that used to be missing: the timestamp drives a nudge
      // about the *model*, and the aggregate is a record of everything said.
      const [declaration] = await attemptRuntimeDeclarationsOf(db, agentId)
      expect(declaration?.runtime.capabilities).toEqual({ shell: true })
      expect(declaration?.runtime.model).toBeNull()
    })

    /**
     * The case #198 was filed about, and the reason the two are distinguished.
     *
     * `openAttemptFor` answers `null` here exactly as it does above, so before
     * this the citizen got one answer for two situations — and the one it was
     * given told it to start the task, which is the one thing that cannot
     * attach a declaration to the attempt that just closed.
     */
    it('separates an attempt that has closed from one never started', async () => {
      const agentId = await anAgent()
      const taskId = await aTask()
      const attempt = await openAttempt(db, { agentId, taskId, opener: 'challenge' })
      await closeAttempt(db, attempt.id, 'passed')

      expect(await declareRuntime(db, agentId, taskId, { model: 'some-model-v3' })).toEqual({
        outcome: 'no-open-attempt',
        reason: 'already-settled',
      })
    })

    /**
     * The rejection case. Refused at the boundary, never truncated — a
     * truncated model name is a false declaration, and false in the direction
     * that matters, because the tail is what distinguishes two versions.
     */
    it('refuses an oversized declaration rather than truncating it', async () => {
      const agentId = await anAgent()
      const taskId = await aTask()
      await openAttempt(db, { agentId, taskId, opener: 'challenge' })

      await expect(
        declareRuntime(db, agentId, taskId, {
          model: 'x'.repeat(SNAPSHOT_TEXT_MAX_LENGTH + 1),
        }),
      ).rejects.toThrow()

      expect((await attemptsFor(db, agentId, taskId))[0]?.runtime.model).toBeNull()
    })

    /** Instrumentation never costs a citizen its rung — absent, partial or oversized. */
    it('leaves a pass unaffected whatever the snapshot says', async () => {
      const agentId = await anAgent()
      const taskId = await aTask({ type: 'example-task' })
      const created = await submit(taskId, agentId)
      if (created.outcome !== 'accepted') throw new Error(created.outcome)

      await declareRuntime(db, agentId, taskId, { capabilities: { vision: true } })

      const claimed = await claimNextSubmission(db, [TaskTypeSchema.parse('example-task')])
      if (claimed === undefined) throw new Error('nothing to claim')
      const verdict = await recordVerdict(db, {
        submissionId: created.submission.id,
        taskType: claimed.taskType,
        result: { status: 'pass', evidence: 'Everything the task asked for.' },
      })

      expect(verdict.outcome).toBe('recorded')
      expect((await attemptsFor(db, agentId, taskId))[0]?.outcome).toBe('passed')
    })

    it('divides a task’s outcomes by a declared capability', async () => {
      const taskId = await aTask({ type: 'the-captcha-rung' })
      const seeing = await anAgent()
      const blind = await anAgent()

      const a = await openAttempt(db, { agentId: seeing, taskId, opener: 'challenge' })
      await declareRuntime(db, seeing, taskId, { capabilities: { vision: true } })
      await closeAttempt(db, a.id, 'passed')

      const b = await openAttempt(db, { agentId: blind, taskId, opener: 'challenge' })
      await declareRuntime(db, blind, taskId, { capabilities: { vision: false } })
      await closeAttempt(db, b.id, 'failed')

      const vision = (await capabilityOutcomes(db)).find((row) => row.flag === 'vision')

      expect(vision?.withFlag).toBe(1)
      expect(vision?.withFlagPassed).toBe(1)
      expect(vision?.withoutFlag).toBe(1)
      expect(vision?.withoutFlagPassed).toBe(0)
    })

    /**
     * Absent is not `false`. Counting silence as a missing capability would put
     * a citizen on the losing side of a sentence the Colony then addresses to
     * it directly — the one error this must not make.
     */
    it('counts an undeclared flag in neither column', async () => {
      const taskId = await aTask()
      const agentId = await anAgent()
      const attempt = await openAttempt(db, { agentId, taskId, opener: 'challenge' })
      await declareRuntime(db, agentId, taskId, { model: 'some-model-v3' })
      await closeAttempt(db, attempt.id, 'failed')

      expect((await capabilityOutcomes(db)).filter((row) => row.flag === 'vision')).toEqual([])
    })

    it('reports what changed between one attempt and the next', async () => {
      const agentId = await anAgent()
      const taskId = await aTask()

      const first = await openAttempt(db, { agentId, taskId, opener: 'challenge' })
      await declareRuntime(db, agentId, taskId, {
        model: 'text-only',
        capabilities: { vision: false },
      })
      await closeAttempt(db, first.id, 'failed')

      const second = await openAttempt(db, { agentId, taskId, opener: 'challenge' })
      await declareRuntime(db, agentId, taskId, {
        model: 'now-with-eyes',
        capabilities: { vision: true },
      })
      await closeAttempt(db, second.id, 'passed')

      const [change] = await runtimeChanges(db, agentId, taskId)

      expect(change?.from).toBe(1)
      expect(change?.to).toBe(2)
      expect(change?.modelChanged).toBe(true)
      expect(change?.capabilitiesChanged).toEqual(['vision'])
    })

    /**
     * A flag that went from undeclared to declared says the agent changed what
     * it *reports*, which is not evidence it changed its runtime. Treating the
     * two alike would manufacture the finding this programme most wants to be
     * true.
     */
    it('does not call a first-time declaration a change', async () => {
      const agentId = await anAgent()
      const taskId = await aTask()

      const first = await openAttempt(db, { agentId, taskId, opener: 'challenge' })
      await closeAttempt(db, first.id, 'failed')

      const second = await openAttempt(db, { agentId, taskId, opener: 'challenge' })
      await declareRuntime(db, agentId, taskId, { capabilities: { vision: true } })
      await closeAttempt(db, second.id, 'passed')

      expect((await runtimeChanges(db, agentId, taskId))[0]?.capabilitiesChanged).toEqual([])
    })
  })
  /**
   * The blind first attempt (#111) and the gate (#112), which are one describe
   * because they are two halves of one bargain: the Colony withholds its help
   * once, and asks for one sentence in return before it helps at all.
   */
  describe('what the first attempt costs and what the next one waits on', () => {
    it('reports an agent that has never tried as being on attempt 1', async () => {
      const agentId = await anAgent()
      const taskId = await aTask()

      expect(await attemptStanding(db, agentId, taskId)).toEqual({
        closed: 0,
        attempt: 1,
        passed: false,
      })
    })

    it('reports the open attempt as the one it is on, not the next one', async () => {
      const agentId = await anAgent()
      const taskId = await aTask()
      const first = await openAttempt(db, { agentId, taskId, opener: 'challenge' })
      await closeAttempt(db, first.id, 'failed')
      await openAttempt(db, { agentId, taskId, opener: 'challenge' })

      expect(await attemptStanding(db, agentId, taskId)).toMatchObject({ closed: 1, attempt: 2 })
    })

    /** A task it has passed is never withheld from it — re-reading is not an attempt. */
    it('remembers that it got through, so nothing is withheld afterwards', async () => {
      const agentId = await anAgent()
      const taskId = await aTask()
      const attempt = await openAttempt(db, { agentId, taskId, opener: 'submission' })
      await closeAttempt(db, attempt.id, 'passed')

      expect(await attemptStanding(db, agentId, taskId)).toMatchObject({ passed: true })
    })

    /**
     * The unaided pass rate: the denominator for everything else in this
     * programme. Every attempt was potentially contaminated by what the Colony
     * handed over, so there was no baseline at all.
     */
    it('measures the pass rate over first attempts alone', async () => {
      const taskId = await aTask({ type: 'the-rung' })

      const passer = await anAgent()
      await closeAttempt(
        db,
        (await openAttempt(db, { agentId: passer, taskId, opener: 'submission' })).id,
        'passed',
      )

      const failer = await anAgent()
      const one = await openAttempt(db, { agentId: failer, taskId, opener: 'submission' })
      await closeAttempt(db, one.id, 'failed')
      // Its second attempt is aided by construction and must not count.
      const two = await openAttempt(db, { agentId: failer, taskId, opener: 'submission' })
      await closeAttempt(db, two.id, 'passed')

      const [rate] = await unaidedPassRates(db)

      expect(rate?.first).toBe(2)
      expect(rate?.passed).toBe(1)
    })

    it('excludes test accounts from the unaided rate', async () => {
      const taskId = await aTask()
      const tester = await anAgent({ type: 'test' })
      await closeAttempt(
        db,
        (await openAttempt(db, { agentId: tester, taskId, opener: 'submission' })).id,
        'passed',
      )

      expect(await unaidedPassRates(db)).toEqual([])
    })

    describe('the gate on the next attempt', () => {
      /** A task nobody has closed an attempt on counts as above the threshold. */
      const aHardTask = async () => aTask()

      it('opens the next attempt when the last one was reported', async () => {
        const agentId = await anAgent()
        const taskId = await aHardTask()
        const attempt = await openAttempt(db, { agentId, taskId, opener: 'submission' })
        await closeAttempt(db, attempt.id, 'failed')
        await db
          .insert(taskReports)
          .values({ attemptId: attempt.id, broke: 'The signup page asked for a phone number.' })

        expect(await gateFor(db, agentId, taskId)).toEqual({ outcome: 'open' })
      })

      it('holds the next attempt when the last one said nothing', async () => {
        const agentId = await anAgent()
        const taskId = await aHardTask()
        const attempt = await openAttempt(db, { agentId, taskId, opener: 'submission' })
        await closeAttempt(db, attempt.id, 'failed')

        expect(await gateFor(db, agentId, taskId)).toEqual({
          outcome: 'report-first',
          attempt: 1,
        })
      })

      /** An abandoned attempt is an unsuccessful one, and the agent that comes back pays for it. */
      it('holds it after an abandoned attempt too', async () => {
        const agentId = await anAgent()
        const taskId = await aHardTask()
        const attempt = await openAttempt(db, { agentId, taskId, opener: 'challenge' })
        await closeAttempt(db, attempt.id, 'abandoned')

        expect((await gateFor(db, agentId, taskId)).outcome).toBe('report-first')
      })

      /**
       * The rejection case #112 names: an attempt the Colony could not decide is
       * not the citizen's silence. It is still open, and an open attempt never
       * triggers the gate.
       */
      it('never fires while an attempt is still open', async () => {
        const agentId = await anAgent()
        const taskId = await aHardTask()
        await openAttempt(db, { agentId, taskId, opener: 'challenge' })

        expect(await gateFor(db, agentId, taskId)).toEqual({ outcome: 'open' })
      })

      it('never fires after a pass', async () => {
        const agentId = await anAgent()
        const taskId = await aHardTask()
        const attempt = await openAttempt(db, { agentId, taskId, opener: 'submission' })
        await closeAttempt(db, attempt.id, 'passed')

        expect(await gateFor(db, agentId, taskId)).toEqual({ outcome: 'open' })
      })

      /**
       * **A report counts the instant it is stored, whatever the moderator later
       * decides.** Gating on approval would put the moderation queue back on the
       * critical path through the back door, and would punish a citizen for a
       * verdict it does not control.
       */
      it('opens the next attempt even when the report was rejected', async () => {
        const agentId = await anAgent()
        const taskId = await aHardTask()
        const attempt = await openAttempt(db, { agentId, taskId, opener: 'submission' })
        await closeAttempt(db, attempt.id, 'failed')
        await db.insert(taskReports).values({
          attemptId: attempt.id,
          broke: 'Something the moderator threw out entirely, and rightly.',
          status: 'rejected',
          moderationNote: 'Too vague to act on.',
          moderatedAt: new Date().toISOString(),
        })

        expect(await gateFor(db, agentId, taskId)).toEqual({ outcome: 'open' })
      })

      /**
       * A single failure on a task almost everybody passes says something about
       * that agent, not about the task. The machinery does not fire there.
       */
      it('does not fire on a task with a low measured failure rate', async () => {
        const taskId = await aTask()
        for (let i = 0; i < 10; i++) {
          const passer = await anAgent()
          await closeAttempt(
            db,
            (await openAttempt(db, { agentId: passer, taskId, opener: 'submission' })).id,
            'passed',
          )
        }

        const unlucky = await anAgent()
        const attempt = await openAttempt(db, { agentId: unlucky, taskId, opener: 'submission' })
        await closeAttempt(db, attempt.id, 'failed')

        expect(await gateFor(db, unlucky, taskId)).toEqual({ outcome: 'open' })
      })

      /**
       * The second clause, which catches an agent personally stuck on an easy
       * task — worth knowing precisely because it is unusual.
       */
      it('fires on an easy task once one agent has failed it three times', async () => {
        const taskId = await aTask()
        for (let i = 0; i < 20; i++) {
          const passer = await anAgent()
          await closeAttempt(
            db,
            (await openAttempt(db, { agentId: passer, taskId, opener: 'submission' })).id,
            'passed',
          )
        }

        const stuck = await anAgent()
        for (let i = 0; i < GATE_ATTEMPTS_BY_AGENT; i++) {
          const attempt = await openAttempt(db, { agentId: stuck, taskId, opener: 'challenge' })
          await closeAttempt(db, attempt.id, 'failed')
        }

        expect((await gateFor(db, stuck, taskId)).outcome).toBe('report-first')
      })
    })
    /**
     * **The one constraint the whole programme is built around.** A report
     * gating the reward path would hang the Academy off an LLM moderation queue
     * — runner down, budget gone, and an agent that passed does not get its
     * skill. So the gate refuses *before* a submission row exists, and nothing
     * downstream of a verdict can wait on anything.
     */
    describe('what the gate must never touch', () => {
      const passThrough = async (agentId: AgentId, taskId: TaskId) => {
        const created = await submit(taskId, agentId)
        if (created.outcome !== 'accepted') throw new Error(created.outcome)
        const claimed = await claimNextSubmission(db, [TaskTypeSchema.parse('example-task')])
        if (claimed === undefined) throw new Error('nothing to claim')
        return recordVerdict(db, {
          submissionId: created.submission.id,
          taskType: claimed.taskType,
          result: { status: 'pass', evidence: 'Everything the task asked for.' },
        })
      }

      it('books a pass normally when no report was ever filed', async () => {
        const agentId = await anAgent()
        const taskId = await aTask({ type: 'example-task' })

        const verdict = await passThrough(agentId, taskId)

        expect(verdict.outcome).toBe('recorded')
        expect((await attemptsFor(db, agentId, taskId))[0]?.outcome).toBe('passed')
      })

      /**
       * The gate holds the *next* attempt, so a submission that is already open
       * finishes and is decided regardless — an agent must never be left with a
       * verdict it cannot obtain.
       */
      it('decides an attempt that was already open, whatever the gate would say', async () => {
        const agentId = await anAgent()
        const taskId = await aTask({ type: 'example-task' })

        // A previous failure with nothing said, which is what the gate fires on.
        const earlier = await openAttempt(db, { agentId, taskId, opener: 'challenge' })
        await closeAttempt(db, earlier.id, 'failed')
        // And an attempt already open, which the gate must not reach.
        await openAttempt(db, { agentId, taskId, opener: 'challenge' })

        const verdict = await passThrough(agentId, taskId)

        expect(verdict.outcome).toBe('recorded')
      })

      /** And the refusal itself carries the attempt it is asking about. */
      it('refuses the next submission, naming the attempt that said nothing', async () => {
        const agentId = await anAgent()
        const taskId = await aTask({ type: 'example-task' })
        const earlier = await openAttempt(db, { agentId, taskId, opener: 'challenge' })
        await closeAttempt(db, earlier.id, 'failed')

        const refused = await submit(taskId, agentId)

        expect(refused).toEqual({ outcome: 'report-first', attempt: 1 })
      })
    })
  })

  /**
   * The divide a briefing is written against (#114).
   *
   * Distinct from `capabilityOutcomes` in exactly one way — it is bounded by the
   * recency window — and everything else about it is asserted through that one.
   */
  describe('the divide a briefing is written against', () => {
    const closedAttempt = async (
      agentId: AgentId,
      taskId: TaskId,
      capabilities: Record<string, boolean>,
      outcome: 'passed' | 'failed',
    ) => {
      const attempt = await openAttempt(db, { agentId, taskId, opener: 'challenge' })
      await declareRuntime(db, agentId, taskId, { capabilities })
      await closeAttempt(db, attempt.id, outcome)
      return attempt
    }

    it('counts both sides of a flag for the task the reader is on', async () => {
      const taskId = await aTask({ type: 'the-captcha-rung' })

      for (let i = 0; i < 3; i++) {
        await closedAttempt(await anAgent(), taskId, { vision: true }, 'passed')
      }
      for (let i = 0; i < 2; i++) {
        await closedAttempt(await anAgent(), taskId, { vision: false }, 'failed')
      }

      const vision = (await capabilityDivides(db, taskId)).find((row) => row.flag === 'vision')

      expect(vision).toEqual({
        flag: 'vision',
        withFlag: 3,
        withFlagPassed: 3,
        withoutFlag: 2,
        withoutFlagPassed: 0,
      })
    })

    /** Absent is not false — the one error this must not make. */
    it('counts an undeclared flag in neither column', async () => {
      const taskId = await aTask()
      const agentId = await anAgent()
      const attempt = await openAttempt(db, { agentId, taskId, opener: 'challenge' })
      await declareRuntime(db, agentId, taskId, { model: 'some-model-v3' })
      await closeAttempt(db, attempt.id, 'failed')

      expect(
        (await capabilityDivides(db, taskId)).find((row) => row.flag === 'vision'),
      ).toBeUndefined()
    })

    it('excludes test accounts and open attempts', async () => {
      const taskId = await aTask()
      await closedAttempt(await anAgent({ type: 'test' }), taskId, { vision: true }, 'passed')

      const stillGoing = await anAgent()
      await openAttempt(db, { agentId: stillGoing, taskId, opener: 'challenge' })
      await declareRuntime(db, stillGoing, taskId, { capabilities: { vision: true } })

      expect(await capabilityDivides(db, taskId)).toEqual([])
    })

    /**
     * The reason this exists beside `capabilityOutcomes`.
     *
     * A claim nobody has confirmed lately is demoted (#113), and a correlation is
     * a claim like any other — the Colony should not tell an agent to configure a
     * vision route on the strength of a wall that came down in June.
     *
     * **The two bounds are read exactly as `isCurrentClaim` reads them**, which
     * is what these two cases are really asserting: whichever is the more
     * generous wins, so evidence ages out only once the task has turned over
     * enough attempts to push it out *and* it is older than the day bound. A
     * quiet task keeps everything, because silence is not refutation.
     */
    it('keeps old evidence on a task that has not turned over enough attempts', async () => {
      const taskId = await aTask()
      const agentId = await anAgent()
      const old = await closedAttempt(agentId, taskId, { vision: true }, 'passed')

      // Opened as well as closed: the row's own constraint says an attempt cannot
      // close before it opened, which is what makes backdating one a two-column
      // edit rather than a one-column one.
      await db
        .update(taskAttempts)
        .set({
          openedAt: new Date(Date.now() - 401 * 86_400_000).toISOString(),
          closedAt: new Date(Date.now() - 400 * 86_400_000).toISOString(),
        })
        .where(eq(taskAttempts.id, old.id))

      // Far outside the day bound, and still counted: nothing has pushed it out.
      expect((await capabilityDivides(db, taskId)).find((row) => row.flag === 'vision')).toEqual({
        flag: 'vision',
        withFlag: 1,
        withFlagPassed: 1,
        withoutFlag: 0,
        withoutFlagPassed: 0,
      })
    })

    it('drops evidence once the task has turned over past it', async () => {
      const taskId = await aTask()
      const agentId = await anAgent()
      const old = await closedAttempt(agentId, taskId, { vision: true }, 'passed')

      // Opened as well as closed: the row's own constraint says an attempt cannot
      // close before it opened, which is what makes backdating one a two-column
      // edit rather than a one-column one.
      await db
        .update(taskAttempts)
        .set({
          openedAt: new Date(Date.now() - 401 * 86_400_000).toISOString(),
          closedAt: new Date(Date.now() - 400 * 86_400_000).toISOString(),
        })
        .where(eq(taskAttempts.id, old.id))

      // Enough recent closed attempts to move the window past it. They declare
      // nothing, so they are in neither column and only the bound moves.
      const busy = await anAgent()
      for (let i = 0; i < CURRENT_CLAIM_ATTEMPTS; i++) {
        const filler = await openAttempt(db, { agentId: busy, taskId, opener: 'challenge' })
        await closeAttempt(db, filler.id, 'failed')
      }

      expect(await capabilityDivides(db, taskId)).toEqual([])
    })

    it('answers nothing for a task that does not exist', async () => {
      expect(await capabilityDivides(db, TaskIdSchema.parse(randomUUID()))).toEqual([])
    })
  })

  describe('what the reader last said it is running as', () => {
    it('merges declarations across tasks, newest winning', async () => {
      const agentId = await anAgent()
      const first = await aTask()
      const second = await aTask()

      const a = await openAttempt(db, { agentId, taskId: first, opener: 'challenge' })
      await declareRuntime(db, agentId, first, { capabilities: { vision: false, browser: true } })
      await closeAttempt(db, a.id, 'failed')

      await openAttempt(db, { agentId, taskId: second, opener: 'challenge' })
      await declareRuntime(db, agentId, second, { capabilities: { vision: true } })

      // `browser` survives from the older attempt; `vision` is overwritten by the
      // newer one. An agent that declares one thing at a time has declared both.
      expect(await latestDeclaredCapabilities(db, agentId)).toEqual({
        vision: true,
        browser: true,
      })
    })

    /**
     * Never declared and declared nothing about this flag are different facts,
     * and the read path says so rather than treating silence as absence.
     */
    it('answers null for an agent that has never declared anything', async () => {
      const agentId = await anAgent()
      const taskId = await aTask()
      await openAttempt(db, { agentId, taskId, opener: 'challenge' })

      expect(await latestDeclaredCapabilities(db, agentId)).toBeNull()
    })

    it('never reads another agent’s declaration', async () => {
      const mine = await anAgent()
      const theirs = await anAgent()
      const taskId = await aTask()

      await openAttempt(db, { agentId: theirs, taskId, opener: 'challenge' })
      await declareRuntime(db, theirs, taskId, { capabilities: { vision: true } })

      await openAttempt(db, { agentId: mine, taskId, opener: 'challenge' })
      await declareRuntime(db, mine, taskId, { capabilities: { vision: false } })

      expect(await latestDeclaredCapabilities(db, mine)).toEqual({ vision: false })
    })
  })

  /**
   * The operator, recorded rather than policed (#116).
   *
   * The behaviour the Colony most wants to change is the one it could not see: a
   * citizen that tells its operator *"make me a mailbox, I cannot do this"*
   * appeared in no row at all, because that conversation usually happens instead
   * of a submission rather than before one.
   */
  describe('turning to an operator', () => {
    it('records the asking, what for, and what came of it', async () => {
      const agentId = await anAgent()
      const taskId = await aTask()
      await openAttempt(db, { agentId, taskId, opener: 'challenge' })

      expect(
        await declareOperator(db, agentId, taskId, {
          asked: true,
          askedFor: 'a mailbox that can send and receive',
          acted: true,
        }),
      ).toEqual({ outcome: 'recorded' })

      const [row] = await db
        .select({
          asked: taskAttempts.operatorAsked,
          askedFor: taskAttempts.operatorAskedFor,
          acted: taskAttempts.operatorActed,
        })
        .from(taskAttempts)
        .where(eq(taskAttempts.agentId, agentId))

      expect(row).toEqual({
        asked: true,
        askedFor: 'a mailbox that can send and receive',
        acted: true,
      })
    })

    /**
     * The row this whole column set exists for. A citizen that tried to escalate
     * and got no reply is otherwise indistinguishable from one that worked alone.
     */
    it('records asked and got nothing', async () => {
      const agentId = await anAgent()
      const taskId = await aTask()
      await openAttempt(db, { agentId, taskId, opener: 'challenge' })

      await declareOperator(db, agentId, taskId, { asked: true, acted: false })

      const [row] = await db
        .select({ asked: taskAttempts.operatorAsked, acted: taskAttempts.operatorActed })
        .from(taskAttempts)
        .where(eq(taskAttempts.agentId, agentId))

      expect(row).toEqual({ asked: true, acted: false })
    })

    it('clears what the operator did when the agent says it did not ask after all', async () => {
      const agentId = await anAgent()
      const taskId = await aTask()
      await openAttempt(db, { agentId, taskId, opener: 'challenge' })

      await declareOperator(db, agentId, taskId, { asked: true, askedFor: 'a key', acted: true })
      await declareOperator(db, agentId, taskId, { asked: false })

      const [row] = await db
        .select({
          asked: taskAttempts.operatorAsked,
          askedFor: taskAttempts.operatorAskedFor,
          acted: taskAttempts.operatorActed,
        })
        .from(taskAttempts)
        .where(eq(taskAttempts.agentId, agentId))

      // The row's own constraint would refuse the alternative, and the writer
      // does not leave it to the constraint to notice.
      expect(row).toEqual({ asked: false, askedFor: null, acted: null })
    })

    it('reports rather than throws when there is no attempt open, and is not an error', async () => {
      const agentId = await anAgent()
      const taskId = await aTask()

      expect(await declareOperator(db, agentId, taskId, { asked: true })).toEqual({
        outcome: 'no-open-attempt',
        reason: 'not-started',
      })
    })

    /**
     * #198 was filed against the runtime call, and this one reaches the same two
     * states through the same `openAttemptFor` null. Pinned here so the pair
     * cannot drift into one being legible and the other not.
     */
    it('separates an attempt that has closed from one never started', async () => {
      const agentId = await anAgent()
      const taskId = await aTask()
      const attempt = await openAttempt(db, { agentId, taskId, opener: 'challenge' })
      await closeAttempt(db, attempt.id, 'passed')

      expect(await declareOperator(db, agentId, taskId, { asked: true })).toEqual({
        outcome: 'no-open-attempt',
        reason: 'already-settled',
      })
    })

    /**
     * The forbidden states, seeded one of each — `operations/incidents.md`, *Two
     * migrations tested against a database that could not fail them*. The first
     * two are why the constraint says `is true` rather than `= true`: a check
     * passes when it evaluates to `NULL`, and `operator_asked` is `NULL` on every
     * row written before the column existed.
     */
    it('refuses an answer about an operator nobody says was asked', async () => {
      const agentId = await anAgent()
      const taskId = await aTask()
      const attempt = await openAttempt(db, { agentId, taskId, opener: 'challenge' })

      const forbidden = [
        { operatorActed: true },
        { operatorAskedFor: 'a key' },
        { operatorAsked: false, operatorActed: false },
        { operatorAsked: false, operatorAskedFor: 'a key' },
      ]

      for (const state of forbidden) {
        // Drizzle wraps the driver error, so the constraint name is on the cause
        // rather than on the message. Asserted rather than a bare `toThrow()`:
        // a row rejected for the wrong reason would pass that and prove nothing.
        const rejection = await db
          .update(taskAttempts)
          .set(state)
          .where(eq(taskAttempts.id, attempt.id))
          .then(
            () => null,
            (error: unknown) => error,
          )

        expect(String((rejection as { cause?: unknown })?.cause ?? rejection)).toContain(
          'task_attempts_operator_answers_hang_on_asking',
        )
      }
    })
  })

  describe('whether anybody has passed a task alone', () => {
    it('answers zeroes for a task nobody has passed', async () => {
      const taskId = await aTask()

      expect(await sovereigntyFor(db, taskId)).toEqual({ passes: 0, unattended: 0, share: null })
    })

    /**
     * The transition #116 calls an event: the first unattended pass flips a task
     * from *unknown* to *demonstrably passable alone*, and changes what every
     * later citizen is told.
     */
    it('flips on the pass that earns it', async () => {
      const taskId = await aTask({ type: 'the-mailbox-rung' })

      const helped = await anAgent()
      await passWith(helped, taskId, 'the-mailbox-rung', 'operator-performed')

      expect(isKnownPassableAlone(await sovereigntyFor(db, taskId))).toBe(false)

      const alone = await anAgent()
      await passWith(alone, taskId, 'the-mailbox-rung', 'none')

      const after = await sovereigntyFor(db, taskId)
      expect(isKnownPassableAlone(after)).toBe(true)
      expect(after.unattended).toBe(1)
      expect(after.passes).toBe(2)
    })

    /** A task with two passes has a share that will mislead. */
    it('withholds the share below the minimum and reports it above', async () => {
      const taskId = await aTask({ type: 'the-counted-rung' })

      for (let i = 0; i < MINIMUM_PASSES_FOR_SHARE - 1; i++) {
        await passWith(await anAgent(), taskId, 'the-counted-rung', 'none')
      }
      expect((await sovereigntyFor(db, taskId)).share).toBeNull()

      await passWith(await anAgent(), taskId, 'the-counted-rung', 'none')
      expect((await sovereigntyFor(db, taskId)).share).toBe(1)
    })
  })

  describe('the operator break', () => {
    /**
     * The report between the two attempts is not scaffolding — it is #112's gate
     * doing its job. An agent that failed and said nothing does not get a second
     * attempt on a task with this failure rate, so a break can only ever be
     * observed on the far side of a report.
     */
    it('sees a declaration move from none to an operator', async () => {
      const agentId = await anAgent()
      const taskId = await aTask({ type: 'the-broken-rung' })

      await submitWith(agentId, taskId, 'the-broken-rung', 'none', 'failed')
      await sayWhatHappened(agentId, taskId)
      await submitWith(agentId, taskId, 'the-broken-rung', 'operator-performed', 'passed')

      expect(await operatorBreak(db, agentId, taskId)).toBe(true)
    })

    it('sees nothing where the agent declared nothing', async () => {
      const agentId = await anAgent()
      const taskId = await aTask({ type: 'the-quiet-rung' })

      // Silence is not read as `none`. Two undeclared attempts are not a break.
      await submitWith(agentId, taskId, 'the-quiet-rung', 'unknown', 'failed')
      await sayWhatHappened(agentId, taskId)
      await submitWith(agentId, taskId, 'the-quiet-rung', 'operator-performed', 'passed')

      expect(await operatorBreak(db, agentId, taskId)).toBe(false)
    })

    it('sees nothing where the agent stayed alone', async () => {
      const agentId = await anAgent()
      const taskId = await aTask({ type: 'the-lone-rung' })

      await submitWith(agentId, taskId, 'the-lone-rung', 'none', 'failed')
      await sayWhatHappened(agentId, taskId)
      await submitWith(agentId, taskId, 'the-lone-rung', 'none', 'passed')

      expect(await operatorBreak(db, agentId, taskId)).toBe(false)
    })
  })

  /**
   * The Colony's own failure, recorded as such (#170).
   *
   * `#156` was a vision challenge that could not be minted: the API threw before
   * any row was written, so no attempt existed and the rung looked untouched on a
   * day it was unusable for everybody. These cover the recording, and — more
   * importantly — everywhere the recording must *not* be counted.
   */
  describe('an attempt the Colony could not serve', () => {
    const obstruct = (agentId: AgentId, taskType: string) =>
      recordObstructedAttemptForTaskType(db, taskType, agentId)

    it('writes a closed attempt naming the rung', async () => {
      const agentId = await anAgent()
      const taskId = await aTask({ type: 'the-broken-rung' })

      expect(await obstruct(agentId, 'the-broken-rung')).toBe(true)

      const [attempt] = await attemptsFor(db, agentId, taskId)
      expect(attempt?.outcome).toBe('obstructed')
      // Closed on the way in, so no sweep ever gets the chance to relabel it
      // `abandoned` — which would be a statement about the citizen, and false.
      expect(attempt?.closedAt).not.toBeNull()
    })

    it('does not spend the blind first attempt', async () => {
      const agentId = await anAgent()
      const taskId = await aTask({ type: 'the-broken-rung' })

      await obstruct(agentId, 'the-broken-rung')

      // The citizen has not tried yet. Its next call is its first real try, with
      // the unaided rule intact and the hints still withheld for the right reason.
      const standing = await attemptStanding(db, agentId, taskId)
      expect(standing.closed).toBe(0)
      expect(standing.attempt).toBe(1)
    })

    it('never asks the citizen for a report before its next try', async () => {
      const agentId = await anAgent()
      const taskId = await aTask({ type: 'the-broken-rung' })

      await obstruct(agentId, 'the-broken-rung')
      await obstruct(agentId, 'the-broken-rung')
      await obstruct(agentId, 'the-broken-rung')

      // Three of them, which is `GATE_ATTEMPTS_BY_AGENT` — the clause that would
      // fire on three real failures. Charging a citizen a report for our outage
      // is the exact inversion of what the report gate is for.
      expect(await gateFor(db, agentId, taskId)).toEqual({ outcome: 'open' })
    })

    it('is neither numerator nor denominator in a failure rate', async () => {
      const agentId = await anAgent()
      const other = await anAgent()
      const taskId = await aTask({ type: 'the-measured-rung' })

      await openAttempt(db, { agentId, taskId, opener: 'challenge' })
      const [passed] = await attemptsFor(db, agentId, taskId)
      await closeAttempt(db, passed!.id, 'passed')

      await obstruct(other, 'the-measured-rung')

      const [tally] = await attemptTallies(db)
      expect(tally?.obstructed).toBe(1)
      // One pass, one obstruction, and the rung reads as passed by everybody who
      // actually climbed it.
      expect(tally?.completionRate).toBe(1)
      expect(tally?.abandonmentRate).toBe(0)

      const [rate] = await unaidedPassRates(db)
      expect(rate).toEqual({ taskType: 'the-measured-rung', first: 1, passed: 1 })
    })

    it('leaves a citizen inside a try alone', async () => {
      const agentId = await anAgent()
      const taskId = await aTask({ type: 'the-broken-rung' })

      await openAttempt(db, { agentId, taskId, opener: 'challenge' })

      // Nothing to record: the gap this fixes is *no attempt existed*, and one
      // exists. Writing anyway would either end a try the citizen has not
      // finished, or close it as `abandoned` — about a citizen demonstrably present.
      expect(await obstruct(agentId, 'the-broken-rung')).toBe(false)

      const attempts = await attemptsFor(db, agentId, taskId)
      expect(attempts).toHaveLength(1)
      expect(attempts[0]?.outcome).toBeNull()
    })

    it('records nothing, and does not throw, for a rung this deployment has not seeded', async () => {
      const agentId = await anAgent()

      expect(await obstruct(agentId, 'a-rung-that-is-not-here')).toBe(false)
    })

    it('records nothing for a draft task, like every other attempt path', async () => {
      const agentId = await anAgent()
      await aTask({ type: 'the-unreleased-rung', status: 'draft' })

      expect(await obstruct(agentId, 'the-unreleased-rung')).toBe(false)
    })

    it("leaves a citizen's own failure exactly as it was", async () => {
      const agentId = await anAgent()
      const taskId = await aTask({ type: 'the-hard-rung' })

      await openAttempt(db, { agentId, taskId, opener: 'challenge' })
      const [attempt] = await attemptsFor(db, agentId, taskId)
      await closeAttempt(db, attempt!.id, 'failed')

      const [after] = await attemptsFor(db, agentId, taskId)
      expect(after?.outcome).toBe('failed')
      expect((await attemptStanding(db, agentId, taskId)).closed).toBe(1)
    })

    it('goes with the citizen when it is erased', async () => {
      const agentId = await anAgent()
      await aTask({ type: 'the-broken-rung' })

      await obstruct(agentId, 'the-broken-rung')
      await db.delete(agents).where(eq(agents.id, agentId))

      const [remaining] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(taskAttempts)
        .where(eq(taskAttempts.agentId, agentId))

      expect(Number(remaining?.count ?? 0)).toBe(0)
    })
  })
})
