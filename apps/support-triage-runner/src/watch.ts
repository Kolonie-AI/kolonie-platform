import { silentLog, type Log } from '@kolonie-ai/core'
import type { Issues } from './github.js'
import type { DefectWriter } from './llm.js'
import type { DefectEvidence, Logs } from './logs.js'
import {
  DEFECT_WINDOW_SECONDS,
  MAX_ISSUES_PER_DAY,
  MAX_ISSUES_PER_RUN,
  closedIssueFor,
  decide,
  defectIssue,
  openIssueFor,
  recurrenceComment,
  type DefectHistory,
  type DefectReport,
} from './defects.js'

/**
 * One pass of the log detector (`#407`).
 *
 * A defect visible in the logs becomes **an ordinary issue on the board, in the
 * right repository, that a coding agent can pick up** — filed within half an
 * hour of appearing, deduplicated against what is already open *and* against
 * what was recently closed.
 *
 * ## What this pass will not do
 *
 * **It does not file when it cannot read.** Both seams are checked before
 * anything is written, and the reason is the one `github.ts` already gives:
 * *"without it the loop cannot tell an empty corpus from an unreadable one"*. A
 * GitHub outage would otherwise turn every known signature into a fresh issue,
 * so a bad afternoon at GitHub would produce a board full of duplicates about a
 * Colony that was fine.
 *
 * **It never closes anything.** Whether a defect is dealt with is a person's
 * call. That half of the Watch Agent's design is right and is kept verbatim.
 *
 * **It files into Inbox, by not asking for anything else.** A machine's finding
 * is a finding, not a specification; the board's own automation puts a new issue
 * in Inbox, and moving it to Ready is a person or an agent having read it. That
 * one step is what stops a coding agent working from a log excerpt.
 */

export interface DefectStore {
  /**
   * Record what this window saw, and answer what was known **before** it.
   *
   * Mirrors `recordSeenDefects`. The before-state is the return value because a
   * caller that recorded first could never tell a signature it has just met from
   * one it has been watching for a week.
   */
  seen(
    defects: readonly { signature: string; service: string; occurrences: number }[],
  ): Promise<Map<string, DefectHistory['known']>>
  /** Say an issue was filed. Called after GitHub confirmed it, never before. */
  filed(signature: string, issueUrl: string, regression: boolean): Promise<void>
  /** Say a recurrence was noted, so the next one waits a day. */
  commented(signature: string): Promise<void>
  /** How many issues this detector filed since a moment. The per-day cap reads it. */
  filedSince(since: string): Promise<number>
}

export interface WatchDependencies {
  readonly logs: Logs
  readonly issues: Issues
  readonly store: DefectStore
  readonly writer: DefectWriter
  readonly log?: Log
  readonly now?: () => number
}

export interface WatchOutcome {
  /** Signatures the window contained. */
  readonly seen: number
  readonly filed: number
  readonly commented: number
  /** Known, still failing, and already said today. Nothing new to report. */
  readonly quiet: number
  readonly regressions: number
  /** Signatures that would have been filed and were not, because of a cap. */
  readonly withheld: number
  readonly skipped?: string
}

/**
 * Read the window, decide, and write.
 *
 * The caps are enforced here and **what they withheld is returned and logged**.
 * A silent cap reads as *everything was covered* when it was not, which is the
 * one way a bounded automaton lies.
 */
