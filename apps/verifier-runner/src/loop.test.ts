import { describe, expect, it } from 'vitest'
import {
  AgentSchema,
  SubmissionSchema,
  TaskTypeSchema,
  type Agent,
  type Submission,
  type SubmissionId,
  type TaskType,
  type Verifier,
} from '@kolonie-ai/core'
import { startRunner, tick, type Log } from './loop.js'
import type {
  ClaimedSubmission,
  ExpiredSubmission,
  RecordVerdictCommand,
  RecordVerdictResult,
  ReportRoutingResult,
  RerunReportResult,
  SubmissionQueue,
} from './queue.js'

const EXAMPLE_TASK = TaskTypeSchema.parse('example-task')

/**
 * A verifier that exists for these tests and nowhere else.
 *
 * The loop's job is to claim a row, hand it to whatever can decide it, and
 * always either write a verdict or put the row back. None of that is a statement
 * about a particular verifier, so these tests carry their own and pass it in.
 *
 * Passing `verifiers` also fixes which task types are claimed — `tick` derives
 * `taskTypes` from the registry's keys — which is how the runner wires itself in
 * production. Before D-025 these tests named the type instead and let the
 * registry default, so deleting `ApiCallVerifier` made every one of them claim a
 * row nothing could decide.
 */
const stub: Verifier = {
  taskType: EXAMPLE_TASK,
  verify: async (submission) =>
    submission.payload['echo'] === undefined
      ? { status: 'fail', evidence: 'The payload carried no echo.' }
      : { status: 'pass', evidence: 'Echoed.' },
}

const verifiers = new Map([[stub.taskType, stub]])

const aSubmission = (
  id: string,
  payload: Record<string, unknown> = { echo: 'hello' },
): Submission =>
  SubmissionSchema.parse({
    id,
    taskId: '3f1e0a4e-6d2b-4c3a-9f5e-1a2b3c4d5e6f',
    agentId: '11111111-2222-4333-8444-555555555555',
    payload,
    status: 'verifying',
    assistance: 'unknown',
    attempt: 1,
    report: null,
    reportOutcome: null,
    submittedAt: '2026-07-27T10:00:00.000Z',
    verifiedAt: null,
  })

/** The agent the queue joins onto every claim (D-018). */
const anAgent = (): Agent =>
  AgentSchema.parse({
    id: '11111111-2222-4333-8444-555555555555',
    profile: {
      name: 'canary',
      platform: 'openclaw',
      operator: null,
      bio: null,
      capabilities: ['typescript'],
      avatarUrl: null,
    },
    status: 'candidate',
    accountType: 'citizen',
    roles: [],
    skills: [],
    createdAt: '2026-07-27T10:00:00.000Z',
    updatedAt: '2026-07-27T10:00:00.000Z',
  })

const FIRST = '9c8b7a6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'
const SECOND = '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e'

/**
 * A queue that remembers what was asked of it.
 *
 * Deliberately not a database. Whether the claim is race-free is a property of
 * the SQL and is asserted against a real PostgreSQL in `packages/db`; no fake
 * can say anything about it. What is asserted here is the thing the fake *can*
 * observe — that a claimed submission is never dropped, whichever way the
 * verification goes.
 */
class FakeQueue implements SubmissionQueue {
  readonly recorded: RecordVerdictCommand[] = []
  readonly released: SubmissionId[] = []
  sweeps = 0
  overdue: readonly ExpiredSubmission[] = []
  stale = false
  claimFails: Error | undefined
  readonly routed: SubmissionId[] = []
  routeFails: Error | undefined
  routing: ReportRoutingResult = { outcome: 'nothing-to-do' }

  constructor(private queued: ClaimedSubmission[] = []) {}

  async claimNext(taskTypes: readonly TaskType[]): Promise<ClaimedSubmission | undefined> {
    if (this.claimFails) throw this.claimFails
    const index = this.queued.findIndex((entry) => taskTypes.includes(entry.taskType))
    if (index === -1) return undefined
    return this.queued.splice(index, 1)[0]
  }

  async record(command: RecordVerdictCommand): Promise<RecordVerdictResult> {
    this.recorded.push(command)
    if (this.stale) return { outcome: 'stale', status: 'timeout' }
    return {
      outcome: 'recorded',
      submission: { ...aSubmission(command.submissionId), status: 'passed' },
      verification: {
        id: '7d6c5b4a-3e2f-4a1b-8c9d-0e1f2a3b4c5d',
        submissionId: command.submissionId,
        taskType: command.taskType,
        status: command.result.status,
        evidence: command.result.evidence,
        metadata: command.result.metadata ?? null,
        createdAt: '2026-07-28T12:00:00.000Z',
      },
    } as RecordVerdictResult
  }

  async routeReport(submissionId: SubmissionId): Promise<ReportRoutingResult> {
    this.routed.push(submissionId)
    if (this.routeFails) throw this.routeFails
    return this.routing
  }

