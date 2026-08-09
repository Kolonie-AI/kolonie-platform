import {
  MODERATION_NOTE_MAX_LENGTH,
  noStagesRun,
  silentLog,
  type BriefingClaim,
  type ConfidentialSpan,
  type ModerationStages,
  type ReportKind,
  type Log,
  type ReportNarrative,
  type TaskId,
} from '@kolonie-ai/core'
import type {
  ApprovedEntry,
  BriefingSource,
  ModerationVerdict,
  PendingReport,
  ProviderChange,
  TaskText,
} from '@kolonie-ai/db'
import { markConfidential } from './confidentiality.js'
import { synthesise } from './synthesis.js'
import { respondToChange, type Tripwire } from './tripwire.js'
import { findDuplicate } from './dedup.js'
import { questTick, type QuestLoopDependencies } from './quests.js'
import { answerTick, type AnswerLoopDependencies } from './answers.js'
import { providerReasonTick, type ProviderReasonLoopDependencies } from './provider-reasons.js'
import { questReportTick, type QuestReportLoopDependencies } from './quest-reports.js'
import { directionTick, type DirectionLoopDependencies } from './directions.js'
import { judgeQuality } from './quality.js'
import { checkRedLines } from './redline.js'
import { ProviderUnreachable, type Model } from './llm.js'

/** Where the loop reads and writes. Injected, so the decision is testable without one. */
export interface ModerationStore {
  pending(limit: number): Promise<readonly PendingReport[]>
  approvedOn(query: {
    readonly kind: ReportKind
    readonly taskId: PendingReport['taskId']
  }): Promise<readonly ApprovedEntry[]>
  record(input: {
    readonly kind: ReportKind
    readonly id: string
    /**
     * The report as the moderator saw it, field by field (#113).
     *
     * The columns rather than the joined text, because the columns are what an
     * author replaces — a verdict reached against answers that have since been
     * rewritten must not be applied, and that guard can only be written against
     * what is actually stored.
     */
    readonly narrative: ReportNarrative
    readonly verdict: ModerationVerdict
    readonly model: string
    readonly stages: ModerationStages
    readonly confidentialSpans: readonly ConfidentialSpan[]
  }): Promise<{ readonly outcome: 'written' | 'stale' }>
}

/**
 * Where the loop says what it did. Injected so tests are not noisy.
 *
 * One interface for all four processes since `#230`, defined in `packages/core`
 * — three copies of a logging interface produced three log formats, and a
 * format nothing else shares is one nothing can query.
 */
export type { Log }

export interface LoopDependencies {
  readonly store: ModerationStore
  readonly model: Model
  readonly log?: Log
  /**
   * The provider-change tripwire (#115), or nothing.
   *
   * **Optional, so a runner without it moderates exactly as before.** The
   * detector is an addition to this loop rather than a stage of it — nothing
   * about a verdict passes through it — and a deployment that has not wired it
   * should degrade to the behaviour that existed, not fail to start.
   */
  readonly tripwire?: TripwireDependencies
  /**
   * The quest text stage (`#176`), or nothing.
   *
   * **Optional for the reason the tripwire is**: a deployment that has not wired
   * it moderates reports exactly as before rather than failing to start. It
   * shares this loop's schedule and its model, and nothing else — a quest is
   * judged against the Colony's rules and never against the reports.
   */
  readonly quests?: QuestLoopDependencies
  /**
   * The scrub between a citizen's report and the sponsor that paid for it
   * (`#177`), or nothing. Optional for the reason the other two are.
   */
  readonly answers?: AnswerLoopDependencies
  /**
   * What citizens said about the quests themselves (`#240`).
   *
   * A fourth pass on the same poll, for the reason the third one is here: a
   * handful of rows a day and one model call each, against a container, a health
   * check and a deploy step.
   */
  readonly questReports?: QuestReportLoopDependencies
  /** The scrub between a citizen's sentence about a provider and every reader of the register (`#362`). */
  readonly providerReasons?: ProviderReasonLoopDependencies
  /**
   * Reading what citizens said they want to become (`#140`).
   *
   * A fifth pass on the same poll, for the reason the fourth one is here — and
   * with one property none of the others have: **nothing anywhere waits on its
   * result.** A citizen with no reading has no declared preference, and a
   * listing with no preference is the listing the Colony served before this
   * existed.
   */
  readonly directions?: DirectionLoopDependencies
}

