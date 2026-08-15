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
import { deferralFor, startRunner, tick, type Deferral, type Log } from './loop.js'
import type {
  ClaimedSubmission,
  DeferralReportResult,
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
    evidence: null,
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
      pronouns: null,
      model: null,
      runtimeVersion: null,
      os: null,
      skillVersion: null,
      bio: null,
      capabilities: ['typescript'],
      avatarUrl: null,
      declaredRhythmHours: null,
      vocation: null,
      disposition: null,
      goal: null,
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
  /** The author erased itself between the claim and the write (#93). */
  vanished = false
  claimFails: Error | undefined
  readonly routed: SubmissionId[] = []
  routeFails: Error | undefined
  routing: ReportRoutingResult = { outcome: 'nothing-to-do' }
  /** What `record` says the submission's status became. Production returns
   *  `pending` when the outside world could not be read (#132). */
  recordedStatus: 'passed' | 'failed' | 'pending' | undefined

  constructor(private queued: ClaimedSubmission[] = []) {}

  /** Every exclusion list the loop has asked with, in order (#132). */
  readonly deferredAsked: (readonly SubmissionId[])[] = []
  /** Submissions that go back on the queue after being claimed, as production does. */
  requeue = false

  async claimNext(
    taskTypes: readonly TaskType[],
    deferred: readonly SubmissionId[] = [],
  ): Promise<ClaimedSubmission | undefined> {
    if (this.claimFails) throw this.claimFails
    this.deferredAsked.push([...deferred])
    // Honouring the exclusion is the whole point: a fake that ignored it would
    // let the head-of-line test below pass while production still blocked.
    const index = this.queued.findIndex(
      (entry) => taskTypes.includes(entry.taskType) && !deferred.includes(entry.submission.id),
    )
    if (index === -1) return undefined
    const [claimed] = this.queued.splice(index, 1)
    if (this.requeue && claimed) this.queued.push(claimed)
    return claimed
  }

  async record(command: RecordVerdictCommand): Promise<RecordVerdictResult> {
    this.recorded.push(command)
    if (this.vanished) return { outcome: 'vanished' }
    if (this.stale) return { outcome: 'stale', status: 'timeout' }
    return {
      outcome: 'recorded',
      submission: {
        ...aSubmission(command.submissionId),
        status: this.recordedStatus ?? 'passed',
      },
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

  /**
   * The durable deferral count (#254), which the fake keeps per submission so a
   * test can assert the loop reads it back rather than counting in its own map.
   */
  readonly deferralCounts = new Map<SubmissionId, number>()
  readonly deferralsReported: SubmissionId[] = []
  deferralReport: DeferralReportResult = { outcome: 'nothing-to-do' }
  deferralReportFails: Error | undefined

  async defer(submissionId: SubmissionId): Promise<number> {
    const next = (this.deferralCounts.get(submissionId) ?? 0) + 1
    this.deferralCounts.set(submissionId, next)
    return next
  }

  async reportRepeatedDeferral(submissionId: SubmissionId): Promise<DeferralReportResult> {
    this.deferralsReported.push(submissionId)
    if (this.deferralReportFails) throw this.deferralReportFails
    return this.deferralReport
  }

  async release(submissionId: SubmissionId): Promise<boolean> {
    this.released.push(submissionId)
    return true
  }

  async expireOverdue(): Promise<readonly ExpiredSubmission[]> {
    this.sweeps++
    return this.overdue
  }

  /**
   * Counted rather than stubbed away, so a sweep that stops running is visible
   * here (#108). It rides the same tick as `expireOverdue` and the loop must
   * keep working when it finds nothing, which is the ordinary case.
   */
  abandonedSweeps = 0

  async sweepAbandoned(): Promise<number> {
    this.abandonedSweeps++
    return 0
  }

  /** Counted for the same reason as `abandonedSweeps` above (`#592`). */
  handoverSweeps = 0

  async destroyExpiredHandovers(): Promise<number> {
    this.handoverSweeps++
    return 0
  }

  /** Counted for the same reason as `abandonedSweeps` above (`#955`). */
  dropSweeps = 0

  async destroyExpiredDrops(): Promise<number> {
    this.dropSweeps++
    return 0
  }

  /** Counted for the same reason as `abandonedSweeps` above (`#955`). */
  slotSweeps = 0

  async destroyExpiredSlots(): Promise<number> {
    this.slotSweeps++
    return 0
  }

  /** Counted for the same reason as `abandonedSweeps` above (#141). */
  contactPrunes = 0

  async pruneContacts(): Promise<number> {
    this.contactPrunes++
    return 0
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

  /**
   * The line kolonie-docs' Watch Agent needs (`#230`). Without it, *the runner
   * ran and had nothing to do* and *the runner is dead* produce identical
   * output — nothing — and error monitoring structurally cannot tell them
   * apart, because neither is an error.
   */
  it('says a cycle completed even when it handled nothing', async () => {
    const lines: { message: string; fields?: Record<string, unknown> }[] = []
    const recording: Log = {
      info: (message, fields) => lines.push({ message, ...(fields ? { fields } : {}) }),
      warn: () => {},
      error: () => {},
    }
    const queue = new FakeQueue()
    const runner = startRunner({ queue, verifiers, log: recording }, immediately)

    await until(() => lines.some((line) => line.fields?.['event'] === 'poll.done'))
    await runner.stop()

    const done = lines.find((line) => line.fields?.['event'] === 'poll.done')
    expect(done?.fields).toMatchObject({ event: 'poll.done', handled: 0 })
  })

  it('sweeps for submissions past their deadline', async () => {
    const queue = new FakeQueue()
    const runner = startRunner({ queue, verifiers, log: quiet }, immediately)

    await until(() => queue.sweeps > 0)
    await runner.stop()

    expect(queue.sweeps).toBeGreaterThan(0)
  })

  /**
   * The housekeeping that rides the same tick, asserted together.
   *
   * The counters above have said since `#108` that "a sweep that stops running
   * is visible here", and until this test nothing read them: `destroyExpiredSlots`
   * was written with the slot channel and wired to nothing at all, which no red
   * test anywhere reported. A sweep is the one kind of work whose absence looks
   * exactly like its success, so the assertion has to be that it was called.
   */
  it('runs every housekeeping sweep on the same tick', async () => {
    const queue = new FakeQueue()
    const runner = startRunner({ queue, verifiers, log: quiet }, immediately)

    await until(() => queue.contactPrunes > 0)
    await runner.stop()

    expect(queue.abandonedSweeps).toBeGreaterThan(0)
    expect(queue.handoverSweeps).toBeGreaterThan(0)
    expect(queue.dropSweeps).toBeGreaterThan(0)
    expect(queue.slotSweeps).toBeGreaterThan(0)
    expect(queue.contactPrunes).toBeGreaterThan(0)
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

/**
 * A citizen may erase itself with a submission in flight — `erasure.md` §1: the
 * right does not depend on standing, and certainly not on having no work
 * outstanding (#93).
 *
 * The submission goes with the account, so by the time the verifier finishes
 * thinking there is no row to write a verdict on. **This used to throw**, on a
 * comment that read *"which nothing in the Colony does"* — true until #93.
 */
describe('a submission whose author erased itself', () => {
  it('is dropped without throwing, and the runner takes the next one', async () => {
    const queue = new FakeQueue([claimed(FIRST)])
    queue.vanished = true

    const outcome = await tick({ queue, verifiers, log: quiet })

    expect(outcome).toEqual({ kind: 'vanished' })
    // Nothing was released back to the queue: there is no row to release.
    expect(queue.released).toEqual([])
  })

  it('does not route a report for a citizen that is gone', async () => {
    const queue = new FakeQueue([claimed(FIRST)])
    queue.vanished = true

    await tick({ queue, verifiers, log: quiet })

    expect(queue.routed).toEqual([])
  })
})

describe('a submission the world cannot answer for (#132)', () => {
  /**
   * The production failure, reproduced. On 2026-07-31 one `image-gen`
   * submission came back `pending` — the vision model could not be reached —
   * and `claimNextSubmission` orders by `submitted_at`, which a `pending`
   * verdict does not touch. So it was permanently the oldest row, was claimed
   * first on every poll, and **nothing behind it was verified** for at least
   * half an hour while the runner flapped between healthy and unhealthy.
   */
  const stuck = (): FakeQueue => {
    const queue = new FakeQueue([
      {
        submission: aSubmission('aaaaaaaa-1111-4111-8111-111111111111'),
        taskType: EXAMPLE_TASK,
        agent: anAgent(),
      },
      {
        submission: aSubmission('bbbbbbbb-2222-4222-8222-222222222222'),
        taskType: EXAMPLE_TASK,
        agent: anAgent(),
      },
    ])
    queue.recordedStatus = 'pending'
    queue.requeue = true
    return queue
  }

  it('does not hold the queue behind it', async () => {
    const queue = stuck()
    const deferrals = new Map<SubmissionId, Deferral>()

    const first = await tick({ queue, verifiers, deferrals })
    expect(first).toEqual({ kind: 'decided', status: 'pending' })

    // The second poll must reach the *other* submission. Before #132 it claimed
    // the same one again, and again, forever.
    const second = await tick({ queue, verifiers, deferrals })
    expect(second).toEqual({ kind: 'decided', status: 'pending' })

    const claimed = queue.recorded.map((command) => command.submissionId)
    expect(new Set(claimed).size).toBe(2)
  })

  it('asks the queue to skip what it is standing back from', async () => {
    const queue = stuck()
    const deferrals = new Map<SubmissionId, Deferral>()

    await tick({ queue, verifiers, deferrals })
    await tick({ queue, verifiers, deferrals })

    // Not merely that the loop remembered — that it *told the query*, which is
    // where the ordering lives and the only place the block can be broken.
    expect(queue.deferredAsked[0]).toEqual([])
    expect(queue.deferredAsked[1]).toHaveLength(1)
  })

  it('backs off further each time, and stops at a ceiling', async () => {
    // A submission unverifiable for two hours is not helped by a two-hundredth
    // attempt; a queue that never came back to it would be a silent refusal.
    expect(deferralFor(1)).toBe(30_000)
    expect(deferralFor(2)).toBe(60_000)
    expect(deferralFor(3)).toBe(120_000)
    expect(deferralFor(99)).toBe(900_000)
    // A count of zero must not produce a longer wait than a count of one.
    expect(deferralFor(0)).toBe(30_000)
  })

  it('stands back from the Colony’s own queue at the queue’s speed', async () => {
    /**
     * `#434`. Thirty seconds is the right first wait for an outward call and the
     * wrong one for a stage of ours that takes three minutes: a quest report
     * that was second in the moderation queue collected four deferrals in 213
     * seconds and filed a defect ticket about the Colony, for a scrub that
     * arrived 56 seconds later.
     */
    expect(deferralFor(1, true)).toBe(180_000)
    expect(deferralFor(2, true)).toBe(360_000)
    expect(deferralFor(3, true)).toBe(720_000)
    // Cumulative to the fourth deferral — where `DEFERRALS_BEFORE_TICKET` files
    // — is 21 minutes rather than 213 seconds.
    expect(deferralFor(1, true) + deferralFor(2, true) + deferralFor(3, true)).toBe(1_260_000)
    // The existing ceiling still binds, so a genuinely stopped stage does not
    // escalate into hours of silence.
    expect(deferralFor(9, true)).toBe(900_000)
    // And nothing changed for everything else.
    expect(deferralFor(3, false)).toBe(deferralFor(3))
  })

  it('reads the marker off the verdict rather than off the sentence', async () => {
    /**
     * The half that made `#434` possible: the intent already existed in
     * `quest-report.ts`'s test — *"the moderator queue is expected latency and
     * not a fault, so this pending must not invite a ticket"* — and could not
     * reach here, because a runner sees a status and a string. So it clocked our
     * own queue as an outward call. This asserts the marker crosses the gap.
     */
    const queued: Verifier = {
      taskType: EXAMPLE_TASK,
      verify: async () => ({
        status: 'pending',
        evidence: 'Your report is with the Colony’s moderator and has not been judged yet.',
        metadata: { queuedInColony: true },
      }),
    }
    const queue = stuck()
    queue.recordedStatus = 'pending'
    const deferrals = new Map<SubmissionId, Deferral>()
    const before = Date.now()

    await tick({ queue, verifiers: new Map([[queued.taskType, queued]]), deferrals })

    const [entry] = [...deferrals.values()]
    expect(entry).toBeDefined()
    // Three minutes, not thirty seconds. Asserted as a lower bound against the
    // clock so the test says what it means rather than restating the constant.
    expect(entry!.until - before).toBeGreaterThanOrEqual(180_000)
  })

  it('schedules a declared healthy wait without counting or reporting a deferral', async () => {
    const retryAt = Date.now() + 3_600_000
    const waiting: Verifier = {
      taskType: EXAMPLE_TASK,
      verify: async () => ({
        status: 'pending',
        evidence: 'The second probe has not opened yet.',
        metadata: { expectedWaitUntil: new Date(retryAt).toISOString() },
      }),
    }
    const queue = stuck()
    const deferrals = new Map<SubmissionId, Deferral>()

    await tick({ queue, verifiers: new Map([[waiting.taskType, waiting]]), deferrals })

    expect(queue.deferralCounts.size).toBe(0)
    expect(queue.deferralsReported).toEqual([])
    expect(deferrals.get('aaaaaaaa-1111-4111-8111-111111111111' as SubmissionId)).toEqual({
      until: retryAt,
      count: 0,
    })
  })

  it('comes back to it once the wait is over', async () => {
    const queue = stuck()
    const id = 'aaaaaaaa-1111-4111-8111-111111111111' as SubmissionId
    // Expired by the time this tick runs.
    const deferrals = new Map<SubmissionId, Deferral>([[id, { until: Date.now() - 1, count: 3 }]])
    // The count's authority is the row, not the map (#254).
    queue.deferralCounts.set(id, 3)

    await tick({ queue, verifiers, deferrals })

    expect(queue.deferredAsked[0]).toEqual([])
    // And the wait grows from where it left off rather than restarting at 30s.
    expect(deferrals.get(id)?.count).toBe(4)
  })

  /**
   * `#254`. The count is what decides that a verifier's trouble has stopped
   * being a blip, and before this it lived in this process's memory — so a
   * redeploy reset it and the decision could never be reached. The `until` is
   * still allowed to be forgotten: that costs one immediate retry.
   */
  it('keeps counting across a restart that empties the map', async () => {
    // One submission only, so all three ticks provably claim the same row —
    // with two in the queue the fake rotates and the count would be split.
    const id = 'aaaaaaaa-1111-4111-8111-111111111111' as SubmissionId
    const queue = new FakeQueue([
      { submission: aSubmission(id), taskType: EXAMPLE_TASK, agent: anAgent() },
    ])
    queue.recordedStatus = 'pending'
    queue.requeue = true

    await tick({ queue, verifiers, deferrals: new Map() })
    await tick({ queue, verifiers, deferrals: new Map() })

    // A fresh map each time is the redeploy. The row remembers anyway.
    const after = new Map<SubmissionId, Deferral>()
    await tick({ queue, verifiers, deferrals: after })

    expect(after.get(id)?.count).toBe(3)
  })

  it('asks for a ticket after recording the deferral, and says so once filed', async () => {
    const queue = stuck()
    const id = 'aaaaaaaa-1111-4111-8111-111111111111' as SubmissionId
    queue.deferralReport = { outcome: 'reported', ticketId: 'ticket-1' }
    const lines: string[] = []
    const log: Log = { info: () => {}, warn: (m) => lines.push(m), error: () => {} }

    await tick({ queue, verifiers, deferrals: new Map(), log })

    expect(queue.deferralsReported).toEqual([id])
    expect(lines.join('\n')).toContain('ticket-1')
  })

  /**
   * The property `reportFailedRerun` states and this one inherits: **a
   * submission's place in the queue can never be lost to a ticket.** The
   * deferral is recorded first and the ticket's failure is swallowed, so a
   * broken support table cannot turn a deferral into a head-of-line block.
   */
  it('still defers the submission when the ticket cannot be filed', async () => {
    const queue = stuck()
    const id = 'aaaaaaaa-1111-4111-8111-111111111111' as SubmissionId
    queue.deferralReportFails = new Error('support_tickets is unhappy')
    const errors: string[] = []
    const deferrals = new Map<SubmissionId, Deferral>()

    const outcome = await tick({
      queue,
      verifiers,
      deferrals,
      log: { info: () => {}, warn: () => {}, error: (m) => errors.push(m) },
    })

    expect(outcome).toEqual({ kind: 'decided', status: 'pending' })
    expect(deferrals.get(id)?.count).toBe(1)
    expect(errors.join('\n')).toContain('could not file the repeated deferral')
  })

  it('says why, which the old line never did', async () => {
    const queue = stuck()
    const lines: string[] = []
    const log: Log = { info: () => {}, warn: (m) => lines.push(m), error: () => {} }

    await tick({ queue, verifiers, deferrals: new Map(), log })

    // Half an hour of production logs said `→ pending (image-gen)` fifteen times
    // and named no cause, while the reason sat in the submission's evidence.
    expect(lines.join('\n')).toContain('attempt 1')
    expect(lines.join('\n')).toContain('not retried for 30s')
    expect(lines.join('\n')).toContain('Echoed.')
  })

  it('forgets a submission that finally resolves', async () => {
    // One submission only, so the second tick provably claims *this* one — with
    // two in the queue it picks the other, and the assertion below would then
    // be reporting that the loop failed to forget something it never re-saw.
    const id = 'aaaaaaaa-1111-4111-8111-111111111111'
    const queue = new FakeQueue([
      { submission: aSubmission(id), taskType: EXAMPLE_TASK, agent: anAgent() },
    ])
    queue.recordedStatus = 'pending'
    queue.requeue = true
    const deferrals = new Map<SubmissionId, Deferral>()

    await tick({ queue, verifiers, deferrals })
    expect(deferrals.has(id as SubmissionId)).toBe(true)

    // Its wait is over, and this time the world answers.
    deferrals.set(id as SubmissionId, { until: Date.now() - 1, count: 1 })
    queue.recordedStatus = 'passed'
    queue.requeue = false

    await tick({ queue, verifiers, deferrals })
    expect(queue.recorded).toHaveLength(2)
    expect(deferrals.has(id as SubmissionId)).toBe(false)
  })
})