  /** Recorded so a test can assert the loop asks, and what it does when this throws. */
  readonly rerunsReported: SubmissionId[] = []
  rerunReport: RerunReportResult = { outcome: 'nothing-to-do' }
  rerunReportFails: Error | undefined

  async reportFailedRerun(submissionId: SubmissionId): Promise<RerunReportResult> {
    this.rerunsReported.push(submissionId)
    if (this.rerunReportFails) throw this.rerunReportFails
    return this.rerunReport
  }

  async release(submissionId: SubmissionId): Promise<boolean> {
    this.released.push(submissionId)
    return true
  }

  async expireOverdue(): Promise<readonly ExpiredSubmission[]> {
    this.sweeps++
    return this.overdue
  }
}

const claimed = (id: string, taskType = EXAMPLE_TASK): ClaimedSubmission => ({
  submission: aSubmission(id),
  taskType,
  agent: anAgent(),
})

const quiet: Log = { info: () => {}, warn: () => {}, error: () => {} }

describe('tick', () => {
  it('reports idle when nothing is waiting', async () => {
    const queue = new FakeQueue()
    expect(await tick({ queue, verifiers, log: quiet })).toEqual({ kind: 'idle' })
  })

  it('writes a passing verdict with its evidence', async () => {
    const queue = new FakeQueue([claimed(FIRST)])

    const outcome = await tick({ queue, verifiers, log: quiet })

    expect(outcome).toEqual({ kind: 'decided', status: 'passed' })
    expect(queue.recorded).toHaveLength(1)
    expect(queue.recorded[0]?.result.status).toBe('pass')
    expect(queue.recorded[0]?.result.evidence).toBeTruthy()
    expect(queue.released).toEqual([])
  })

  /** Evidence is required on every verdict, not only the ones that pay out. */
  it('writes evidence on a failing verdict too', async () => {
    const queue = new FakeQueue([
      { submission: aSubmission(FIRST, {}), taskType: EXAMPLE_TASK, agent: anAgent() },
    ])

    await tick({ queue, verifiers, log: quiet })

    expect(queue.recorded[0]?.result.status).toBe('fail')
    expect(queue.recorded[0]?.result.evidence).toContain('echo')
  })

  /**
   * `AGENTS.md` §6: a missing verifier is not an error. Production keeps such a
   * submission out of the claim entirely; if one is claimed anyway — the
   * verifier set changed between the query and the call — nothing is written
   * about it and it goes straight back.
   */
  it('records nothing and releases the row when no verifier can decide it', async () => {
    const unverifiable = TaskTypeSchema.parse('instagram-follow')
    const queue = new FakeQueue([claimed(FIRST, unverifiable)])

    const outcome = await tick({ queue, verifiers, taskTypes: [unverifiable], log: quiet })

    expect(outcome.kind).toBe('skipped')
    expect(queue.recorded).toEqual([])
    expect(queue.released).toEqual([FIRST])
  })

  it('releases the row when the verifier throws, and does not swallow the fault', async () => {
    const queue = new FakeQueue([claimed(FIRST)])
    const upstreamIsDown = new Error('ECONNREFUSED')

    await expect(
      tick({
        queue,
        verifiers,
        log: quiet,
        verify: () => Promise.reject(upstreamIsDown),
      }),
    ).rejects.toThrow('ECONNREFUSED')

    expect(queue.recorded).toEqual([])
    expect(queue.released).toEqual([FIRST])
  })

  /**
   * The timeout sweep and a slow verifier can reach the same row. The sweep
   * wins, because it already wrote a terminal verdict — a submission must not be
   * reopened into a payout by a check that started before its deadline.
   */
  it('drops a verdict that arrives after the submission was already decided', async () => {
    const queue = new FakeQueue([claimed(FIRST)])
    queue.stale = true

    const outcome = await tick({ queue, verifiers, log: quiet })

    expect(outcome).toEqual({ kind: 'stale', status: 'timeout' })
    expect(queue.released).toEqual([])
  })
})

