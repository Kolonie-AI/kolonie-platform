import {
  now as currentTime,
  silentLog,
  type Log,
  type SubmissionId,
  type TaskType,
  type Timestamp,
} from '@kolonie-ai/core'
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
  /**
   * The submission's author erased itself while the verifier was thinking, so
   * the row went with the account (#93). Nothing to write and nobody to tell.
   */
  | { readonly kind: 'vanished' }
  /** Nothing was waiting. */
  | { readonly kind: 'idle' }

/**
 * Where the loop writes what it did. Injected so tests are not noisy.
 *
 * One interface for all four processes since `#230`, defined in `packages/core`
 * — three copies of a logging interface produced three log formats, and a
 * format nothing else shares is one nothing can query.
 */
export type { Log }

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
  /**
   * Submissions this process is backing off from, and until when (#132).
   *
   * Held by the caller rather than inside `tick`, because `tick` is one pass and
   * the whole point is that the next pass remembers. `startRunner` creates one
   * and passes it to every tick; a test can pass its own and read it.
   *
   * **The wait is in memory and the count is not, since #254.** A restart
   * forgets the `until`, so a stuck submission is retried once more and then
   * backed off again — correct behaviour, and cheap. The `count` was in memory
   * too, and that was the defect: it is what decides *this has stopped being a
   * blip*, so a redeploy resetting it meant the decision could never be reached.
   * It now lives on `submissions.deferrals` and this map carries a copy.
   */
  readonly deferrals?: Map<SubmissionId, Deferral>
}

/** What is known about one submission the loop is standing back from. */
export interface Deferral {
  /** Epoch milliseconds before which it is not claimed again. */
  readonly until: number
  /**
   * How many times in a row it has come back `pending`.
   *
   * **Read back from the row rather than counted here** since #254, so this is
   * a copy for the backoff arithmetic and no longer the authority. What it is
   * still used for is the escalation: an entry kept past its wait is what makes
   * the doubling happen, and deleting it on expiry would hand a stuck
   * submission a fresh thirty seconds forever.
   */
  readonly count: number
}

/**
 * How long to stand back after a verdict of `pending`, by consecutive count.
 *
 * Doubling from thirty seconds to a fifteen-minute ceiling. The floor is six
 * poll intervals, so a transient outward failure costs an agent half a minute
 * rather than a poll; the ceiling exists because a submission that has been
 * unverifiable for two hours will not be helped by asking a two-hundredth time,
 * and because a queue must still come back to it — a permanent skip would be a
 * silent refusal, and the task's own deadline is what is allowed to end this.
 */
const DEFER_BASE_MS = 30_000
const DEFER_CEILING_MS = 900_000

/**
 * How long after its wait expires a submission is still remembered.
 *
 * Only to bound the map in a process that runs for weeks: an entry whose
 * submission the deadline sweep has since expired is never claimed again and
 * would otherwise stay forever. Comfortably longer than the ceiling, so a
 * genuinely stuck submission keeps escalating rather than being handed a fresh
 * thirty seconds every hour.
 */
const DEFER_FORGET_MS = 3_600_000

