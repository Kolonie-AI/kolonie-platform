import type { ModelCall } from '@kolonie-ai/core'
import { carryingMarker, type ClosedIssue, type KnownIssue, type NewIssue } from './github.js'
import type { DefectEvidence, LogCause, LogSignature } from './logs.js'
import { MAX_CAUSE_DEPTH } from './logs.js'
import { modelCallLine } from './triage.js'

/**
 * Turning a defect in the logs into an ordinary issue somebody can take
 * (`#407`).
 *
 * ## The failure this replaces
 *
 * The Watch Agent reads the logs once a day and matches on **one fixed title**,
 * so there is exactly one Watch Agent issue, ever, and every finding is a
 * comment on it — unrelated defects, weeks apart, on a thread that never closes.
 * Its own footer stated the consequence: *"It never closes one: whether this is
 * dealt with is a person's call, not a workflow's."* That remains right about a
 * fix. `kolonie-docs#561` adds one narrower end: fourteen days with no exact
 * matching line is a measured quiet condition the detector can settle itself.
 *
 * What it cost, measured: a `ZodError` broke `kolonie.tasks.get` for any citizen
 * holding an attempt-less report (`#404`), first appearing at 13:18:12Z, three
 * minutes after a deploy. The Watch Agent would have surfaced it at 06:00 the
 * following morning — roughly seventeen hours later, on a defect that
 * permanently blocked a citizen-facing tool.
 *
 * ## Every decision in this file is made without a model
 *
 * Whether something is new, whether it has come back, where it belongs and
 * whether the caps allow it are all arithmetic. A model is asked for one thing:
 * sentences. That is `#133`'s principle applied more strictly, and it is what
 * keeps a provider outage from blinding the Colony.
 */

/** How far back one tick looks. Two ticks of overlap, so nothing falls between them. */
export const DEFECT_WINDOW_SECONDS = 3_600

/**
 * At most this many issues in one run.
 *
 * An automaton allowed to file every half hour can flood a board faster than
 * anybody can read it, and a bad deploy produces a dozen signatures at once.
 * Three is enough to describe an incident and few enough to stay readable.
 */
export const MAX_ISSUES_PER_RUN = 3

/** And at most this many in a day, counted on the row so a restart cannot lift it. */
export const MAX_ISSUES_PER_DAY = 10

/**
 * Where a service's defects belong, and under which `area:` label.
 *
 * **Routed by the service that emitted the line**, because that is the only fact
 * the detector has that is not a guess. An unrecognised service goes to
 * `kolonie-infra`: something started a container nobody has heard of, and the
 * repository that owns the compose file is where *what is this* gets asked.
 *
 * `postgres` is the one entry worth arguing about, and it goes to the platform.
 * Every error it emits is a statement somebody's code sent — and since
 * `kolonie-infra#80` a maintainer typing at a `psql` prompt is labelled
 * `interactive` rather than `error`, so those never reach this file at all.
 */
export const SERVICE_ROUTING: Readonly<Record<string, { repository: string; area: string }>> = {
  api: { repository: 'Kolonie-AI/kolonie-platform', area: 'area:platform' },
  'verifier-runner': { repository: 'Kolonie-AI/kolonie-platform', area: 'area:platform' },
  'moderation-runner': { repository: 'Kolonie-AI/kolonie-platform', area: 'area:platform' },
  'badge-runner': { repository: 'Kolonie-AI/kolonie-platform', area: 'area:platform' },
  'support-triage-runner': { repository: 'Kolonie-AI/kolonie-platform', area: 'area:platform' },
  postgres: { repository: 'Kolonie-AI/kolonie-platform', area: 'area:platform' },
  traefik: { repository: 'Kolonie-AI/kolonie-infra', area: 'area:infra' },
  loki: { repository: 'Kolonie-AI/kolonie-infra', area: 'area:infra' },
  promtail: { repository: 'Kolonie-AI/kolonie-infra', area: 'area:infra' },
  pgadmin: { repository: 'Kolonie-AI/kolonie-infra', area: 'area:infra' },
  website: { repository: 'Kolonie-AI/kolonie-infra', area: 'area:infra' },
}

const UNROUTED = { repository: 'Kolonie-AI/kolonie-infra', area: 'area:infra' } as const