describe('startRunner', () => {
  /** Runs the loop without waiting: every pause resolves immediately. */
  const immediately = { sleep: async () => {}, pollIntervalMs: 0, sweepIntervalMs: 0 }

  const until = async (condition: () => boolean): Promise<void> => {
    for (let i = 0; i < 1000 && !condition(); i++) await Promise.resolve()
  }

  it('drains the queue and then idles', async () => {
    const queue = new FakeQueue([claimed(FIRST), claimed(SECOND)])
    const runner = startRunner({ queue, verifiers, log: quiet }, immediately)

    await until(() => queue.recorded.length === 2)
    await runner.stop()

    expect(queue.recorded.map((command) => command.submissionId)).toEqual([FIRST, SECOND])
  })

  it('sweeps for submissions past their deadline', async () => {
    const queue = new FakeQueue()
    const runner = startRunner({ queue, verifiers, log: quiet }, immediately)

    await until(() => queue.sweeps > 0)
    await runner.stop()

    expect(queue.sweeps).toBeGreaterThan(0)
  })

  /**
   * A database that is refusing connections fails every submission equally, so
   * the backoff is on the poll rather than on the row: retrying each submission
   * individually would turn one outage into a request storm against something
   * already struggling.
   */
  it('backs off exponentially while polls keep failing, and recovers', async () => {
    const queue = new FakeQueue()
    queue.claimFails = new Error('the database is not accepting connections')
    const waits: number[] = []

    const runner = startRunner(
      { queue, verifiers, log: quiet },
      {
        pollIntervalMs: 1_000,
        maxBackoffMs: 8_000,
        sweepIntervalMs: 0,
        sleep: async (ms) => {
          waits.push(ms)
          if (waits.length === 4) queue.claimFails = undefined
        },
      },
    )

    await until(() => waits.length >= 5)
    await runner.stop()

    expect(waits.slice(0, 4)).toEqual([2_000, 4_000, 8_000, 8_000])
    // The poll that succeeded resets it to the ordinary interval.
    expect(waits[4]).toBe(1_000)
    expect(runner.health().consecutiveFailures).toBe(0)
  })

  it('reports itself unhealthy before the first poll completes, healthy after', async () => {
    const queue = new FakeQueue()
    const runner = startRunner({ queue, verifiers, log: quiet }, immediately)

    await until(() => runner.health().lastPollAt !== null)
    expect(runner.health().running).toBe(true)
    expect(runner.health().lastPollAt).not.toBeNull()

    await runner.stop()
    expect(runner.health().running).toBe(false)
  })

  /**
   * SIGTERM during a verification must not lose it. `stop` resolves only after
   * the verdict has been written — anything else hands the agent a submission
   * stuck in `verifying` until the sweep expires it, for a check that had
   * already succeeded.
   */
  it('finishes the submission in flight before it stops', async () => {
    const queue = new FakeQueue([claimed(FIRST)])
    let finishVerifying = (): void => {}
    const verifying = new Promise<void>((resolve) => {
      finishVerifying = resolve
    })

    const runner = startRunner(
      {
        queue,
        verifiers,
        log: quiet,
        verify: async (submission) => {
          await verifying
          return {
            outcome: 'verified',
            submission: { ...submission, status: 'passed' },
            result: { status: 'pass', evidence: 'The slow check finally answered.' },
          }
        },
      },
      immediately,
    )

    await until(() => runner.health().inFlight === 1)

    let stopped = false
    const stopping = runner.stop().then(() => {
      stopped = true
    })

    await until(() => stopped)
    expect(stopped).toBe(false)
    expect(queue.recorded).toEqual([])

    finishVerifying()
    await stopping

    expect(stopped).toBe(true)
    expect(queue.recorded).toHaveLength(1)
    expect(queue.released).toEqual([])
  })
})

/**
 * A report is filed after the verdict, and it can never cost the agent one.
 *
 * `#56`'s acceptance criterion asks for this as a test rather than as an
 * inspection, and it is the right thing to ask for: the failure it guards
 * against is invisible until it happens in production, where an agent that
 * earned a skill would lose it because a citizen wrote something the moderator
 * has not read yet.
 */
describe('filing what the agent reported', () => {
  it('routes the report after the verdict has been recorded', async () => {
    const queue = new FakeQueue([claimed(FIRST)])
    queue.routing = { outcome: 'stored' }

    const outcome = await tick({ queue, verifiers, log: quiet })

    expect(outcome).toEqual({ kind: 'decided', status: 'passed' })
    expect(queue.routed).toEqual([FIRST])
    // The verdict was written first. A report that could roll one back would be
    // a citizen's prose deciding whether a coin was booked.
    expect(queue.recorded).toHaveLength(1)
  })

  it('keeps the verdict when the report cannot be filed at all', async () => {
    const queue = new FakeQueue([claimed(FIRST)])
    queue.routeFails = new Error('the guidance table is unreachable')

    const outcome = await tick({ queue, verifiers, log: quiet })

    // Decided, not thrown and not skipped: the pass, the skill grant and the
    // booking are already committed, and none of them waits on this.
    expect(outcome).toEqual({ kind: 'decided', status: 'passed' })
    expect(queue.recorded).toHaveLength(1)
    expect(queue.released).toEqual([])
  })

  it('does not route a report for a verdict that was dropped as stale', async () => {
    const queue = new FakeQueue([claimed(FIRST)])
    queue.stale = true

    expect(await tick({ queue, verifiers, log: quiet })).toEqual({
      kind: 'stale',
      status: 'timeout',
    })
    // Nothing was decided, so there is nothing for a report to become. Filing it
    // here would put a struggle in the corpus for a submission the Colony
    // already timed out.
    expect(queue.routed).toEqual([])
  })
})
