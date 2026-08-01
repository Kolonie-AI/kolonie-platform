import type { SupportTicket, SupportTicketId } from '@kolonie-ai/core'
import type { Issues, KnownIssue } from './github.js'
import {
  filing,
  issueBody,
  readDecision,
  type AnsweredTicket,
  type TriageDecision,
  type TriageInput,
  type TriageModel,
} from './triage.js'

export interface Log {
  info(message: string): void
  warn(message: string): void
  error(message: string, error?: unknown): void
}

const silentLog: Log = { info: () => {}, warn: () => {}, error: () => {} }

/** What triage records. Mirrors `recordTriage` in packages/db without importing it. */
export interface TriageStore {
  queue(limit: number): Promise<readonly SupportTicket[]>
  answered(limit: number): Promise<readonly SupportTicket[]>
  record(outcome: {
    readonly ticketId: SupportTicketId
    readonly status: 'acknowledged' | 'resolved' | 'declined'
    readonly resolution?: string | null
    readonly issueUrl?: string | null
  }): Promise<SupportTicket | undefined>
  depth(): Promise<{ readonly open: number; readonly oldestOpenAt: string | null }>
}

export interface LoopDependencies {
  readonly store: TriageStore
  readonly model: TriageModel
  readonly issues: Issues
  readonly log?: Log
}

/**
 * How many already-answered tickets are offered as precedent.
 *
 * Bounded because the corpus is for recognition, not for audit. Fifty is enough
 * that a question asked twice in a week is recognised, and small enough that the
 * prompt stays readable by the model that has to read it.
 */
export const ANSWERED_CORPUS = 50

export interface TriageResult {
  readonly decision: TriageDecision
  /**
   * The issue this ticket caused to exist.
   *
   * Returned rather than merely logged so that {@link tick} can put it into the
   * corpus the *next* ticket in the same batch is shown. Without it, two citizens
   * reporting one new thing in one pass are both told nothing covers it, and the
   * Colony files the same issue twice — the duplicate noise this service exists to
   * remove, produced by the thing removing it.
   */
  readonly filed?: KnownIssue
}

/** One ticket, start to finish. Exported because this is what is worth testing. */
export async function triageOne(
  ticket: SupportTicket,
  input: Omit<TriageInput, 'ticket'>,
  deps: LoopDependencies,
): Promise<TriageResult> {
  const log = deps.log ?? silentLog
  const full: TriageInput = { ticket, ...input }

  let decision: TriageDecision
  try {
    decision = readDecision(await deps.model.classify(full), full)
  } catch (error) {
    // **A model that cannot answer must not settle a ticket.** Leaving it `open`
    // means the next tick tries again, which is what should happen when the
    // failure is a rate limit or an outage. Writing `human` here would spend the
    // citizen's ticket on our own bad afternoon.
    log.error(`the model could not classify ticket ${ticket.id}; leaving it open`, error)
    throw error
  }

  switch (decision.kind) {
    case 'known': {
      await deps.store.record({
        ticketId: ticket.id,
        status: 'acknowledged',
        resolution:
          'Another citizen reported this before you, and the work is tracked in the linked ' +
          'issue. Watching it is how you will learn the ending.',
        issueUrl: decision.issueUrl,
      })
      // Said on the issue too, so the count of citizens hitting a thing is
      // visible to whoever is deciding what to fix next. Best effort: a comment
      // that fails costs a maintainer some context, and the citizen has already
      // been answered.
      await deps.issues.comment(
        decision.issueUrl,
        'Another citizen reported this through the support channel. Filed automatically by ' +
          '`apps/support-triage-runner`; their report is not quoted here, because a ticket is ' +
          'not public.',
      )
      log.info(`ticket ${ticket.id}: known, pointed at ${decision.issueUrl}`)
      return { decision }
    }

    case 'answered': {
      await deps.store.record({
        ticketId: ticket.id,
        status: 'resolved',
        resolution: decision.answer,
      })
      log.info(`ticket ${ticket.id}: answered from ticket ${decision.fromTicketId}`)
      return { decision }
    }

    case 'new': {
      const where = filing(decision)
      const url = await deps.issues.create({
        repository: where.repository,
        title: decision.title,
        body: issueBody(ticket, decision.summary),
        labels: where.labels,
      })

      if (url === null) {
        // **Not settled.** GitHub refusing is our problem, not the citizen's, and
        // a ticket marked acknowledged with no issue behind it is a promise
        // nobody can follow. Left open so the next tick files it.
        log.warn(`ticket ${ticket.id}: wanted a new issue and GitHub refused; leaving it open`)
        return { decision: { kind: 'human', why: 'GitHub refused the issue.' } }
      }

      await deps.store.record({
        ticketId: ticket.id,
        status: 'acknowledged',
        resolution:
          'Filed as an issue the Colony has decided to look at. Watching it is how you will ' +
          'learn the ending.',
        issueUrl: url,
      })
      log.info(`ticket ${ticket.id}: filed ${url}`)
      return {
        decision,
        filed: {
          repository: where.repository,
          // Not read by the matcher — it compares urls — and carried so a log or
          // a future caller is not left deriving it from the url by regex.
          number: Number(url.split('/').pop() ?? 0),
          title: decision.title,
          body: decision.summary,
          url,
        },
      }
    }

    case 'human': {
      await deps.store.record({
        ticketId: ticket.id,
        status: 'acknowledged',
        resolution:
          'Read, and held for a maintainer rather than answered automatically. ' +
          `Why: ${decision.why}`,
      })
      log.info(`ticket ${ticket.id}: held for a human — ${decision.why}`)
      return { decision }
    }
  }
}