export async function watchLogs(deps: WatchDependencies): Promise<WatchOutcome> {
  const log = deps.log ?? silentLog
  const now = deps.now ?? Date.now
  const empty: WatchOutcome = {
    seen: 0,
    filed: 0,
    commented: 0,
    quiet: 0,
    regressions: 0,
    withheld: 0,
  }

  if (!deps.logs.available) {
    return { ...empty, skipped: 'no log store is configured' }
  }

  /**
   * **Read before write, both seams, and refuse rather than guess.** An
   * unreadable issue corpus and an empty one look identical from here, and
   * acting on the second when it is the first files a duplicate of everything.
   */
  if (!deps.issues.available) {
    log.warn('the log detector read nothing: no GitHub App is configured', {
      event: 'defects.skipped.no-app',
    })
    return { ...empty, skipped: 'no GitHub App is configured' }
  }

  const signatures = await deps.logs.signatures(DEFECT_WINDOW_SECONDS)
  if (signatures.length === 0) return empty

  const knownBefore = await deps.store.seen(
    signatures.map((s) => ({ signature: s.signature, service: s.service, occurrences: s.count })),
  )

  const [open, closed] = await Promise.all([deps.issues.open(), deps.issues.closed()])

  const dayAgo = new Date(now() - 86_400_000).toISOString()
  const filedToday = await deps.store.filedSince(dayAgo)

  const counts = { ...empty, seen: signatures.length } as {
    seen: number
    filed: number
    commented: number
    quiet: number
    regressions: number
    withheld: number
  }

  /**
   * Loudest first, so a cap that bites keeps the largest thing rather than
   * whichever signature Loki happened to return first.
   */
  const ordered = [...signatures].sort((a, b) => b.count - a.count)

  for (const signature of ordered) {
    const openIssue = openIssueFor(signature.signature, open)
    const closedIssue = closedIssueFor(signature.signature, closed)

    /**
     * **Read early, and only where it changes the decision** (`#560`).
     *
     * `decide()` cannot call a regression without knowing whether the lines are
     * newer than the closure, and the last occurrence lives in the evidence
     * read. That read is a Loki query per signature, so it is paid for here only
     * in the case that needs it — a signature with a closed issue and nothing
     * open — and handed to `assemble()` afterwards so it is never made twice.
     *
     * Everything else keeps the shape it had: evidence is fetched inside
     * `assemble()`, after the caps, for the signatures actually being acted on.
     */
    const evidence =
      openIssue === undefined && closedIssue !== undefined
        ? await deps.logs.evidence(signature, DEFECT_WINDOW_SECONDS)
        : undefined

    const history: DefectHistory = {
      known: knownBefore.get(signature.signature),
      openIssue,
      closedIssue,
      lastSeenAt: evidence?.lastAt ?? null,
    }

    const action = decide(history, now())

    if (action.kind === 'quiet') {
      counts.quiet++
      continue
    }

    if (action.kind === 'comment') {
      const report = await assemble(signature, history, deps, evidence)
      const said = await deps.issues.comment(action.issue.url, recurrenceComment(report))
      if (said) {
        await deps.store.commented(signature.signature)
        counts.commented++
      }
      continue
    }

    // The caps, and they are checked here rather than before the loop so that a
    // recurrence — which writes a comment and not an issue — is never withheld.
    if (counts.filed >= MAX_ISSUES_PER_RUN || filedToday + counts.filed >= MAX_ISSUES_PER_DAY) {
      counts.withheld++
      continue
    }

    const report = await assemble(signature, history, deps, evidence)
    const url = await deps.issues.create(defectIssue(report))

    if (url === null) {
      // GitHub refused. Nothing is recorded, so the next tick tries again — a row
      // claiming an issue that does not exist would silence the signature forever.
      log.warn(`could not file an issue for ${signature.signature}; it will be tried again`, {
        event: 'defects.file.failed',
        signature: signature.signature,
      })
      continue
    }

    await deps.store.filed(signature.signature, url, action.regression)
    counts.filed++
    if (action.regression) counts.regressions++

    log.info(`filed ${url} for ${signature.signature}`, {
      event: 'defects.filed',
      signature: signature.signature,
      url,
      regression: action.regression,
    })
  }

  if (counts.withheld > 0) {
    log.warn(
      `${counts.withheld} signature(s) were not filed because the cap was reached — ` +
        `${MAX_ISSUES_PER_RUN} per run, ${MAX_ISSUES_PER_DAY} per day, ${filedToday} already ` +
        'filed today. They stay in the store and will be filed on a later tick.',
      { event: 'defects.withheld', withheld: counts.withheld, filedToday },
    )
  }

  return counts
}

/**
 * Everything one issue needs.
 *
 * The evidence is fetched here rather than in the counting pass, so a quiet
 * window costs one aggregation and nothing else — and a model, where one exists,
 * is asked only about a signature that is about to be written up.
 */
async function assemble(
  signature: DefectReport['signature'],
  history: DefectHistory,
  deps: WatchDependencies,
  /**
   * The evidence, where the caller has already paid for it (`#560`).
   *
   * Appended rather than inserted, and optional, so every other call site and
   * the ordinary path are untouched: absent, this reads it exactly as before.
   */
  alreadyRead?: DefectEvidence,
): Promise<DefectReport> {
  const log = deps.log ?? silentLog
  const evidence = alreadyRead ?? (await deps.logs.evidence(signature, DEFECT_WINDOW_SECONDS))

  const lastStart =
    evidence.firstAt === null
      ? null
      : await deps.logs.lastStart(signature.service, evidence.firstAt)

  if (!deps.writer.available) return { signature, evidence, lastStart, history }

  try {
    const prose = await deps.writer.describe({
      signature: signature.signature,
      service: signature.service,
      event: signature.event,
      count: signature.count,
      samples: evidence.samples,
      lastStart,
    })
    return { signature, evidence, lastStart, history, prose }
  } catch (error) {
    /**
     * **A model that cannot answer costs sentences, never facts.** The issue is
     * filed anyway, with everything that was measured and a line saying no
     * reading was written — which is the whole reason detection is deterministic.
     */
    log.warn(`no reading was written for ${signature.signature}; filing the facts alone`, {
      event: 'defects.prose.failed',
      signature: signature.signature,
      reason: error instanceof Error ? error.message : String(error),
    })
    return { signature, evidence, lastStart, history }
  }
}