/** The tripwire as this loop needs it: detect, then respond. */
export interface TripwireDependencies extends Tripwire {
  detect(taskId: TaskId): Promise<ProviderChange | null>
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
 * Judge one entry: red lines, then quality, then confidentiality, then duplication.
 *
 * **The order is deliberate and it is not the order the issue listed them in.**
 * Each stage costs a model call, and each is an exit — so the cheapest and most
 * severe goes first. An entry that crosses a red line is refused without ever
 * paying for a quality call or an embedding, and it is refused regardless of how
 * well written it is, which is the property that matters: an articulate
 * instruction to hand over a credential must not survive because it cleared a
 * quality bar.
 *
 * **Confidentiality is third and it is the one stage that is not an exit.** It
 * cannot refuse anything (#84), so it buys no early return and its position is
 * decided entirely by what would be wasted: before quality it would mark entries
 * that are about to be thrown out, and after dedup it would be too late, because
 * dedup and everything downstream have to already know which spans are not
 * repeatable.
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
 * say so.** `stages` starts as four `not-run` entries and each stage fills in its
 * own, so an entry refused on a red line records that quality, confidentiality and
 * dedup were never reached — rather than recording nothing about them, which would
 * make *the quality check passed it* and *the quality check never looked* the same
 * row.
 */
export async function judge(entry: PendingReport, deps: LoopDependencies): Promise<Judgement> {
  const { store, model, log = silentLog } = deps
  let stages = noStagesRun()
  // Accumulated alongside `stages` and for the same reason: an entry rejected
  // before this stage ran carries an empty list, and that is the honest answer —
  // nothing was found because nothing looked. `stages.confidentiality` is what
  // says which of the two happened.
  let confidentialSpans: readonly ConfidentialSpan[] = []

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
      return await write(
        entry,
        { decision: 'reject', note: note(redLine.reason) },
        deps,
        stages,
        confidentialSpans,
        { kind: 'rejected', reason: redLine.reason },
      )
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
      return await write(
        entry,
        { decision: 'reject', note: note(quality.reason) },
        deps,
        stages,
        confidentialSpans,
        { kind: 'rejected', reason: quality.reason },
      )
    }

    // No branch on the result, and there is no version of this stage that has
    // one. Its outcome is recorded and carried; it never changes what happens
    // next. See `confidentiality.ts` for why that is a constraint and not a
    // simplification.
    const confidential = await markConfidential(entry, model)
    confidentialSpans = confidential.spans
    stages = {
      ...stages,
      confidentiality:
        confidential.spans.length === 0
          ? { outcome: 'clean' }
          : {
              outcome: 'marked',
              // The kinds and the count, never the values. This lands in
              // `moderations.stages`, which is a longer-lived and wider-read
              // table than the entry — copying an author's mailbox address into
              // an audit row would spread what the stage exists to contain.
              reason: note(
                `${confidential.spans.length} span(s): ` +
                  [...new Set(confidential.spans.map((span) => span.kind))].sort().join(', '),
              ),
            },
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
      return await write(
        entry,
        { decision: 'merge', duplicateOf: duplicate.of },
        deps,
        stages,
        confidentialSpans,
        { kind: 'merged', into: duplicate.of },
      )
    }

    return await write(entry, { decision: 'approve' }, deps, stages, confidentialSpans, {
      kind: 'approved',
    })
  } catch (error) {
    // The row stays `pending`, so nothing is served and the next poll tries
    // again. A model that is down means entries accumulate unpublished, which is
    // visible and reversible — unlike a verdict written from a failed call. The
    // stages accumulated so far go with it: they explain nothing that was decided,
    // because nothing was.
    log.error(`could not moderate ${entry.kind} ${entry.id}`, error, {
      event: 'entry.moderate.failed',
      kind: entry.kind,
      entryId: entry.id,
    })
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
  entry: PendingReport,
  verdict: ModerationVerdict,
  deps: LoopDependencies,
  stages: ModerationStages,
  confidentialSpans: readonly ConfidentialSpan[],
  judgement: Judgement,
): Promise<Judgement> {
  const written = await deps.store.record({
    kind: entry.kind,
    id: entry.id,
    narrative: entry.narrative,
    verdict,
    model: deps.model.name,
    stages,
    confidentialSpans,
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

  /**
   * Tasks touched this batch, so the tripwire is asked once per task rather
   * than once per entry (#115). A batch of five reports on one task is one
   * question about that task, and asking five times would spend four queries to
   * get the same answer — and, on the fifth, an answer already made false by the
   * cooldown the first one started.
   */
  const touched = new Set<TaskId>()

  for (const entry of entries) {
    const judgement = await judge(entry, deps)
    outcome.judged++
    if (judgement.kind === 'approved' || judgement.kind === 'merged') touched.add(entry.taskId)

    switch (judgement.kind) {
      case 'approved':
        outcome.approved++
        log.info(`${entry.kind} ${entry.id} approved`, {
          event: 'entry.judged',
          kind: entry.kind,
          entryId: entry.id,
          verdict: 'approved',
        })
        break
      case 'rejected':
        outcome.rejected++
        log.info(`${entry.kind} ${entry.id} rejected: ${judgement.reason}`, {
          event: 'entry.judged',
          kind: entry.kind,
          entryId: entry.id,
          verdict: 'rejected',
        })
        break
      case 'merged':
        outcome.merged++
        log.info(`${entry.kind} ${entry.id} merged into ${judgement.into}`, {
          event: 'entry.judged',
          kind: entry.kind,
          entryId: entry.id,
          verdict: 'merged',
          into: judgement.into,
        })
        break
      case 'stale':
        log.warn(`${entry.kind} ${entry.id} was already judged when its verdict arrived`, {
          event: 'entry.stale',
          kind: entry.kind,
          entryId: entry.id,
        })
        break
      case 'failed':
        outcome.failed++
        break
    }
  }

  await checkTripwire(touched, deps, log)
  await moderateQuests(deps, batchSize, log)
  await scrubAnswers(deps, batchSize, log)
  await scrubQuestReports(deps, batchSize, log)
  await scrubProviderReasons(deps, batchSize, log)
  await readDirections(deps, batchSize, log)

  return outcome
}

/**
 * Read the declarations waiting on a classifier, on the same poll (`#140`).
 *
 * Its failure is swallowed like every other extra pass's, and here the argument
 * is the strongest it gets: what a failed pass costs is an ordering, and the
 * fallback ordering is the Colony's own. Nothing a citizen can see breaks.
 */
async function readDirections(deps: LoopDependencies, batchSize: number, log: Log): Promise<void> {
  const { directions } = deps
  if (directions === undefined) return

  try {
    const outcome = await directionTick({ log, ...directions }, batchSize)
    if (outcome.classified > 0 || outcome.deferred > 0) {
      log.info(
        `directions: ${outcome.classified} of ${outcome.read} read, ${outcome.deferred} deferred`,
        {
          event: 'direction.pass.done',
          read: outcome.read,
          classified: outcome.classified,
          deferred: outcome.deferred,
        },
      )
    }
  } catch (error) {
    log.error('the direction pass failed', error, { event: 'direction.pass.failed' })
  }
}

/**
 * Scrub the quest reports waiting on it, on the same poll (`#177`).
 *
 * Its failure is swallowed like the other two passes': the three share a
 * process and a schedule and nothing else, and a queue that throws must not stop
 * the reports being published.
 */
async function scrubAnswers(deps: LoopDependencies, batchSize: number, log: Log): Promise<void> {
  const { answers } = deps
  if (answers === undefined) return

  try {
    const outcome = await answerTick({ log, ...answers }, batchSize)
    if (outcome.judged > 0) {
      log.info(
        `quest reports: ${outcome.judged} read, ${outcome.scrubbed} scrubbed, ` +
          `${outcome.held} held for a steward, ${outcome.failed} deferred`,
        {
          event: 'answers.pass.done',
          judged: outcome.judged,
          scrubbed: outcome.scrubbed,
          held: outcome.held,
          failed: outcome.failed,
        },
      )
    }
  } catch (error) {
    log.error('the quest report scrub failed', error, { event: 'answers.pass.failed' })
  }
}

/**
 * Scrub what citizens said about the quests themselves, on the same poll
 * (`#240`).
 *
 * Its failure is swallowed like the other passes': they share a process and a
 * schedule and nothing else, and a queue that throws must not stop the rest.
 */
async function scrubQuestReports(
  deps: LoopDependencies,
  batchSize: number,
  log: Log,
): Promise<void> {
  const { questReports } = deps
  if (questReports === undefined) return

  try {
    const outcome = await questReportTick({ log, ...questReports }, batchSize)
    if (outcome.judged > 0) {
      log.info(
        `quest reports about quests: ${outcome.judged} read, ${outcome.scrubbed} scrubbed, ` +
          `${outcome.refused} refused, ${outcome.failed} deferred`,
        {
          event: 'quest-report.pass.done',
          judged: outcome.judged,
          scrubbed: outcome.scrubbed,
          refused: outcome.refused,
          failed: outcome.failed,
        },
      )
    }
  } catch (error) {
    log.error('the quest report scrub failed', error, { event: 'quest-report.pass.failed' })
  }
}

/**
 * Run the provider-reason scrub on the same poll (`#362`).
 *
 * Its failure is swallowed like every other pass's, and for the reason they all
 * give: they share a process and a schedule and nothing else, so a queue that
 * throws must not stop the rest. What a failed poll costs here is that a
 * register keeps its counts and shows one fewer sentence, which is the mildest
 * failure of any pass in this file.
 */
async function scrubProviderReasons(
  deps: LoopDependencies,
  batchSize: number,
  log: Log,
): Promise<void> {
  const { providerReasons } = deps
  if (providerReasons === undefined) return

  try {
    const outcome = await providerReasonTick({ log, ...providerReasons }, batchSize)
    if (outcome.judged > 0) {
      log.info(
        `reasons about providers: ${outcome.judged} read, ${outcome.scrubbed} scrubbed, ` +
          `${outcome.refused} refused, ${outcome.failed} deferred`,
        {
          event: 'provider-reason.pass.done',
          judged: outcome.judged,
          scrubbed: outcome.scrubbed,
          refused: outcome.refused,
          failed: outcome.failed,
        },
      )
    }
  } catch (error) {
    log.error('the provider reason scrub failed', error, { event: 'provider-reason.pass.failed' })
  }
}

/**
 * Run the quest stage on the same poll (`#176`).
 *
 * **Its failure is swallowed, exactly as the tripwire's is.** A quest queue that
 * throws must not stop reports being published: the two share a process and a
 * schedule, and nothing else. What the quests lose is a poll, which is a delay a
 * sponsor can wait out — where a dead moderation loop is a corpus that never
 * publishes at all.
 */
async function moderateQuests(deps: LoopDependencies, batchSize: number, log: Log): Promise<void> {
  const { quests } = deps
  if (quests === undefined) return

  try {
    const outcome = await questTick({ log, ...quests }, batchSize)
    if (outcome.judged > 0) {
      log.info(
        `quests: ${outcome.judged} judged, ${outcome.approved} cleared, ` +
          `${outcome.rejected} refused, ${outcome.failed} deferred`,
        {
          event: 'quests.pass.done',
          judged: outcome.judged,
          approved: outcome.approved,
          rejected: outcome.rejected,
          failed: outcome.failed,
        },
      )
    }
  } catch (error) {
    log.error('the quest moderation pass failed', error, { event: 'quests.pass.failed' })
  }
}

/**
 * Ask whether the world moved under any task this batch touched (#115).
 *
 * **Its own failure is swallowed**, and that is the same rule the report routing
 * follows: this is instrumentation on top of moderation, and moderation must not
 * stop because a detector threw. A missed conclusion is caught by the next batch
 * on that task; a moderation loop that dies is a corpus that never publishes.
 */
async function checkTripwire(
  touched: ReadonlySet<TaskId>,
  deps: LoopDependencies,
  log: Log,
): Promise<void> {
  const { tripwire } = deps
  if (tripwire === undefined) return

  for (const taskId of touched) {
    try {
      const change = await tripwire.detect(taskId)
      if (change !== null) await respondToChange(change, tripwire, log)
    } catch (error) {
      log.error(`tripwire failed on task ${taskId}`, error, {
        event: 'tripwire.failed',
        taskId,
      })
    }
  }
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
 * What a poll that threw during shutdown is, as opposed to one that failed.
 *
 * **Every full deploy left one `error` behind, and both of its claims were
 * wrong** (`#291`). `stop()` sets `running` to false and awaits the entry in
 * flight, which is right — but an `all` deploy takes Postgres down in the same
 * window, so the query in flight dies with its database and `tick()` throws. The
 * `catch` then said `poll failed … retrying in 120s` at `error`, about a process
 * that was exiting and would retry nothing.
 *
 * It cost nothing operationally and something else entirely to
 * `kolonie-docs#133`'s Watch Agent, which counts errors per service per day: a
 * standing false positive in the one signal that means *look at this* is a
 * monitor being taught to shrug.
 *
 * `running` is the whole difference and it is already in scope at both call
 * sites. Interrupted work is logged at `warn`, under its own event, promising
 * nothing — and it does not count towards `consecutiveFailures`, which exists to
 * drive backoff on a loop that has a next iteration.
 */
function reportPollThrow(
  log: Log,
  running: boolean,
  interrupted: { readonly event: string; readonly message: string },
  failed: { readonly event: string; readonly message: string; readonly retryInMs: number },
  error: unknown,
  consecutiveFailures: number,
): void {
  if (!running) {
    log.warn(interrupted.message, { event: interrupted.event })
    return
  }

  log.error(failed.message, error, {
    event: failed.event,
    consecutiveFailures,
    retryInMs: failed.retryInMs,
  })
}

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
        // One line per completed cycle, even when nothing was waiting (`#230`).
        // `{event: "poll.done", handled: 0}` is not noise: it is the only thing
        // that distinguishes *the runner ran and had nothing to do* from *the
        // runner is dead*, and error monitoring structurally misses the second.
        log.info(
          outcome.judged === 0
            ? 'poll done; nothing waiting to be moderated'
            : `moderated ${outcome.judged}: ${outcome.approved} approved, ` +
                `${outcome.rejected} rejected, ${outcome.merged} merged, ` +
                `${outcome.failed} deferred`,
          {
            event: 'poll.done',
            handled: outcome.judged,
            approved: outcome.approved,
            rejected: outcome.rejected,
            merged: outcome.merged,
            failed: outcome.failed,
          },
        )
        lastPollAt = new Date().toISOString()
        consecutiveFailures = 0
        if (running) await pause(pollIntervalMs)
      } catch (error) {
        if (running) consecutiveFailures++
        const wait = Math.min(pollIntervalMs * 2 ** consecutiveFailures, maxBackoffMs)
        reportPollThrow(
          log,
          running,
          {
            event: 'poll.interrupted',
            message: 'poll interrupted by shutdown; the runner is stopping',
          },
          {
            event: 'poll.failed',
            message: `poll failed (${consecutiveFailures} in a row); retrying in ${Math.round(wait / 1000)}s`,
            retryInMs: wait,
          },
          error,
          consecutiveFailures,
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

/**
 * Where the synthesis reads and writes. Injected, like {@link ModerationStore}.
 *
 * A second store rather than four more methods on the first, because the two
 * loops share a process and nothing else: one judges entries, the other writes
 * documents, and a store that served both would be the seam along which somebody
 * eventually calls the wrong one.
 */
export interface BriefingStore {
  /** Tasks whose corpus has moved since their briefing was written. */
  stale(limit: number): Promise<readonly TaskId[]>
  /** What the task is called, for the synthesis prompt. */
  /**
   * What the task asks for, in its own words (#182).
   *
   * The title alone was not enough: a claim can contradict the instructions in
   * as many words and the synthesis had no way to see it.
   */
  taskText(taskId: TaskId): Promise<TaskText | undefined>
  corpus(taskId: TaskId): Promise<readonly BriefingSource[]>
  write(input: {
    readonly taskId: TaskId
    readonly claims: readonly BriefingClaim[]
    readonly model: string
  }): Promise<void>
}

export interface BriefingDependencies {
  readonly store: BriefingStore
  readonly model: Model
  readonly log?: Log
}

/** What one pass over the stale tasks came to. */
export interface BriefingTickOutcome {
  readonly written: number
  readonly failed: number
  /**
   * How many of {@link failed} were the provider being unreachable rather than
   * the synthesis going wrong (`#449`). Counted separately because the two need
   * opposite reactions, and because a pass that is *entirely* this is an outage
   * rather than a batch of defects — see {@link briefingTick}.
   */
  readonly unreachable: number
}

/** What one task's pass came to. Three outcomes, because two of them are failures for different reasons. */
export type SynthesisOutcome = 'written' | 'failed' | 'unreachable'

/**
 * Rewrite every briefing whose corpus has moved.
 *
 * **The dirty flag is what makes this affordable**, and it is the whole reason
 * this is a separate loop rather than a step at the end of `judge`. A task that
 * collects two hundred reports must not cost two hundred syntheses: approval sets
 * a flag, and one pass here consumes however many changes accumulated since the
 * last one. Two hundred approvals inside one tick interval cost **one** call.
 *
 * Sequential for the reason `tick` is, though a weaker one: nothing here is
 * order-dependent, but this process is the one that spends money per row and a
 * burst of parallel syntheses is the shape of an accident.
 *
 * A task whose synthesis throws keeps its flag and is retried next pass. That is
 * the same failure direction as moderation: nothing is published rather than
 * something wrong being published, and the stale briefing that stays in place is
 * served with its age visible.
 */
export async function briefingTick(
  deps: BriefingDependencies,
  batchSize: number,
): Promise<BriefingTickOutcome> {
  const { store, model, log = silentLog } = deps
  const outcome = { written: 0, failed: 0, unreachable: 0 }

  for (const taskId of await store.stale(batchSize)) {
    const result = await synthesiseNow(store, model, taskId, log)
    if (result === 'written') outcome.written++
    else {
      outcome.failed++
      if (result === 'unreachable') outcome.unreachable++
    }
  }

  /**
   * **A pass that reached nothing is an outage, and it is raised once** (`#449`).
   *
   * Per task, an unreachable provider is a warning: the flag stays set and the
   * next poll writes the briefing. But a pass in which *every* attempt failed
   * that way, and none succeeded, is not a run of unlucky tasks — the provider
   * is not there, and nothing this loop does next will change that until it is.
   *
   * Throwing hands it to the runner's existing arrangement rather than building
   * a second one: `startBriefingRunner` catches it, logs one
   * `briefing.poll.failed` at error, counts it toward `consecutiveFailures` and
   * doubles the wait. That is precisely what its own comment already argues for
   * — *"a model that is refusing requests refuses all of them, and retrying each
   * task individually turns one outage into a request storm"* — and it means
   * one line per poll during an outage instead of one per task, with a backoff
   * behind it.
   *
   * **The empty batch is excluded by construction.** With nothing stale,
   * `unreachable` is 0 and this does not fire; a quiet loop keeps saying so
   * through `briefing.poll.done`.
   */
  if (outcome.written === 0 && outcome.unreachable > 0 && outcome.unreachable === outcome.failed) {
    throw new ProviderUnreachable(
      '/chat/completions',
      new Error(`${outcome.unreachable} briefing(s) in this pass reached no provider`),
    )
  }

  return outcome
}

/**
 * How much slower the synthesis tick runs than the moderation poll.
 *
 * Ten times, so a minute of moderation polling is ten minutes between
 * syntheses. The number is a cost decision rather than a freshness one: nothing
 * waits on a briefing, a reader that arrives during the gap gets the previous one
 * with its age visible, and the alternative — regenerating on every approval —
 * is the two-hundred-syntheses case this exists to prevent.
 */
export const BRIEFING_TICK_MULTIPLIER = 10

/**
 * Run the synthesis loop until stopped.
 *
 * The same shape as {@link startRunner}, including the backoff argument: a model
 * that is refusing requests refuses all of them, and retrying each task
 * individually turns one outage into a request storm.
 */
export function startBriefingRunner(
  deps: BriefingDependencies,
  options: RunnerOptions = {},
): Runner {
  const pollIntervalMs =
    options.pollIntervalMs ?? DEFAULTS.pollIntervalMs * BRIEFING_TICK_MULTIPLIER
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
        const outcome = await briefingTick(deps, batchSize)
        // Same rule as the moderation cycle above: a completed pass says so even
        // when it wrote nothing, because the synthesis loop runs on its own
        // interval and silence is otherwise indistinguishable from death.
        log.info(
          outcome.written === 0 && outcome.failed === 0
            ? 'briefing poll done; nothing to synthesise'
            : `briefings: ${outcome.written} written, ${outcome.failed} deferred`,
          {
            event: 'briefing.poll.done',
            written: outcome.written,
            failed: outcome.failed,
          },
        )
        lastPollAt = new Date().toISOString()
        consecutiveFailures = 0
        if (running) await pause(pollIntervalMs)
      } catch (error) {
        if (running) consecutiveFailures++
        const wait = Math.min(pollIntervalMs * 2 ** consecutiveFailures, maxBackoffMs)
        reportPollThrow(
          log,
          running,
          {
            event: 'briefing.poll.interrupted',
            message: 'briefing poll interrupted by shutdown; the runner is stopping',
          },
          {
            event: 'briefing.poll.failed',
            message: `briefing poll failed (${consecutiveFailures} in a row); retrying in ${Math.round(wait / 1000)}s`,
            retryInMs: wait,
          },
          error,
          consecutiveFailures,
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

/**
 * Write one task's briefing now.
 *
 * **Extracted so the slow tick and the tripwire share one path** (#115). The
 * tripwire's whole point is that a detected provider change must not wait for a
 * tick ten times slower than moderation — and a second implementation of *turn a
 * corpus into claims* would be two things that could disagree about what a
 * briefing is, with the fast one written under time pressure.
 *
 * Answers whether it wrote, so both callers count the same way. Never throws: a
 * task whose synthesis fails keeps its flag and is retried next pass, which is
 * the degradation the whole subsystem is built around — a stale briefing that
 * stays in place is a far smaller failure than something wrong being published.
 */
export async function synthesiseNow(
  store: BriefingStore,
  model: Model,
  taskId: TaskId,
  log: Log,
): Promise<SynthesisOutcome> {
  try {
    const task = await store.taskText(taskId)
    if (task === undefined) {
      // The row points at a task that is gone. Nothing to write and nothing to
      // retry — but the flag stays set rather than being cleared, because a task
      // cannot in fact be deleted (`restrict`), so this means something stranger
      // than a race and it should stay visible.
      log.warn(`briefing for ${taskId} names a task that could not be read`, {
        event: 'briefing.task.unreadable',
        taskId,
      })
      return 'failed'
    }

    const corpus = await store.corpus(taskId)
    const { claims, proposed, unsourced, blank } = await synthesise({ task, corpus }, model)
    await store.write({ taskId, claims, model: model.name })

    /**
     * **A pass that produced no claims writes no row** (`#611`), and the line
     * says which of the two happened rather than reporting *written, 0 claims* —
     * which is what the twelve empty briefings looked like in the log for as
     * long as they existed.
     */
    if (claims.length === 0) {
      log.info(`no briefing for ${taskId}: nothing to say from ${corpus.length} entries`, {
        event: 'briefing.none',
        taskId,
        entries: corpus.length,
      })
    } else {
      log.info(
        `briefing for ${taskId} written from ${corpus.length} entries, ${claims.length} claims`,
        { event: 'briefing.written', taskId, entries: corpus.length, claims: claims.length },
      )
    }

    // **A corpus with entries in it should never produce nothing**, and this is
    // the line that says so out loud. Every entry cleared a moderator who judged
    // that it contains a real observation, so there is something to state; an
    // empty briefing over a non-empty corpus means the synthesis discarded it,
    // and the reader is then told the Colony "found nothing worth passing on"
    // about a task somebody wrote usable advice for.
    //
    // Warned rather than retried. A retry would loop against a prompt that is
    // answering consistently, and the flag is already cleared — what is needed is
    // for a person to read the prompt, which needs the failure to be visible
    // rather than corrected. It cost a production round trip to find this once.
    //
    // **Which of the two it was, said in the line itself** (`#374`). An empty
    // briefing has two causes and they need opposite fixes: a model that
    // answered with nothing is a prompt to rewrite, and a model that answered
    // and had every claim dropped here is a schema or a provider problem. Both
    // used to print this same sentence, so nine empty briefings could not be
    // sorted into the two piles without a production round trip — which is what
    // `#374` had to do, and what nobody should have to do twice.
    if (corpus.length > 0 && claims.length === 0) {
      const because =
        proposed === 0
          ? 'the model proposed no claims at all'
          : `the model proposed ${proposed}, and every one was dropped here ` +
            `(${unsourced} naming no source in the corpus, ${blank} with empty text)`

      log.warn(
        `briefing for ${taskId} is empty over ${corpus.length} moderated entries — ${because}`,
        {
          event: 'briefing.empty',
          taskId,
          entries: corpus.length,
          proposed,
          unsourced,
          blank,
        },
      )
    }

    return 'written'
  } catch (error) {
    /**
     * **A provider that could not be reached is not this task's failure**
     * (`#449`). The flag stays set, the next poll writes the briefing, and one
     * occurrence of it is the system working — the rule
     * `packages/verifiers/src/support.ts` already states for a citizen is the
     * same one here: *"A single transient failure that clears on retry is the
     * system working."*
     *
     * So it is a warning with its own event name rather than
     * `briefing.failed` at error, and that distinction is load-bearing rather
     * than cosmetic: `apps/support-triage-runner` reads `error` out of Loki and
     * files one GitHub issue per signature. A connection reset filed as a defect
     * costs a maintainer the read, and — worse — it lands in the same signature
     * as a real synthesis failure, so the issue that is genuinely about a broken
     * briefing arrives already noisy. `#449` is that issue, filed twice for a
     * network hiccup.
     *
     * **The alarm is not lost, it moves up a level.** A provider that is
     * unreachable is unreachable for every task in the batch, so
     * {@link briefingTick} raises it once for the pass rather than once per
     * task, and the runner's existing backoff and `briefing.poll.failed` line
     * take it from there. That is the arrangement `startBriefingRunner`'s own
     * comment already argues for: *"a model that is refusing requests refuses
     * all of them, and retrying each task individually turns one outage into a
     * request storm."*
     */
    if (error instanceof ProviderUnreachable) {
      log.warn(`briefing for ${taskId} deferred — ${error.message}`, {
        event: 'briefing.unreachable',
        taskId,
        endpoint: error.endpoint,
      })
      return 'unreachable'
    }

    log.error(`could not write the briefing for ${taskId}`, error, {
      event: 'briefing.failed',
      taskId,
    })
    return 'failed'
  }
}
