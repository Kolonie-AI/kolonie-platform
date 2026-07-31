import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import {
  CURRENT_CLAIM_ATTEMPTS,
  RegisterAgentRequestSchema,
  SNAPSHOT_TEXT_MAX_LENGTH,
  TaskIdSchema,
  TaskTypeSchema,
  type AgentId,
  type TaskId,
  type TaskStatus,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agents, submissions, taskAttempts, taskReports, tasks } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import {
  attemptStanding,
  attemptTallies,
  attemptsFor,
  capabilityDivides,
  capabilityOutcomes,
  closeAttempt,
  closedAttemptCount,
  declareRuntime,
  latestDeclaredCapabilities,
  runtimeChanges,
  gateFor,
  GATE_ATTEMPTS_BY_AGENT,
  medianAttemptsToPass,
  openAttempt,
  openAttemptFor,
  sweepAbandonedAttempts,
  unaidedPassRates,
} from './attempts.js'
import { openAttemptForChallenge } from './challenge-tasks.js'
import { mintChallenge } from './challenges.js'
import { createSubmission } from './submissions.js'
import { claimNextSubmission, recordVerdict } from './verifications.js'
import { listTasks, readTask } from './tasks.js'

const target = databaseTestTarget()

if (!target.available) {
  console.warn(`\n${target.reason}\n`)
}

describe.skipIf(!target.available)('task attempts', () => {
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
        rewardCoins: 0,
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

  const countAttempts = async (): Promise<number> => {
    const rows = await db.select({ id: taskAttempts.id }).from(taskAttempts)
    return rows.length
  }

  describe('what opens one', () => {
    it('opens an attempt when a challenge is minted', async () => {
      const agentId = await anAgent()
      await aTask({ type: 'browser-capability' })

      expect(await countAttempts()).toBe(0)

      await mintChallenge(db, agentId, 'capability')

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

      await mintChallenge(db, agentId, 'capability')
      await mintChallenge(db, agentId, 'capability')

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

      await mintChallenge(db, agentId, 'capability')
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

      const minted = await mintChallenge(db, agentId, 'capability')

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
      expect(await closedAttemptCount(db, agentId, taskId)).toBe(0)
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
      expect(await closedAttemptCount(db, agentId, taskId)).toBe(0)
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
      const taskId = await aTask({ type: 'email-roundtrip' })

      const resolved = await openAttemptForChallenge(db, 'email', agentId, null)

      expect(resolved).toBe(taskId)
    })

    it('resolves nothing, and opens nothing, for a task in draft', async () => {
      const agentId = await anAgent()
      await aTask({ type: 'email-roundtrip', status: 'draft' })

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
      ).toBe(true)

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

      expect(await declareRuntime(db, agentId, taskId, { model: 'some-model-v3' })).toBe(false)
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
})
