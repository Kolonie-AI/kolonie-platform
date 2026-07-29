import { MODERATION_NOTE_MAX_LENGTH, noStagesRun, type ModerationStages } from '@kolonie-ai/core'
import type { ApprovedEntry, ModerationVerdict, PendingGuidance } from '@kolonie-ai/db'
import { findDuplicate } from './dedup.js'
import { judgeQuality } from './quality.js'
import { checkRedLines } from './redline.js'
import type { Model } from './llm.js'

/** Where the loop reads and writes. Injected, so the decision is testable without one. */
export interface ModerationStore {
  pending(limit: number): Promise<readonly PendingGuidance[]>
  approvedOn(query: {
    readonly kind: 'struggle' | 'tip'
    readonly taskId: PendingGuidance['taskId']
  }): Promise<readonly ApprovedEntry[]>
  record(input: {
    readonly kind: 'struggle' | 'tip'
    readonly id: string
    readonly content: string
    readonly verdict: ModerationVerdict
    readonly model: string
    readonly stages: ModerationStages
  }): Promise<{ readonly outcome: 'written' | 'stale' }>
}

/** Where the loop says what it did. Injected so tests are not noisy. */
export interface Log {
  info(message: string): void
  warn(message: string): void
  error(message: string, error: unknown): void
}

const silentLog: Log = { info: () => {}, warn: () => {}, error: () => {} }

export interface LoopDependencies {
  readonly store: ModerationStore
  readonly model: Model
  readonly log?: Log
}

/**
 * What one entry's moderation came to.
 *
 * `failed` is its own outcome rather than a thrown error, because a model that
 * refuses one entry must not stop the ones behind it — a single unparseable
 * reply should cost that entry a poll, not the queue an hour.
 */
export type Judgement =
  | { readonly kind: 'approved' }
  | { readonly kind: 'rejected'; readonly reason: string }
  | { readonly kind: 'merged'; readonly into: string }
  | { readonly kind: 'stale' }
  | { readonly kind: 'failed'; readonly error: unknown }

/**
 * Judge one entry: red lines, then quality, then duplication.
 *
 * **The order is deliberate and it is not the order the issue listed them in.**
 * Each stage costs a model call, and each is an exit — so the cheapest and most
 * severe goes first. An entry that crosses a red line is refused without ever
 * paying for a quality call or an embedding, and it is refused regardless of how
 * well written it is, which is the property that matters: an articulate
 * instruction to hand over a credential must not survive because it cleared a
 * quality bar.
 *
 * Dedup is last because it is the only stage whose answer depends on what is
 * already published. Running it first would spend an embedding call on entries
 * that were never going to be published at all.
 *
 * **Nothing here writes `approved` twice.** `recordModeration` guards on the row
 * still being `pending`, so a second runner that picked up the same entry writes
 * nothing rather than overwriting a verdict — the same rule the verifier runner
 * follows about a submission whose verdict arrived late.
 *
 * **Every stage's answer is accumulated as it goes, and the ones that never ran
 * say so.** `stages` starts as three `not-run` entries and each stage fills in its
 * own, so an entry refused on a red line records that quality and dedup were never
 * reached — rather than recording nothing about them, which would make *the
 * quality check passed it* and *the quality check never looked* the same row.
 */
export async function judge(entry: PendingGuidance, deps: LoopDependencies): Promise<Judgement> {
  const { store, model, log = silentLog } = deps
  let stages = noStagesRun()

  try {
    const redLine = await checkRedLines(entry, model)
    stages = {
      ...stages,
      redLine:
        redLine.kind === 'clear'
          ? { outcome: 'clear' }
          : { outcome: 'crossed', reason: note(redLine.reason) },
    }

    if (redLine.kind === 'crossed') {
      return await write(entry, { decision: 'reject', note: note(redLine.reason) }, deps, stages, {
        kind: 'rejected',
        reason: redLine.reason,
      })
    }

    const quality = await judgeQuality(entry, model)
    stages = {
      ...stages,
      quality:
        quality.kind === 'useful'
          ? { outcome: 'approve' }
          : { outcome: 'reject', reason: note(quality.reason) },
    }

    if (quality.kind === 'useless') {
      return await write(entry, { decision: 'reject', note: note(quality.reason) }, deps, stages, {
        kind: 'rejected',
        reason: quality.reason,
      })
    }

    const approved = await store.approvedOn({ kind: entry.kind, taskId: entry.taskId })
    const duplicate = await findDuplicate(entry, approved, model)
    stages = {
      ...stages,
      dedup:
        duplicate.kind === 'distinct'
          ? // `distinct` with nothing to compare against is not the same answer as
            // `distinct` after the model was asked, and a reader reconstructing a
            // decision needs to know which. The corpus size is what separates them.
            {
              outcome: 'distinct',
              ...(approved.length === 0 && { reason: 'nothing published yet' }),
            }
          : { outcome: duplicate.of, reason: note(duplicate.reason) },
    }

    if (duplicate.kind === 'duplicate') {
      return await write(entry, { decision: 'merge', duplicateOf: duplicate.of }, deps, stages, {
        kind: 'merged',
        into: duplicate.of,
      })
    }

    return await write(entry, { decision: 'approve' }, deps, stages, { kind: 'approved' })
  } catch (error) {
    // The row stays `pending`, so nothing is served and the next poll tries
    // again. A model that is down means entries accumulate unpublished, which is
    // visible and reversible — unlike a verdict written from a failed call. The
    // stages accumulated so far go with it: they explain nothing that was decided,
    // because nothing was.
    log.error(`could not moderate ${entry.kind} ${entry.id}`, error)
    return { kind: 'failed', error }
  }
}

