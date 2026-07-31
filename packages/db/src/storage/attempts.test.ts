import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  RegisterAgentRequestSchema,
  SNAPSHOT_TEXT_MAX_LENGTH,
  TaskIdSchema,
  TaskTypeSchema,
  type AgentId,
  type TaskId,
  type TaskStatus,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agents, submissions, taskAttempts, tasks } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import {
  attemptTallies,
  attemptsFor,
  capabilityOutcomes,
  closeAttempt,
  closedAttemptCount,
  declareRuntime,
  runtimeChanges,
  medianAttemptsToPass,
  openAttempt,
  openAttemptFor,
  sweepAbandonedAttempts,
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
})