export function routeFor(service: string): { repository: string; area: string } {
  return SERVICE_ROUTING[service] ?? UNROUTED
}

/**
 * The marker that makes an issue findable by signature.
 *
 * **In the body and in the title.** The body marker is exact and is what the
 * open-issue dedupe reads; the title carries the signature because the closed
 * corpus has no body — `Issues.closed` reads a list endpoint and does not fetch
 * each issue, which is the cost that read is shaped to avoid.
 */
export function bodyMarker(signature: string): string {
  return `<!-- log-signature: ${signature} -->`
}

/** The title, which is also the closed corpus's only handle on a signature. */
export function titleFor(signature: string, summary: string): string {
  return `${signature} — ${summary}`
}

/** What the Colony already knows about a signature it has just seen again. */
export interface DefectHistory {
  /** The row, or nothing when this signature has never been seen. */
  readonly known:
    | {
        readonly issueUrl: string | null
        readonly firstSeenAt: string
        readonly lastSeenAt: string
        readonly occurrences: number
        readonly lastCommentAt: string | null
        /**
         * When this signature's issue was closed for being quiet, or `null`.
         *
         * **The one field that distinguishes a settled finding from a fixed
         * one** (`kolonie-docs#561`). A quiet close is the detector's own act
         * and it is undone by the detector: the same issue is reopened rather
         * than a second one filed, so how often a signature comes back stays
         * readable in one place.
         */
        readonly quietClosedAt: string | null
        readonly regressions: number
      }
    | undefined
  /** An open issue carrying this signature's marker, if there is one. */
  readonly openIssue: KnownIssue | undefined
  /** A closed issue whose title carries this signature, if there is one. */
  readonly closedIssue: ClosedIssue | undefined
  /**
   * The most recent line in the window, or `null` where none could be read.
   *
   * **Only ever needed against a closed issue** (`#560`), and `watch.ts` only
   * pays for it then: the evidence read is one query per signature, and asking
   * for it before every decision would spend it on the ordinary case, which is a
   * signature with no closed issue at all.
   */
  readonly lastSeenAt: string | null
}

/** What the runner should do about one signature. Decided by arithmetic alone. */
export type DefectAction =
  /** Nothing new. It has an open issue and has already been said. */
  | { readonly kind: 'quiet' }
  /** File one, because nothing open covers it. */
  | { readonly kind: 'file'; readonly regression: false }
  /** File one, because its issue was closed and the error came back. */
  | { readonly kind: 'file'; readonly regression: true; readonly closed: ClosedIssue }
  /** Say on the open issue that it happened again, and how often. */
  | { readonly kind: 'comment'; readonly issue: KnownIssue }
  /** Bring back the issue this detector closed for being quiet. */
  | { readonly kind: 'reopen'; readonly issue: ClosedIssue }

/**
 * How long a signature must be silent before its issue is closed
 * (`kolonie-docs#561`, frozen decision 1).
 *
 * **Fourteen consecutive days, measured against the live log source and never
 * against this row.** The store says when the Colony last recorded the
 * signature; the log source says whether anything matched since. Only the
 * second can distinguish *nothing happened* from *nothing was read*, which is
 * why the count is taken rather than inferred.
 */
export const QUIET_CLOSE_DAYS = 14

export const QUIET_CLOSE_WINDOW_SECONDS = QUIET_CLOSE_DAYS * 86_400

/** At most one recurrence note a day, per signature. See {@link decide}. */
export const COMMENT_INTERVAL_MS = 86_400_000

/**
 * What to do about one signature.
 *
 * **A returning error is a regression and gets its own issue.** A comment on a
 * closed issue reaches nobody: the issue is off every board, out of every
 * notification anybody still reads, and the thing that is wrong is wrong again
 * now. The new issue links the closed one and says the signature came back.
 *
 * **A defect that is still failing is said once a day and not once a tick.**
 * Nothing has been fixed yet, so it is in every window — and a runner that
 * commented on each would put forty-eight notes a day on one issue, which is the
 * eternal issue this whole change exists to end, moved one level down. Silence
 * on an issue between those notes is not the detector losing interest; it is the
 * detector having nothing new to say.
 *
 * **A closed issue is only a regression if the lines are newer than the
 * closure** (`#560`), and this was missing one term for as long as the file
 * existed. The window is half an hour wide and a fix is deployed *before* the
 * issue is closed, so the window that contains the closure almost always still
 * holds pre-fix lines. `#526` closed at `23:20:43Z`; `#557` was filed at
 * `23:21:41Z` — **fifty-eight seconds later** — carrying lines whose last
 * occurrence was `22:50:26Z`, and saying *"This came back"*. Nothing had.
 *
 * The cost of getting it wrong is not one bad issue. It arrives labelled `bug`
 * with a *this came back* header that the next reader has to disprove by hand,
 * it happens **at the moment somebody has just fixed something**, and done twice
 * it teaches people to discount the header on the occasions it is true.
 */
