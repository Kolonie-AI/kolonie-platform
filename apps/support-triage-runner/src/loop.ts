import { silentLog, type Log, type SupportTicket, type SupportTicketId } from '@kolonie-ai/core'
import type { Issues, KnownIssue } from './github.js'
import { watchLogs, type WatchDependencies } from './watch.js'
import { watchDebt, type DebtWatchDependencies } from './debt.js'
import { escalateDiagnoses, type DiagnosisEscalationDependencies } from './diagnoses.js'
import { watchArrivals, type ArrivalWatchDependencies } from './arrivals.js'
import {
  closingNote,
  filing,
  issueBody,
  readDecision,
  type AnsweredTicket,
  type TicketContext,
  type TriageDecision,
  type TriageInput,
  type TriageModel,
} from './triage.js'

/**
 * Where the loop says what it did. Injected so tests are not noisy.
 *
 * One interface for all four processes since `#230`, defined in `packages/core`
 * — three copies of a logging interface produced three log formats, and a
 * format nothing else shares is one nothing can query.
 */
export type { Log }

/** What triage records. Mirrors `recordTriage` in packages/db without importing it. */
export interface TriageStore {
  queue(limit: number): Promise<readonly SupportTicket[]>
  answered(limit: number): Promise<readonly SupportTicket[]>
  record(outcome: {
    readonly ticketId: SupportTicketId
    readonly status: 'acknowledged' | 'resolved' | 'declined'
    readonly resolution?: string | null
    readonly issueUrl?: string | null
    /**
     * Move the ticket to the maintainers' desk (`#1345`). One-directional: the
     * literal is the only value, so no caller here can route a ticket back.
     */
    readonly route?: 'desk'
  }): Promise<SupportTicket | undefined>
  /**
   * The circumstances of one ticket, read only when it is about to become an
   * issue (#255). Mirrors `ticketContext`.
   */
  context(ticketId: SupportTicketId): Promise<TicketContext>
  /** Acknowledged tickets carrying an issue URL. Mirrors `ticketsAwaitingTheirIssue`. */
  awaiting(limit: number): Promise<readonly SupportTicket[]>
  /** Settle one because its issue closed. Mirrors `resolveFromClosedIssue`. */
  resolve(outcome: {
    readonly ticketId: SupportTicketId
    readonly resolution: string
  }): Promise<SupportTicket | undefined>
  depth(): Promise<{ readonly open: number; readonly oldestOpenAt: string | null }>
}

export interface LoopDependencies {
  readonly store: TriageStore
  readonly model: TriageModel
  readonly issues: Issues
  readonly log?: Log
  /**
   * The second source: the Colony's own errors (`#407`).
   *
   * **Optional, so a deployment that has not been given a log store keeps
   * triaging tickets.** The two sources share a GitHub App and nothing else —
   * `#407` chose that over a second runner precisely because two processes each
   * holding a write credential is the outcome to avoid, and the price is that
   * this loop now does two jobs and says so.
   */
  readonly watch?: WatchDependencies | undefined
  /**
   * The third source: money the Colony owes and has not paid (`#720`).
   *
   * **Optional on the same terms as `watch`, and for a different reason.** That
   * one is optional because a deployment may have no log store; this one is
   * optional because a deployment may have no wallet, and a Colony that cannot
   * pay anybody has no debt to watch. Both share the one GitHub App, which is
   * still the argument against a fourth runner.
   */
  readonly debt?: DebtWatchDependencies | undefined
  /**
   * A colony-scoped diagnosis's way out of the table (`#869`).
   *
   * **Optional on the same terms as the two above.** A deployment with no doctor
   * writes no diagnoses and has none to escalate, and all three share the one
   * GitHub App — which is the whole reason this is a source here rather than a
   * credential in `apps/doctor-runner` (`#839`, `#407`).
   */
  readonly diagnoses?: DiagnosisEscalationDependencies | undefined
  /**
   * What agents said on their way in and did not get through (`#1009`, `#1026`).
   *
   * **Optional on `debt`'s terms.** One query on the connection the queue
   * already holds and the same App — and a deployment nobody has failed to reach
   * reads an empty queue and is silent, which costs less than a flag saying
   * whether the door is being reported on.
   */
  readonly arrivals?: ArrivalWatchDependencies | undefined
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
  let call
  try {
    const classified = await deps.model.classify(full)
    call = classified.call
    decision = readDecision(classified.answer, full)
  } catch (error) {
    // **A model that cannot answer must not settle a ticket.** Leaving it `open`
    // means the next tick tries again, which is what should happen when the
    // failure is a rate limit or an outage. Writing `human` here would spend the
    // citizen's ticket on our own bad afternoon.
    log.error(`the model could not classify ticket ${ticket.id}; leaving it open`, error, {
      event: 'ticket.classify.failed',
      ticketId: ticket.id,
    })
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
      log.info(`ticket ${ticket.id}: known, pointed at ${decision.issueUrl}`, {
        event: 'ticket.triaged',
        ticketId: ticket.id,
        verdict: 'known',
        issueUrl: decision.issueUrl,
      })
      return { decision }
    }