export function deferralFor(count: number): number {
  return Math.min(DEFER_BASE_MS * 2 ** Math.max(0, count - 1), DEFER_CEILING_MS)
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

  // What is still inside its wait, and therefore not asked for.
  //
  // **An expired entry is kept, not deleted**, and that distinction is the
  // escalation. Deleting it on expiry — the obvious reading of "prune" — throws
  // away the count, so a submission that is stuck for hours comes back at
  // thirty seconds every single time and the doubling never happens. A test
  // caught that; nothing in production would have, because the symptom is a
  // backoff that looks like it is working.
  //
  // Entries are dropped when the submission resolves, and swept here only once
  // they are far past their wait — a submission the deadline sweep has since
  // expired would otherwise sit in this map for the life of the process.
  const deferrals = deps.deferrals
  let deferred: SubmissionId[] = []
  if (deferrals !== undefined) {
    const nowMs = Date.now()
    for (const [id, entry] of deferrals) {
      if (nowMs - entry.until > DEFER_FORGET_MS) deferrals.delete(id)
    }
    deferred = [...deferrals].filter(([, entry]) => entry.until > nowMs).map(([id]) => id)
  }

  const claimed = await queue.claimNext(taskTypes, deferred)
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
    log.warn(`submission ${submission.id} left pending: ${verdict.reason}`, {
      event: 'submission.left-pending',
      submissionId: submission.id,
    })
    await queue.release(submission.id)
    return { kind: 'skipped', reason: verdict.reason }
  }

  const written = await queue.record({
    submissionId: submission.id,
    taskType,
    result: verdict.result,
    now: deps.now?.(),
  })

  if (written.outcome === 'vanished') {
    /**
     * The author erased itself while this verifier was thinking (#93). The
     * submission went with the account, so there is no row to write a verdict
     * on, no balance to pay it into and nobody left to tell.
     *
     * Logged at `info` rather than `warn`: nothing went wrong. A citizen used
     * the right in `GOVERNANCE.md`, and it does not depend on having no work
     * outstanding.
     */
    log.info(
      `submission ${submission.id} vanished mid-verification: its author erased itself. ` +
        'The verdict was dropped.',
      { event: 'submission.vanished', submissionId: submission.id },
    )
    return { kind: 'vanished' }
  }

  if (written.outcome === 'stale') {
    log.warn(
      `submission ${submission.id} was already '${written.status}' when its verdict arrived; ` +
        `the verdict was dropped rather than reopening a decided submission.`,
      { event: 'submission.stale', submissionId: submission.id, status: written.status },
    )
    return { kind: 'stale', status: written.status }
  }

  // What the pass cost the mint, in the same line as the verdict. An operator
  // reading these is answering "did the Colony pay for this", and a booking
  // recorded nowhere but the ledger makes that a query rather than a glance.
  const booked =
    written.booking === undefined
      ? ''
      : ` — booked ${written.booking.credits} coin(s) and ${written.booking.reputation} reputation` +
        // What the pass *opened*, which is the half an operator cannot infer
        // from the ledger. A badge grants nothing and says so, rather than
        // looking like a grant that failed.
        (written.booking.grantedSkills.length === 0
          ? ', granting no new skill'
          : `, granting ${written.booking.grantedSkills.join(', ')}`) +
        // A role is rarer than a skill and means more — one rung in the whole
        // Academy awards one (`#88`) — so it is named when it happens and silent
        // when it does not, rather than adding "no new role" to every line.
        (written.booking.grantedRoles.length === 0
          ? ''
          : ` and the role ${written.booking.grantedRoles.join(', ')}`)

  /**
   * What the agent said it learned, filed now that the verdict has decided what
   * it is: a tip on a pass, a struggle on a failure (#56).
   *
   * **After the verdict, and its failure is swallowed here.** That is the whole
   * of *"nothing about a report can make a submission fail verification"*: the
   * verdict, the skill grant and the ledger booking are already written and
   * committed by the time this runs, so a citizen's text cannot cost an agent
   * the pass it earned. A report that fails to file is logged and retried on the
   * next pass over the row, because the stored outcome is what marks it done.
   */
  try {
    const routed = await queue.routeReport(submission.id)
    if (routed.outcome !== 'nothing-to-do') {
      log.info(`submission ${submission.id} report ${routed.outcome}`, {
        event: 'report.routed',
        submissionId: submission.id,
        outcome: routed.outcome,
      })
    }
  } catch (error) {
    log.error(`could not file the report on submission ${submission.id}`, error, {
      event: 'report.route.failed',
      submissionId: submission.id,
    })
  }

  /**
   * A test re-run that failed becomes a ticket (#47).
   *
   * **Here, for the same three reasons the report above is here**: after the verdict
   * is committed, unconditionally, and with its failure swallowed. A tester's finding
   * must never be able to cost a submission its verdict, and *is this a failed
   * re-run* is a question the row answers — asking it in this loop as well would put
   * the same condition in two places that could disagree.
   *
   * `kolonie-docs#17`: *"a re-run that quietly fails is worse than no re-runs."* A
   * log line is not surfacing it — this container's logs do not survive a redeploy,
   * and nobody reads them on the day it mattered.
   */
  try {
    const reported = await queue.reportFailedRerun(submission.id)
    if (reported.outcome === 'reported') {
      log.info(`failed re-test of ${taskType} filed as ticket ${reported.ticketId}`, {
        event: 'retest.filed',
        submissionId: submission.id,
        taskType,
        ticketId: reported.ticketId,
      })
    }
  } catch (error) {
    log.error(`could not file the failed re-test of submission ${submission.id}`, error, {
      event: 'retest.file.failed',
      submissionId: submission.id,
    })
  }

  if (written.submission.status === 'pending') {
    /**
     * The world could not be read, so the row goes back to the queue — and
     * without this it goes back to the *front* of it, forever (#132).
     *
     * **The count comes from the row and the wait stays here** (#254). It used
     * to be `previous + 1` off the map, and a redeploy therefore reset it: half
     * an hour of production flapping left nothing durable behind, and the Colony
     * learned about it because a human read a log. The `until` is still in
     * memory on purpose — forgetting a wait costs one immediate retry, and
     * forgetting the count costs the only evidence that this is not a blip.
     */
    const count = await queue.defer(submission.id)
    const wait = deferralFor(count)
    deferrals?.set(submission.id, { until: Date.now() + wait, count })

    /**
     * A verifier that keeps failing for our own reasons becomes a ticket, with
     * nobody having to think of it (#254).
     *
     * **After the deferral is recorded, and its failure swallowed** — the same
     * three properties as the report and the failed re-run above, for the same
     * reason: a submission's place in the queue can never be lost to a ticket.
     * The threshold and the idempotency both live in `reportRepeatedDeferral`,
     * so this call asks nothing about how many.
     */
    try {
      const filed = await queue.reportRepeatedDeferral(submission.id)
      if (filed.outcome === 'reported') {
        log.warn(
          `submission ${submission.id} has been deferred ${count} times; ` +
            `filed as ticket ${filed.ticketId}`,
          {
            event: 'submission.deferral.reported',
            submissionId: submission.id,
            deferrals: count,
            ticketId: filed.ticketId,
          },
        )
      }
    } catch (error) {
      log.error(`could not file the repeated deferral of submission ${submission.id}`, error, {
        event: 'submission.deferral.report.failed',
        submissionId: submission.id,
      })
    }

    // The reason, which this line has never carried. `verifySubmission` puts it
    // in the submission's evidence, where a citizen sees it and an operator
    // reading a container log does not — so half an hour of production flapping
    // said only `→ pending (image-gen)`, fifteen times, and named no cause.
    log.warn(
      `submission ${submission.id} → pending (${taskType}), attempt ${count}, ` +
        `not retried for ${Math.round(wait / 1000)}s: ${written.verification.evidence}`,
      {
        event: 'submission.deferred',
        submissionId: submission.id,
        taskType,
        attempt: count,
        retryInMs: wait,
      },
    )
    return { kind: 'decided', status: written.submission.status }
  }

  deferrals?.delete(submission.id)
  log.info(`submission ${submission.id} → ${written.submission.status} (${taskType})${booked}`, {
    event: 'submission.decided',
    submissionId: submission.id,
    taskType,
    status: written.submission.status,
  })
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
  // One per runner, not per poll: the whole value of a backoff is that the next
  // poll remembers what the last one learned (#132).
  const deferrals = deps.deferrals ?? new Map<SubmissionId, Deferral>()
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
              {
                event: 'submission.expired',
                submissionId: expired.submissionId,
                previousStatus: expired.previousStatus,
              },
            )
          }

          // Info rather than warn: an agent giving up is the ordinary thing this
          // sweep exists to measure, not a fault. Logged at all because a count
          // that silently stays zero is how a broken sweep hides (#108).
          const abandoned = await deps.queue.sweepAbandoned()
          if (abandoned > 0)
            log.info(`closed ${abandoned} abandoned attempt(s)`, {
              event: 'attempts.abandoned.closed',
              closed: abandoned,
            })

          // Same tick, same reason as the line above: nobody is present to do
          // it, and a count that stays at zero is how a broken pruner hides.
          const pruned = await deps.queue.pruneContacts()
          if (pruned > 0)
            log.info(`pruned ${pruned} contact record(s)`, {
              event: 'contacts.pruned',
              pruned,
            })
        }

        let taken = 0
        while (running && taken < batchSize) {
          inFlight++
          try {
            const outcome = await tick({ ...deps, taskTypes, deferrals })
            if (outcome.kind === 'idle') break
          } finally {
            inFlight--
          }
          taken++
        }

        lastPollAt = clock()
        consecutiveFailures = 0
        // One line per completed cycle, even when nothing was waiting (`#230`).
        // `{event: "poll.done", handled: 0}` is not noise: it is the only thing
        // that distinguishes *the runner ran and had nothing to do* from *the
        // runner is dead*, and error monitoring structurally misses the second.
        log.info(`poll done; ${taken} submission(s) handled`, {
          event: 'poll.done',
          handled: taken,
        })
        if (running) await pause(pollIntervalMs)
      } catch (error) {
        consecutiveFailures++
        const wait = Math.min(pollIntervalMs * 2 ** consecutiveFailures, maxBackoffMs)
        log.error(
          `poll failed (${consecutiveFailures} in a row); retrying in ${Math.round(wait / 1000)}s`,
          error,
          { event: 'poll.failed', consecutiveFailures, retryInMs: wait },
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
    log.error(`could not return submission ${submissionId} to the queue`, error, {
      event: 'submission.release.failed',
      submissionId,
    })
  }
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    // `unref` so a pending poll interval never keeps a stopping process alive.
    setTimeout(resolve, ms).unref()
  })