export function decide(history: DefectHistory, now: number = Date.now()): DefectAction {
  if (history.openIssue !== undefined) {
    const last = history.known?.lastCommentAt
    if (last !== null && last !== undefined && now - Date.parse(last) < COMMENT_INTERVAL_MS) {
      return { kind: 'quiet' }
    }
    return { kind: 'comment', issue: history.openIssue }
  }

  /**
   * **A quiet close is this detector's own act, and it is undone rather than
   * re-filed** (`kolonie-docs#561`, frozen decision 1). The stored URL is the
   * durable identity: GitHub's closed corpus is one page and an older quiet
   * close eventually falls off it, but that must not turn a recurrence into a
   * second issue. A closure by anybody else writes no marker and keeps the
   * regression path below, which is what `#560` settled.
   */
  if (history.known?.quietClosedAt != null && history.known.issueUrl !== null) {
    return {
      kind: 'reopen',
      issue:
        history.closedIssue ??
        ({
          url: history.known.issueUrl,
          title: '',
          body: '',
          reason: null,
          closedAt: history.known.quietClosedAt,
        } satisfies ClosedIssue),
    }
  }

  if (history.closedIssue !== undefined) {
    /**
     * **Both unknowns fall back to the old behaviour, which is to file.**
     * `closed_at` is nullable in GitHub's API and the evidence read can come
     * back empty, and neither is evidence that nothing came back — it is the
     * absence of evidence either way. Filing a regression that turns out to be
     * stale costs a reader five minutes; staying quiet about one that is real
     * costs the Colony a defect nobody is told about.
     */
    const closedAt = history.closedIssue.closedAt
    const lastSeenAt = history.lastSeenAt
    const stale =
      closedAt !== null &&
      lastSeenAt !== null &&
      Number.isFinite(Date.parse(closedAt)) &&
      Number.isFinite(Date.parse(lastSeenAt)) &&
      Date.parse(lastSeenAt) <= Date.parse(closedAt)

    // These are the lines the fix was for. Nobody needs telling about them.
    if (stale) return { kind: 'quiet' }

    return { kind: 'file', regression: true, closed: history.closedIssue }
  }

  return { kind: 'file', regression: false }
}

/**
 * The one place a priority is set, and it sets exactly one.
 *
 * **`p1` only for a signature the Colony has never seen before**, because that
 * is the class where time matters and the cause is nearly always the deploy that
 * preceded it — `#404` again. Anything else carries no priority at all:
 * `AGENTS.md` §5 class 6 keeps priority a human's call, and a machine that
 * graded every finding would be making that call ten times a day.
 */
export function labelsFor(input: {
  readonly area: string
  readonly firstSeen: boolean
}): readonly string[] {
  return input.firstSeen ? ['bug', 'p1', input.area, PROVENANCE] : ['bug', input.area, PROVENANCE]
}

/**
 * Where this issue came from, which decides how carefully it is read (`#686`).
 *
 * **`from:watcher`, because a log signature is a measurement and not a
 * judgement.** Something queried the logs and a threshold answered; nobody read
 * it and decided it mattered. That is the opposite claim from `from:citizen` on
 * the same runner's other path — untrusted text a person wrote — and a reader
 * who cannot tell them apart is paying the difference on every issue.
 *
 * **It is set here rather than left to the board to infer.** The author of these
 * is a machine account, and inferring *watcher* from *not a human* would also
 * label the maintainer agent's issues, which are judgements. Provenance is a
 * fact the creating path knows and nothing downstream can recover.
 */
const PROVENANCE = 'from:watcher'