    case 'answered': {
      await deps.store.record({
        ticketId: ticket.id,
        status: 'resolved',
        resolution: decision.answer,
        // `undefined` and not `null`: `recordTriage` writes the column only when
        // it is given one, and a precedent with no issue must leave the field
        // alone rather than blank it.
        issueUrl: decision.issueUrl ?? undefined,
      })
      log.info(`ticket ${ticket.id}: answered from ticket ${decision.fromTicketId}`, {
        event: 'ticket.triaged',
        ticketId: ticket.id,
        verdict: 'answered',
        fromTicketId: decision.fromTicketId,
        issueUrl: decision.issueUrl ?? undefined,
      })
      return { decision }
    }

    case 'new': {
      const where = filing(decision, ticket.kind)
      // **Read here rather than with the queue** (#255): only a ticket that
      // becomes an issue needs it, and that is a minority of the queue. A
      // failure throws into the caller's per-ticket catch, which leaves the row
      // `open` for the next tick — the right outcome, because the alternative
      // is an issue permanently missing the context the next reader wanted.
      const context = await deps.store.context(ticket.id)
      const url = await deps.issues.create({
        repository: where.repository,
        title: decision.title,
        body: issueBody(ticket, decision.summary, context, call, decision.security),
        labels: where.labels,
      })

      if (url === null) {
        // **Not settled.** GitHub refusing is our problem, not the citizen's, and
        // a ticket marked acknowledged with no issue behind it is a promise
        // nobody can follow. Left open so the next tick files it.
        log.warn(`ticket ${ticket.id}: wanted a new issue and GitHub refused; leaving it open`, {
          event: 'ticket.file.refused',
          ticketId: ticket.id,
        })
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
      log.info(`ticket ${ticket.id}: filed ${url}`, {
        event: 'ticket.triaged',
        ticketId: ticket.id,
        verdict: 'new',
        issueUrl: url,
      })
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

    case 'desk': {
      // **The write is what makes this terminal** (`#1345`). Setting `route` to
      // `desk` takes the ticket out of every query this runner makes, so the
      // decision cannot be revisited by a later tick that reads the ticket
      // differently — including this one, on a retry. `acknowledged` and not
      // `resolved` because nothing has been answered yet: a person still owes
      // the citizen a reply, and the desk is where they find that they do.
      //
      // No issue, and no model-authored prose. The model decided *where this
      // goes*; what to say about a citizen's own situation is a maintainer's
      // sentence to write.
      await deps.store.record({
        ticketId: ticket.id,
        status: 'acknowledged',
        route: 'desk',
        resolution:
          "Read, and passed to the maintainers' desk rather than filed as a report about the " +
          `Colony. Why: ${decision.why}`,
      })
      log.info(`ticket ${ticket.id}: sent to the desk — ${decision.why}`, {
        event: 'ticket.triaged',
        ticketId: ticket.id,
        verdict: 'desk',
      })
      return { decision }
    }

    case 'human': {
      await deps.store.record({
        ticketId: ticket.id,
        status: 'acknowledged',
        resolution:
          'Read, and held for a maintainer rather than answered automatically. ' +
          `Why: ${decision.why}`,
      })
      log.info(`ticket ${ticket.id}: held for a human — ${decision.why}`, {
        event: 'ticket.triaged',
        ticketId: ticket.id,
        verdict: 'human',
      })
      return { decision }
    }
  }
}

/**
 * How many waiting tickets one pass looks at.
 *
 * Larger than the triage batch, and for the opposite reason. A ticket in the
 * queue costs a model call, so twenty is a tick. A ticket waiting on its issue
 * costs a lookup in a map that has already been fetched, so the only thing this
 * number bounds is one query and some memory — and it needs to be comfortably
 * above the number of tickets that can sit acknowledged at once, because a
 * ticket beyond the limit waits another half hour for no reason a citizen could
 * understand.
 *
 * Measured 2026-08-01 against the production database: 4 tickets exist in total,
 * all four acknowledged. Two hundred is therefore two orders of magnitude of room
 * and still a number rather than *all of them*.
 */
export const AWAITING_BATCH = 200

export interface ReconcileOutcome {
  /** Acknowledged tickets carrying an issue, looked at this pass. */
  readonly waiting: number
  /** Of those, the ones whose issue had been closed and are now resolved. */
  readonly resolved: number
}

/**
 * Carry the ending of an issue back to the ticket that caused it (#165).
 *
 * **This is the half of the flow that was missing.** `support.ts` in core states
 * the rule this does not break: *"Work flows in exactly one direction — ticket →
 * triage → possibly an issue."* Nothing here creates anything. What travels back
 * is the outcome, and it has to, because every issue this runner files ends with
 * the sentence *"closing it is how they learn the ending"* — and
 * `kolonie.support.read` returns the ticket, not the issue.
 *
 * **Matched by URL, in memory, against one listing per repository.** The
 * alternative is asking GitHub about each waiting ticket, which is a call count
 * that grows with how much the Colony has ever been told rather than with how
 * much has changed. Two tickets pointing at one issue are both settled by one
 * pass, which is the ordinary case after triage has recognised a duplicate.
 *
 * **A write that finds no row is not an error.** `resolveFromClosedIssue` matches
 * only `acknowledged`, so a ticket a concurrent tick has already settled answers
 * `undefined` — the same at-least-once shape `recordTriage` documents, and the
 * correct behaviour is to count it as not-ours and carry on.
 */
export async function reconcile(deps: LoopDependencies): Promise<ReconcileOutcome> {
  const log = deps.log ?? silentLog

  // Same rule as the queue pass: a seam that reads nothing is not evidence that
  // nothing is closed, and acting on it would settle no ticket anyway.
  if (!deps.issues.available) return { waiting: 0, resolved: 0 }

  const waiting = await deps.store.awaiting(AWAITING_BATCH)
  if (waiting.length === 0) return { waiting: 0, resolved: 0 }

  const closed = new Map((await deps.issues.closed()).map((issue) => [issue.url, issue]))
  if (closed.size === 0) return { waiting: waiting.length, resolved: 0 }

  /**
   * The arrival pass (`#1026`), in its own `try` on the argument the three above
   * give.
   *
   * **Silent unless it did something**, and *something* here includes letting
   * reports go: a report that aged out without ever becoming a finding is one
   * nobody will ever be told about again, and a cap or a drop that says nothing
   * reads afterwards as everything having been covered. Reports merely waiting
   * for company are the ordinary state and are not a line.
   */
  if (deps.arrivals !== undefined) {
    try {
      const found = await watchArrivals(deps.arrivals)
      if (found.skipped === undefined && found.filed + found.commented + found.letGo > 0) {
        log.info(
          `arrival pass: ${found.filed} filed, ${found.commented} commented, ` +
            `${found.marked} reports counted, ${found.letGo} let go ` +
            `(${found.contentless} stating no discrepancy), ${found.waiting} waiting`,
          { event: 'arrivals.pass.done', ...found },
        )
      }
    } catch (error) {
      log.error('the arrival pass failed; every other pass is unaffected', error, {
        event: 'arrivals.pass.failed',
      })
    }
  }

  let resolved = 0
  for (const ticket of waiting) {
    const issue = ticket.issueUrl === null ? undefined : closed.get(ticket.issueUrl)
    if (issue === undefined) continue

    try {
      const settled = await deps.store.resolve({
        ticketId: ticket.id,
        resolution: closingNote(issue),
      })
      if (settled === undefined) continue
      resolved++
      log.info(`ticket ${ticket.id}: resolved, ${issue.url} is closed`, {
        event: 'ticket.resolved',
        ticketId: ticket.id,
        issueUrl: issue.url,
      })
    } catch (error) {
      // One ticket that cannot be written must not cost the others theirs. The
      // row stays `acknowledged`, which is still true, and the next pass retries.
      log.error(`ticket ${ticket.id} could not be settled from ${issue.url}`, error, {
        event: 'ticket.resolve.failed',
        ticketId: ticket.id,
        issueUrl: issue.url,
      })
    }
  }

  return { waiting: waiting.length, resolved }
}

export interface TickOutcome {
  readonly seen: number
  readonly known: number
  readonly answered: number
  readonly filed: number
  readonly held: number
  /**
   * Tickets read as a citizen's own situation and passed to the desk (`#1345`).
   *
   * Counted apart from `held` deliberately. Both leave a person something to
   * read, but `held` rising is triage failing to decide and is worth an alarm,
   * while `desked` rising is triage working — and a single number that mixes
   * them cannot tell a broken model from a week of account trouble.
   */
  readonly desked: number
  readonly failed: number
  /** Tickets settled this pass because their issue had been closed (#165). */
  readonly resolved: number
}

/**
 * One pass over the queue, and one over what the queue produced earlier.
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
 *
 * **Reconciliation runs first and runs whether or not the queue has anything in
 * it.** An empty queue is the normal state of this service, and it is exactly
 * when there is nothing new to triage that there is most likely something old to
 * finish — so it sits above the early return rather than below it. It is also
 * why it does not share the queue's failure: `reconcile` throwing must not stop
 * a citizen's new report being read, and a triage failure must not strand an
 * answer that is already available.
 */
export async function tick(deps: LoopDependencies, batchSize: number): Promise<TickOutcome> {
  const log = deps.log ?? silentLog

  /**
   * The log pass runs first and on every tick, whether or not a ticket is
   * waiting (`#407`).
   *
   * **Before the queue rather than after it**, because a defect in the logs is
   * the thing with a clock on it: the target is half an hour from a defect
   * appearing to an issue existing, and a slow batch of tickets must not spend
   * that budget. Its own failure is caught here so a broken log store cannot
   * stop a ticket being triaged — they are two jobs in one process, not one job.
   */
  if (deps.watch !== undefined) {
    try {
      const found = await watchLogs(deps.watch)
      if (found.skipped === undefined && found.seen + found.closed + found.reopened > 0) {
        log.info(
          `log pass: ${found.seen} signature(s), ${found.filed} filed, ` +
            `${found.commented} commented, ${found.closed} quiet-closed, ` +
            `${found.reopened} reopened, ${found.quiet} already said, ` +
            `${found.withheld} withheld by the cap`,
          { event: 'defects.pass.done', ...found },
        )
      }
    } catch (error) {
      log.error('the log pass failed; tickets are unaffected', error, {
        event: 'defects.pass.failed',
      })
    }
  }

  /**
   * The debt pass, beside the log pass and caught the same way (`#720`).
   *
   * **Its own `try` rather than sharing the one above**, on that block's own
   * argument: three jobs in one process are three jobs, and an unreachable log
   * store must not take the money alarm down with it. It is one query and a
   * board read, so it costs nothing to run on a tick that has no tickets.
   */
  if (deps.debt !== undefined) {
    try {
      const found = await watchDebt(deps.debt)
      if (found.skipped === undefined && found.action !== 'quiet') {
        log.info(`debt pass: ${found.action}, ${found.count} unpaid, ${found.lamports} lamports`, {
          event: 'debt.pass.done',
          ...found,
        })
      }
    } catch (error) {
      log.error('the debt pass failed; tickets and logs are unaffected', error, {
        event: 'debt.pass.failed',
      })
    }
  }

  /**
   * The escalation pass (`#869`), in its own `try` for the reason the two above
   * give: three sources in one process are three jobs, and one of them failing
   * must not take the others down.
   *
   * **Silent on an ordinary pass.** Almost every pass finds nothing — a
   * colony-wide finding is rare by construction — and a line saying so every
   * half hour is `#231`'s wallpaper aimed at a log rather than at a maintainer.
   * The cap being hit is the exception and is always said, because a pass that
   * quietly dropped work reads afterwards as one that found none.
   */
  if (deps.diagnoses !== undefined) {
    try {
      const escalated = await escalateDiagnoses(deps.diagnoses)
      if (escalated.filed > 0 || escalated.over > 0) {
        log.info(
          `escalation pass: filed ${escalated.filed}, ${escalated.over} left for the next pass`,
          { event: 'diagnoses.pass.done', ...escalated },
        )
      }
    } catch (error) {
      log.error(
        'the escalation pass failed; tickets, logs and the debt alarm are unaffected',
        error,
        {
          event: 'diagnoses.pass.failed',
        },
      )
    }
  }

  let resolved = 0
  try {
    resolved = (await reconcile(deps)).resolved
  } catch (error) {
    log.error('could not reconcile acknowledged tickets against closed issues', error, {
      event: 'reconcile.failed',
    })
  }

  const queue = await deps.store.queue(batchSize)

  const counts = {
    seen: 0,
    known: 0,
    answered: 0,
    filed: 0,
    held: 0,
    desked: 0,
    failed: 0,
    resolved,
  }
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
      { event: 'triage.skipped.no-app', waiting: queue.length },
    )
    return counts
  }

  // A partial corpus is worth having here and is not worth having everywhere,
  // which is why `open()` names its gaps rather than deciding for its callers
  // (`#867`). Triage *matches* against this corpus and files only what no issue
  // covers; two repositories out of three still recognise most of a ticket, and
  // the cost of the third is a duplicate a maintainer closes in a second. Said
  // out loud, because a pass that matched against two thirds of the Colony and
  // reported nothing unusual is the quiet version of the same failure.
  const corpus = await deps.issues.open()
  if (corpus.unreadable.length > 0) {
    log.warn(
      `triaging against a partial corpus: ${corpus.unreadable.join(', ')} could not be listed`,
      { event: 'triage.corpus.partial', unreadable: [...corpus.unreadable] },
    )
  }

  const issues = [...corpus.issues]
  const answered: AnsweredTicket[] = (await deps.store.answered(ANSWERED_CORPUS))
    .filter((t) => t.status === 'resolved' && t.resolution !== null)
    .map((t) => ({
      id: t.id,
      subject: t.subject,
      resolution: t.resolution ?? '',
      // Carried into the corpus so the `answered` verdict has something to
      // carry out of it (#436). Dropping it here is what left the second
      // citizen with the link in prose only.
      issueUrl: t.issueUrl ?? null,
    }))

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
        case 'desk':
          counts.desked++
          break
      }
    } catch (error) {
      counts.failed++
      log.error(`ticket ${ticket.id} could not be triaged; it stays in the queue`, error, {
        event: 'ticket.triage.failed',
        ticketId: ticket.id,
      })
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
        // One line per completed cycle, even when nothing was waiting (`#230`).
        // `{event: "poll.done", handled: 0}` is not noise: it is the only thing
        // that distinguishes *the runner ran and had nothing to do* from *the
        // runner is dead*, and error monitoring structurally misses the second.
        // The counts ride on the same line rather than a second one, so a cycle
        // is one record whether it saw twenty tickets or none.
        log.info(
          outcome.seen === 0
            ? 'poll done; no tickets waiting'
            : `triaged ${outcome.seen}: ${outcome.known} already known, ` +
                `${outcome.answered} answered from precedent, ${outcome.filed} filed, ` +
                `${outcome.desked} sent to the desk, ` +
                `${outcome.held} held for a human, ${outcome.failed} left in the queue`,
          {
            event: 'poll.done',
            handled: outcome.seen,
            known: outcome.known,
            answered: outcome.answered,
            filed: outcome.filed,
            held: outcome.held,
            desked: outcome.desked,
            failed: outcome.failed,
          },
        )
        lastPollAt = new Date().toISOString()
        consecutiveFailures = 0
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
      wake?.()
      await finished
    },
    health: () => ({ running, lastPollAt, consecutiveFailures }),
  }
}