export interface TickOutcome {
  readonly seen: number
  readonly known: number
  readonly answered: number
  readonly filed: number
  readonly held: number
  readonly failed: number
}

/**
 * One pass over the queue.
 *
 * **The corpus is read once per tick, not once per ticket.** Two citizens
 * reporting the same new thing in one tick would otherwise both be told nothing
 * covers it, and the Colony would file the same issue twice — so the corpus is
 * extended in memory as issues are filed, and the second ticket sees the first
 * one's issue.
 *
 * A ticket that throws does not stop the batch. The failure is almost always the
 * model or GitHub, both of which affect the next ticket equally — but the row is
 * left `open`, so nothing is lost by carrying on and finding out.
 */
export async function tick(deps: LoopDependencies, batchSize: number): Promise<TickOutcome> {
  const log = deps.log ?? silentLog
  const queue = await deps.store.queue(batchSize)

  const counts = { seen: 0, known: 0, answered: 0, filed: 0, held: 0, failed: 0 }
  if (queue.length === 0) return counts

  // **No App means no triage, not triage against nothing.** See `Issues.available`:
  // a model shown an empty corpus cannot recognise a ticket the Colony already
  // has an issue for, so it would hold it or propose a duplicate — on somebody's
  // real report. Doing nothing leaves the queue exactly where it was before this
  // service existed, which is the honest degradation.
  if (!deps.issues.available) {
    log.warn(
      `${queue.length} ticket(s) waiting and no GitHub App is configured; ` +
        'not triaging, because matching against an empty corpus is worse than waiting',
    )
    return counts
  }

  const issues = [...(await deps.issues.open())]
  const answered: AnsweredTicket[] = (await deps.store.answered(ANSWERED_CORPUS))
    .filter((t) => t.status === 'resolved' && t.resolution !== null)
    .map((t) => ({ id: t.id, subject: t.subject, resolution: t.resolution ?? '' }))

  for (const ticket of queue) {
    counts.seen++
    try {
      const { decision, filed } = await triageOne(ticket, { issues, answered }, deps)
      // Into the corpus the next ticket of this same batch is shown. See
      // TriageResult.filed for why this is not merely tidy.
      if (filed !== undefined) issues.push(filed)
      switch (decision.kind) {
        case 'known':
          counts.known++
          break
        case 'answered':
          counts.answered++
          break
        case 'new':
          counts.filed++
          break
        case 'human':
          counts.held++
          break
      }
    } catch (error) {
      counts.failed++
      log.error(`ticket ${ticket.id} could not be triaged; it stays in the queue`, error)
    }
  }

  return counts
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

/**
 * Half an hour, against the moderation runner's minute.
 *
 * Nothing waits on a triage verdict in the way a citizen waits on a moderation
 * one: the ticket was received when the row was written, and `kolonie.support.read`
 * tells them so. What this interval buys is the opposite of speed — a batch large
 * enough that two reports of the same thing usually land in one pass and produce
 * one issue.
 */
const DEFAULTS = { pollIntervalMs: 1_800_000, maxBackoffMs: 3_600_000, batchSize: 20 }

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.()
  })

/** Same shape as the other two runners, deliberately: one loop idiom in this repository. */
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
        if (outcome.seen > 0) {
          log.info(
            `triaged ${outcome.seen}: ${outcome.known} already known, ` +
              `${outcome.answered} answered from precedent, ${outcome.filed} filed, ` +
              `${outcome.held} held for a human, ${outcome.failed} left in the queue`,
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