/** Everything one issue needs. Assembled deterministically; the prose is separate. */
export interface DefectReport {
  readonly signature: LogSignature
  readonly evidence: DefectEvidence
  /** When the emitting service last started before the first occurrence, or `null`. */
  readonly lastStart: string | null
  readonly history: DefectHistory
  /** What the model wrote, or nothing when it could not be asked. */
  readonly prose?:
    { readonly summary: string; readonly reading: string; readonly call?: ModelCall } | undefined
}

/**
 * The body, evidence first and judgement last.
 *
 * **That order is a requirement rather than a preference**, inherited from
 * `#133`: whoever opens this should be able to disagree with the model without
 * re-running a single query. Which is also why the body is complete without any
 * model output at all — an unavailable model costs the reader sentences, never
 * facts.
 */
export function defectBody(report: DefectReport): string {
  const { signature, evidence, history } = report
  const lines: string[] = []

  lines.push(bodyMarker(signature.signature))
  lines.push('')
  lines.push('## What is failing')
  lines.push('')
  lines.push(`\`${signature.service}\` is logging \`${signature.event}\` at level \`error\`.`)
  lines.push('')
  lines.push('| | |')
  lines.push('|---|---|')
  lines.push(`| Signature | \`${signature.signature}\` |`)
  lines.push(`| Lines in this window | ${signature.count} |`)
  lines.push(`| First occurrence seen | ${evidence.firstAt ?? 'not recorded'} |`)
  lines.push(`| Last occurrence seen | ${evidence.lastAt ?? 'not recorded'} |`)
  lines.push(
    `| The service last started | ${report.lastStart ?? 'no start found in the day before it'} |`,
  )
  if (history.known !== undefined) {
    lines.push(`| First seen by the Colony | ${history.known.firstSeenAt} |`)
    lines.push(`| Lines accounted for, ever | ${history.known.occurrences} |`)
  }
  lines.push('')

  if (report.lastStart !== null && evidence.firstAt !== null) {
    const gap = Date.parse(evidence.firstAt) - Date.parse(report.lastStart)
    if (Number.isFinite(gap) && gap >= 0) {
      lines.push(
        `**It started ${describeGap(gap)} after \`${signature.service}\` did.** That is not a ` +
          'proof of cause, and it is the first thing worth checking.',
      )
      lines.push('')
    }
  }

  if (evidence.samples.length > 0) {
    lines.push('## Lines')
    lines.push('')
    lines.push('```')
    for (const sample of evidence.samples) lines.push(sample)
    lines.push('```')
    lines.push('')
  }

  lines.push(...causeSection(evidence.causes))

  lines.push('## What the model makes of it')
  lines.push('')
  lines.push(
    report.prose === undefined
      ? '_No reading was written — the model was not called or did not answer. Everything ' +
          'above was measured rather than judged, and stands on its own._'
      : report.prose.reading,
  )
  // The accounting line only where there is accounting: a provider may answer
  // correctly and report no usage (`#716`), and the reading it wrote is worth
  // printing either way.
  if (report.prose?.call !== undefined) {
    lines.push('')
    lines.push(modelCallLine(report.prose.call))
  }
  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push(
    'Filed by the log detector in `apps/support-triage-runner`, which reads errors out of Loki ' +
      'every half hour and files one issue per signature (`#407`). It closes only after **14 ' +
      'consecutive quiet days measured against this exact signature**; that says the condition ' +
      'ended, not that a person judged the defect fixed. A returning line reopens this same ' +
      'identity. The issue is in Inbox rather than Ready because a machine’s finding is a ' +
      'finding, not a specification.',
  )

  return lines.join('\n')
}

/**
 * The cause chain, in its own section, in full (`#898`).
 *
 * **Independent of how long `message` is**, which is the whole of the change.
 * The sample above is truncated and always will be — Drizzle puts the entire
 * statement in `message`, so a longer budget buys a longer prefix of SQL and the
 * `cause` is still last. `#895` was filed twice from lines cut at the same
 * column, and the model judging them wrote that it could not tell data from
 * schema from connectivity. `42809` — *op ANY/ALL (array) requires array on
 * right side* — was on both lines and in neither issue.
 *
 * **Nothing here is a section when there is nothing to put in it.** An error
 * without a cause is most errors, and it files exactly what it filed before: no
 * heading, no empty table, no `undefined`.
 */