/**
 * Write the verdict, and report `stale` if somebody else got there first.
 *
 * `entry.content` goes with it, and not as a convenience: it is what the moderator
 * actually judged, and `recordModeration` refuses to apply a verdict to text that
 * has changed since. An author may revise a pending entry (`#74`), which leaves the
 * status `pending` — so the text is the only thing that can tell a verdict reached
 * about *this* report from one reached about the report it replaced.
 */
async function write(
  entry: PendingGuidance,
  verdict: ModerationVerdict,
  deps: LoopDependencies,
  stages: ModerationStages,
  judgement: Judgement,
): Promise<Judgement> {
  const written = await deps.store.record({
    kind: entry.kind,
    id: entry.id,
    content: entry.content,
    verdict,
    model: deps.model.name,
    stages,
  })
  return written.outcome === 'stale' ? { kind: 'stale' } : judgement
}

/**
 * The model's reason, cut to what the column holds.
 *
 * Truncated rather than refused. The note is read by the citizen whose entry was
 * turned down, and a verdict that failed to write because the explanation ran
 * long would leave the entry `pending` forever — an unexplained rejection is
 * bad, an entry stuck in limbo is worse.
 */
function note(reason: string): string {
  const trimmed = reason.trim()
  return trimmed.length <= MODERATION_NOTE_MAX_LENGTH
    ? trimmed
    : `${trimmed.slice(0, MODERATION_NOTE_MAX_LENGTH - 1)}…`
}

/** What one pass over the queue came to. */
export interface TickOutcome {
  readonly judged: number
  readonly approved: number
  readonly rejected: number
  readonly merged: number
  readonly failed: number
}

/**
 * Take one batch of unjudged entries through the pipeline.
 *
 * Sequential rather than concurrent, and that is a decision about correctness
 * rather than about load. Two entries on the same task judged in parallel would
 * each be compared against a corpus that does not yet contain the other, so a
 * pair of identical reports arriving together would both be approved — and the
 * duplicate they were supposed to merge into would be each other.
 */
export async function tick(deps: LoopDependencies, batchSize: number): Promise<TickOutcome> {
  const { store, log = silentLog } = deps
  const entries = await store.pending(batchSize)

  const outcome = { judged: 0, approved: 0, rejected: 0, merged: 0, failed: 0 }

  for (const entry of entries) {
    const judgement = await judge(entry, deps)
    outcome.judged++

    switch (judgement.kind) {
      case 'approved':
        outcome.approved++
        log.info(`${entry.kind} ${entry.id} approved`)
        break
      case 'rejected':
        outcome.rejected++
        log.info(`${entry.kind} ${entry.id} rejected: ${judgement.reason}`)
        break
      case 'merged':
        outcome.merged++
        log.info(`${entry.kind} ${entry.id} merged into ${judgement.into}`)
        break
      case 'stale':
        log.warn(`${entry.kind} ${entry.id} was already judged when its verdict arrived`)
        break
      case 'failed':
        outcome.failed++
        break
    }
  }

  return outcome
}

export interface RunnerOptions {
  readonly pollIntervalMs?: number
  readonly maxBackoffMs?: number
  readonly batchSize?: number
  readonly sleep?: (ms: number) => Promise<void>
}

export interface Runner {
  readonly finished: Promise<void>
  stop(): Promise<void>
  health(): RunnerHealth
}

export interface RunnerHealth {
  readonly running: boolean
  readonly lastPollAt: string | null
  readonly consecutiveFailures: number
}

const DEFAULTS = {
  /**
   * A minute, where the verifier runner polls every five seconds.
   *
   * Nothing waits on a moderation verdict. An agent that files a struggle has
   * been heard the moment the row is written; whether it is published is a
   * question for other agents, later. A tight poll would spend model calls on an
   * empty queue for no gain anyone can observe.
   */
  pollIntervalMs: 60_000,
  maxBackoffMs: 600_000,
  /**
   * Small, because every entry is several model calls and this is the only
   * process in the Colony that spends money per row.
   */
  batchSize: 10,
} as const

/**
 * Run until stopped.
 *
 * The same shape as the verifier runner's loop, including why: backoff is on the
 * poll rather than on the entry, because a model that is refusing requests
 * refuses all of them equally and retrying each one individually turns one
 * outage into a request storm against whatever is already struggling.
 */
export function startRunner(deps: LoopDependencies, options: RunnerOptions = {}): Runner {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULTS.pollIntervalMs
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULTS.maxBackoffMs
  const batchSize = options.batchSize ?? DEFAULTS.batchSize
  const sleep = options.sleep ?? realSleep
  const log = deps.log ?? silentLog

  let running = true
  let lastPollAt: string | null = null
  let consecutiveFailures = 0
  let wake: (() => void) | undefined

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
        const outcome = await tick(deps, batchSize)
        if (outcome.judged > 0) {
          log.info(
            `moderated ${outcome.judged}: ${outcome.approved} approved, ` +
              `${outcome.rejected} rejected, ${outcome.merged} merged, ${outcome.failed} deferred`,
          )
        }
        lastPollAt = new Date().toISOString()
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
      wake?.()
      await finished
    },
    health: () => ({ running, lastPollAt, consecutiveFailures }),
  }
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref()
  })
