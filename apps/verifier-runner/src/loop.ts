import { now as currentTime, type TaskType, type Timestamp } from '@kolonie-ai/core'
import { createVerifiers, type VerifierRegistry } from '@kolonie-ai/verifiers'
import { verifySubmission } from './runner.js'
import type { SubmissionQueue } from './queue.js'

/** What one submission's turn through the loop came to. */
export type TickOutcome =
  /** Verified and written: the verdict is on the record. */
  | { readonly kind: 'decided'; readonly status: string }
  /** No verifier could decide it. The row went back, untouched. */
  | { readonly kind: 'skipped'; readonly reason: string }
  /** Another writer had already decided it — see `RecordVerdictResult`. */
  | { readonly kind: 'stale'; readonly status: string }
  /** Nothing was waiting. */
  | { readonly kind: 'idle' }

/** Where the loop writes what it did. Injected so tests are not noisy. */
export interface Log {
  info(message: string): void
  warn(message: string): void
  error(message: string, error: unknown): void
}

export interface LoopDependencies {
  readonly queue: SubmissionQueue
  /**
   * The verifier modules this process was wired with.
   *
   * Defaults to the self-contained ones. `main.ts` supplies the full set,
   * including the ones that read the outside world — which is why this is a
   * dependency rather than an import: the registry a process has is a fact about
   * how it was started, not about what the package can build.
   */
  readonly verifiers?: VerifierRegistry
  /**
   * The task types this process can verify. Defaults to whatever `verifiers`
   * holds, which is the only correct answer in production; tests pass their own.
   */
  readonly taskTypes?: readonly TaskType[]
  /** The pure decision function. Injectable so a test can make it throw or hang. */
  readonly verify?: typeof verifySubmission
  readonly log?: Log
  readonly now?: () => Timestamp
}

/**
 * Take one submission through the loop: claim, verify, write.
 *
 * The three verbs are the whole design. The loop reads, calls, and writes; it
 * does not decide. Everything that decides anything lives in `verifySubmission`,
 * which is pure and tested without a database — and the reason to keep it that
 * way is that this is the code path that ends in coins being booked.
 *
 * **A claimed submission is never dropped.** Every path out of here either
 * writes a verdict or puts the row back: a skip releases it, a thrown verifier
 * releases it and rethrows. The one case that cannot be handled in process — the
 * process dying between the claim and the write — is what the timeout sweep in
 * `expireOverdue` catches.
 */
export async function tick(deps: LoopDependencies): Promise<TickOutcome> {
  const { queue, log = silentLog } = deps
  const verifiers = deps.verifiers ?? createVerifiers()
  const verify =
    deps.verify ??
    ((submission, taskType, context) => verifySubmission(submission, taskType, context, verifiers))
  const taskTypes = deps.taskTypes ?? [...verifiers.keys()]

  const claimed = await queue.claimNext(taskTypes)
  if (claimed === undefined) return { kind: 'idle' }

  const { submission, taskType, agent } = claimed

  let verdict
  try {
    verdict = await verify(submission, taskType, { agent })
  } catch (error) {
    // A verifier that throws has told us nothing about the agent, so nothing is
    // written about the agent. The row goes back to `pending` and the next poll
    // tries again; if the fault is permanent, the task's own deadline ends it.
    await releaseQuietly(deps, claimed.submission.id, log)
    throw error
  }

  if (verdict.outcome === 'skipped') {
    // Not a failure, and not a verdict: nothing is recorded. `AGENTS.md` §6 — a
    // verifier deployed late must never fail submissions that were correct.
    log.warn(`submission ${submission.id} left pending: ${verdict.reason}`)
    await queue.release(submission.id)
    return { kind: 'skipped', reason: verdict.reason }
  }

  const written = await queue.record({
    submissionId: submission.id,
    taskType,
    result: verdict.result,
    now: deps.now?.(),
  })

  if (written.outcome === 'stale') {
    log.warn(
      `submission ${submission.id} was already '${written.status}' when its verdict arrived; ` +
        `the verdict was dropped rather than reopening a decided submission.`,
    )
    return { kind: 'stale', status: written.status }
  }

  // What the pass cost the mint, in the same line as the verdict. An operator
  // reading these is answering "did the Colony pay for this", and a booking
  // recorded nowhere but the ledger makes that a query rather than a glance.
  const booked =
    written.booking === undefined
      ? ''
      : ` — booked ${written.booking.coins} coin(s) and ${written.booking.reputation} reputation, ` +
        `agent now at level ${written.booking.level}`

  log.info(`submission ${submission.id} → ${written.submission.status} (${taskType})${booked}`)
  return { kind: 'decided', status: written.submission.status }
}

/** What the health surface is allowed to know about the loop. */
export interface RunnerHealth {
  /** False before `start` and after `stop` — the process can be up either way. */
  readonly running: boolean
  /** When a poll last completed without throwing. Null until the first one does. */
  readonly lastPollAt: Timestamp | null
  /** Consecutive polls that threw. Reset by any poll that does not. */
  readonly consecutiveFailures: number
  /** Submissions currently being verified. Zero or one, today. */
  readonly inFlight: number
  readonly taskTypes: readonly TaskType[]
}