function causeSection(causes: readonly LogCause[]): readonly string[] {
  if (causes.length === 0) return []

  const cell = (value: string | null, code: boolean): string =>
    value === null
      ? '—'
      : code
        ? `\`${value}\``
        : value.replaceAll('|', '\\|').replaceAll('\n', ' ')

  const lines = [
    '## The cause',
    '',
    '**This is the field that names the failure**, and it is below the truncation ' +
      'in the line above rather than missing from it.',
    '',
    '| Depth | Name | Code | Message |',
    '|---|---|---|---|',
  ]
  causes.forEach((cause, index) => {
    lines.push(
      `| ${index + 1} | ${cell(cause.name, true)} | ${cell(cause.code, true)} | ${cell(cause.message, false)} |`,
    )
  })
  lines.push('')
  lines.push(
    `Followed to ${MAX_CAUSE_DEPTH} link(s), which is where the logger stops serialising one. ` +
      'Only `name`, `code` and `message` are read: `detail`, `where`, `query` and `parameters` ' +
      'are where a driver puts row values and bound parameters, and this issue is public.',
  )
  lines.push('')

  return lines
}

/** What a comment on a recurrence says. Short, and it says how often. */
export function recurrenceComment(report: DefectReport): string {
  const { signature, evidence } = report

  return [
    `\`${signature.signature}\` happened again: **${signature.count}** line(s) in the last hour, ` +
      `most recently at ${evidence.lastAt ?? 'an unrecorded moment'}.`,
    '',
    report.history.known === undefined
      ? ''
      : `That is **${report.history.known.occurrences}** lines this signature has accounted for ` +
        `since ${report.history.known.firstSeenAt}.`,
    '',
    'Nothing about this issue has changed. This is the detector saying the thing it describes ' +
      'is still happening, so that a quiet issue and a fixed one are not the same thing.',
  ]
    .filter((line) => line !== '')
    .join('\n')
}

/** The issue to file, assembled from what was measured plus whatever prose there is. */
export function defectIssue(report: DefectReport): NewIssue {
  const route = routeFor(report.signature.service)
  const summary =
    report.prose?.summary ??
    `\`${report.signature.event}\` is failing in \`${report.signature.service}\``

  const regression = report.history.closedIssue

  return {
    repository: route.repository,
    title: titleFor(report.signature.signature, summary),
    body:
      regression === undefined
        ? defectBody(report)
        : [
            defectBody(report),
            '',
            '## This came back',
            '',
            `An issue for this exact signature was closed: ${regression.url} — *${regression.title}*` +
              (regression.reason === null ? '' : ` (closed as \`${regression.reason}\`)`),
            '',
            'A returning error is a regression and gets its own issue rather than a comment on a ' +
              'closed one, which would reach nobody.',
          ].join('\n'),
    labels: labelsFor({ area: route.area, firstSeen: report.history.known === undefined }),
  }
}

/**
 * Find an open issue carrying this signature's marker.
 *
 * The marker is matched, never the title — a title can be edited by whoever
 * picks the issue up, and an issue that stopped matching would be filed a second
 * time the same afternoon.
 *
 * **On the first line rather than anywhere in the body**, which is the half that
 * was missing: an issue quoting a signature while discussing it would otherwise
 * be adopted as this detector's own. {@link carryingMarker} has the case.
 */
export function openIssueFor(
  signature: string,
  issues: readonly KnownIssue[],
): KnownIssue | undefined {
  return carryingMarker(issues, bodyMarker(signature))
}

/**
 * Find a closed issue for this signature.
 *
 * **By title prefix, because the closed corpus carries no body.** That read is a
 * list endpoint by design — fetching each issue's body would be a call per
 * closed issue, which is the cost `Issues.closed` exists to avoid — so the
 * signature has to be in the title to survive into it. It is, and
 * {@link titleFor} is why.
 */
export function closedIssueFor(
  signature: string,
  issues: readonly ClosedIssue[],
): ClosedIssue | undefined {
  return issues.find((issue) => issue.title.startsWith(`${signature} — `))
}

function describeGap(milliseconds: number): string {
  const minutes = Math.round(milliseconds / 60_000)
  if (minutes < 1) return 'less than a minute'
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`
  const hours = Math.round(minutes / 60)
  return `${hours} hour${hours === 1 ? '' : 's'}`
}