export interface RunnerOptions {
  /** How long to wait after a poll that found nothing. */
  readonly pollIntervalMs?: number
  /** Ceiling for the exponential backoff after consecutive failures. */
  readonly maxBackoffMs?: number
  /** Submissions to take in one pass before pausing. Bounds one poll's work. */
  readonly batchSize?: number
  /** How often to look for submissions past their deadline. */
  readonly sweepIntervalMs?: number
  /** Injectable so tests need no real time. */
  readonly sleep?: (ms: number) => Promise<void>
}

export interface Runner {
  /** Resolves when the loop has stopped. Rejects only if the loop itself is broken. */
  readonly finished: Promise<void>
  /** Ask the loop to stop, and wait for the submission in flight to be written. */
  stop(): Promise<void>
  health(): RunnerHealth
}

const DEFAULTS = {
  pollIntervalMs: 5_000,
  maxBackoffMs: 300_000,
  batchSize: 20,
  sweepIntervalMs: 60_000,
} as const

const silentLog: Log = { info: () => {}, warn: () => {}, error: () => {} }

/**
 * Run the loop until stopped.
 *
 * **Backoff is on the poll, not on the submission.** A database that is down or
 * a verifier whose upstream is refusing connections fails every submission
 * equally, and retrying each of them individually turns one outage into a
 * request storm against whatever is already struggling. So consecutive failures
 * slow the whole loop down, exponentially, up to `maxBackoffMs` — and any poll
 * that succeeds puts it straight back to normal speed.
 *
 * **Stopping waits for the write.** A SIGTERM during a verification does not
 * abandon it: `stop` sets the flag and awaits the pass that is in flight, so the
 * verdict is recorded before the process exits. Docker's ten-second grace period
 * is the bound, and past it the row is left `verifying` for the timeout sweep —
 * which is why the sweep exists.
 */
export function startRunner(deps: LoopDependencies, options: RunnerOptions = {}): Runner {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULTS.pollIntervalMs
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULTS.maxBackoffMs
  const batchSize = options.batchSize ?? DEFAULTS.batchSize
  const sweepIntervalMs = options.sweepIntervalMs ?? DEFAULTS.sweepIntervalMs
  const sleep = options.sleep ?? realSleep
  const log = deps.log ?? silentLog
  const clock = deps.now ?? currentTime
  const taskTypes = deps.taskTypes ?? [...(deps.verifiers ?? createVerifiers()).keys()]

  let running = true
  let lastPollAt: Timestamp | null = null
  let consecutiveFailures = 0
  let inFlight = 0
  let lastSweepAt = 0
  let wake: (() => void) | undefined

  /**
   * Wait, but stop waiting the moment someone asks the loop to stop.
   *
   * Without the race, a SIGTERM arriving one millisecond into a five-second
   * pause would sit out the remaining pause before the process could exit — and
   * during a rollback that is five seconds of a container that has been told to
   * go and has not gone. The backoff after an outage makes it worse: at the
   * ceiling it would be five minutes.
   */
  const pause = async (ms: number): Promise<void> => {
    await Promise.race([
      sleep(ms),
      new Promise<void>((resolve) => {
        wake = resolve
      }),
    ])
    wake = undefined
  }

  const finished = (async () => {
    while (running) {
      try {
        if (Date.now() - lastSweepAt >= sweepIntervalMs) {
          lastSweepAt = Date.now()
          for (const expired of await deps.queue.expireOverdue()) {
            log.warn(
              `submission ${expired.submissionId} timed out from '${expired.previousStatus}'`,
            )
          }
        }

        let taken = 0
        while (running && taken < batchSize) {
          inFlight++
          try {
            const outcome = await tick({ ...deps, taskTypes })
            if (outcome.kind === 'idle') break
          } finally {
            inFlight--
          }
          taken++
        }

        lastPollAt = clock()
        consecutiveFailures = 0
        if (running) await pause(pollIntervalMs)
      } catch (error) {
        consecutiveFailures++
        const wait = Math.min(pollIntervalMs * 2 ** consecutiveFailures, maxBackoffMs)
        log.error(
          `poll failed (${consecutiveFailures} in a row); retrying in ${Math.round(wait / 1000)}s`,
          error,
        )
        if (running) await pause(wait)
      }
    }
  })()

  return {
    finished,
    async stop() {
      running = false
      // Cut short whatever pause is in progress; a verification already in
      // flight is still awaited, because `finished` only resolves after it.
      wake?.()
      await finished
    },
    health: () => ({
      running,
      lastPollAt,
      consecutiveFailures,
      inFlight,
      taskTypes,
    }),
  }
}

/** Release a claimed submission without letting that failure mask the original. */
async function releaseQuietly(
  deps: LoopDependencies,
  submissionId: Parameters<SubmissionQueue['release']>[0],
  log: Log,
): Promise<void> {
  try {
    await deps.queue.release(submissionId)
  } catch (error) {
    log.error(`could not return submission ${submissionId} to the queue`, error)
  }
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    // `unref` so a pending poll interval never keeps a stopping process alive.
    setTimeout(resolve, ms).unref()
  })
