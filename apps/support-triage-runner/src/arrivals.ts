import type { UnactedArrivalReport } from '@kolonie-ai/db'
import { carryingMarker, type Issues, type KnownIssue } from './github.js'

/**
 * The pass that reads what agents said on their way in and did not get through
 * (`#1009`, `#1026`).
 *
 * ## What makes it different from every other pass in this runner
 *
 * **There is nobody to answer.** A ticket has an author the Colony can reply to,
 * ban, or delete with; an arrival report has none, which is the entire point of
 * the channel — it is open to callers with no credential because the population
 * it exists to hear from is the one that never got a credential. So nothing here
 * routes anything back, and there is no path by which it could.
 *
 * **The unit is the count and not the report.** One agent that stopped at
 * confirmation had a bad afternoon; eleven that stopped at the same step on the
 * same runtime in a fortnight is a defect in the door. Reports are grouped before
 * anything is decided, and a group under {@link ARRIVAL_THRESHOLD} is left where
 * it is to grow or to age out — evidence rather than a trigger.
 *
 * **Nothing it emits touches the fingerprint.** The digest is the only join the
 * table has and the runner never selects it; what reaches an issue is a count of
 * how many reports in the group were followed by a registration from the same
 * egress, which is a measurement of the door and names nobody.
 *
 * **No model reads any of this.** Every other watcher in this process either
 * quotes a citizen the Colony can identify or quotes its own logs. This one
 * quotes strangers, and a stranger's prose that reached a prompt would be
 * somebody outside the Colony writing into the Colony's own reasoning. The
 * decision here is arithmetic and the body is a template.
 */

/** Where the alarm is filed. The door is the platform's, and so is this pass. */
export const ARRIVAL_REPOSITORY = 'Kolonie-AI/kolonie-platform'

/**
 * How many reports of the same shape make a finding.
 *
 * **Three**, and the issue that asked for this named why it cannot be one: a
 * single report is one agent's afternoon, and an issue per report would be a
 * queue of anecdotes filed by a machine against a channel anybody can write to.
 * Two is a coincidence that happens on any given fortnight. Three independent
 * strangers stopping at the same step on the same runtime is the smallest number
 * that is cheaper to read than to ignore.
 */
export const ARRIVAL_THRESHOLD = 3

/**
 * How long a report can wait for company.
 *
 * **A fortnight.** A group only forms among reports that are near each other in
 * time, so the window is what makes the count mean *this is happening now*
 * rather than *this happened at some point since the channel opened*. It is also
 * what stops the unacted queue growing without bound: a report that never found
 * two others inside a fortnight is let go, so the runner's read stays the recent
 * traffic rather than filling with years of singletons that starve it.
 *
 * Letting go loses nothing. The row stays exactly as it was written and
 * `recentArrivalReports` still answers with it — what ends is only this pass's
 * interest in filing about it.
 */
export const ARRIVAL_WINDOW_DAYS = 14

/** How many unacted reports one pass reads. Well above a fortnight's traffic. */
export const ARRIVAL_READ_LIMIT = 500

/** How many of a group's reports are quoted in the issue it files. */
const QUOTED_PER_CLUSTER = 3

const DAY_MS = 86_400_000

/**
 * One classifier value, as it is allowed to appear in a title, a marker or a
 * table.
 *
 * **The runtime is a stranger's free text and the step is very nearly one.**
 * `runtime` is whatever an uncredentialled caller wrote in a body, up to 64
 * characters of anything; `step` is validated against a closed list on the way in
 * but is stored as `varchar`, so a value that predates a change to that list
 * would arrive here unrecognised. Both are grouped on, both go into an HTML
 * comment marker, and a marker is how this pass finds its own issue again — so a
 * value that can contain `-->` is a value that can make one issue impersonate
 * another.
 *
 * Folding to a conservative token settles all of it at once: what survives is
 * lower-case letters, digits, dots and dashes, capped at 32, and anything that
 * folds away to nothing reads as `unstated`. Two runtimes that differ only in
 * punctuation land in one group, which is the right answer anyway — nobody
 * wanting to know whether the door is broken cares that one caller wrote
 * `Node.js 22` and another wrote `node.js-22`.
 */
export function arrivalKey(value: string): string {
  const folded = value
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32)
  return folded === '' ? 'unstated' : folded
}

/**
 * Whether a report states a discrepancy at all.
 *
 * The channel asks for two things — what the caller expected and what it got
 * instead — and the pair is the whole observation. A report whose two halves are
 * the same string says *I expected this and got this*, which describes nothing
 * that happened and nothing to look at. It is not a bad report; it is not a
 * report, and no number of them is evidence about a door.
 *
 * **This is not a judgement on the prose, which is the one thing this pass must
 * never make.** Nothing here reads what the caller wrote, weighs it, or decides
 * whether it sounds serious; it compares two fields the schema itself declares
 * to be opposites. A stranger describing a real failure badly is kept and
 * counted exactly as before — only a caller that filled both fields with the
 * same value is set aside, and the comparison would give the same answer if the
 * value were a paragraph.
 *
 * Case and whitespace are folded, because `X` and `x ` are the same answer given
 * twice and a group of three should not turn on which one a caller typed.
 *
 * Found by `#1221`, where the entire corpus of the table was three daily calls
 * carrying `x` in every field — a prober exercising the endpoint rather than an
 * agent that failed at the door. The threshold caught it in three days and filed
 * an issue against a door that was never broken.
 */
export function statesNoDiscrepancy(
  report: Pick<UnactedArrivalReport, 'expected' | 'actual'>,
): boolean {
  const fold = (value: string) => value.replace(/\s+/g, ' ').trim().toLowerCase()
  return fold(report.expected) === fold(report.actual)
}

/** A group of reports that say the same thing about the same door. */
export interface ArrivalCluster {
  /** The step, folded. What the reporters said they were doing. */
  readonly step: string
  /** The runtime, folded. */
  readonly runtime: string
  readonly count: number
  /** How many of them were followed by a registration from the same egress. */
  readonly arrivedLater: number
  /** When the group starts and ends, from the Colony's clock on each row. */
  readonly since: string
  readonly until: string
  /** Every report in the group, so the pass can mark exactly what it acted on. */
  readonly ids: readonly string[]
  /** The first few, as the issue quotes them. */
  readonly quoted: readonly UnactedArrivalReport[]
}

/** What one pass found in the queue it read. */
export interface ArrivalReading {
  /** Groups at or above the threshold, largest first. */
  readonly clusters: readonly ArrivalCluster[]
  /** Reports inside the window whose group is still too small to be a finding. */
  readonly waiting: number
  /** Reports that sat out the whole window without finding company. */
  readonly aged: readonly string[]
  /**
   * Reports that stated no discrepancy — see {@link statesNoDiscrepancy}. Set
   * aside before grouping and finished with in the same breath as {@link aged},
   * because unlike a lonely report they cannot become a finding by waiting.
   */
  readonly contentless: readonly string[]
}

function clusterOf(reports: readonly UnactedArrivalReport[]): ArrivalCluster {
  const first = reports[0]
  if (first === undefined) throw new Error('a cluster cannot be empty')

  return {
    step: arrivalKey(first.step),
    runtime: arrivalKey(first.runtime),
    count: reports.length,
    arrivedLater: reports.filter((report) => report.arrivedLater).length,
    since: first.createdAt,
    until: reports[reports.length - 1]?.createdAt ?? first.createdAt,
    ids: reports.map((report) => report.id),
    quoted: reports.slice(0, QUOTED_PER_CLUSTER),
  }
}

/**
 * Group the queue, and say what fell out of it. Arithmetic alone.
 *
 * **Grouped on step *and* runtime**, which is what the issue asked for and is the
 * distinction that makes a finding actionable: the same step failing across every
 * runtime is the Colony's door, and one failing on one runtime is that runtime
 * meeting the door. A group keyed on the step alone would report the first as the
 * second forever.
 *
 * Reports arrive oldest first and stay in that order inside a group, so `since`
 * and `until` are the ends of it and the quoted rows are the earliest — the ones
 * whose author is longest gone and least likely to have found their own way past.
 */
export function clusterArrivals(
  reports: readonly UnactedArrivalReport[],
  now: number,
): ArrivalReading {
  const cutoff = now - ARRIVAL_WINDOW_DAYS * DAY_MS
  const aged: string[] = []
  const contentless: string[] = []
  const groups = new Map<string, UnactedArrivalReport[]>()

  for (const report of reports) {
    /**
     * Before the window and not after it: a report that describes nothing is
     * not a finding at any age, and counting it as aged would say it waited for
     * company it could have been joined by.
     */
    if (statesNoDiscrepancy(report)) {
      contentless.push(report.id)
      continue
    }
    if (Date.parse(report.createdAt) < cutoff) {
      aged.push(report.id)
      continue
    }
    const key = `${arrivalKey(report.step)}\u0000${arrivalKey(report.runtime)}`
    const group = groups.get(key)
    if (group === undefined) groups.set(key, [report])
    else group.push(report)
  }

  const clusters: ArrivalCluster[] = []
  let waiting = 0
  for (const group of groups.values()) {
    if (group.length < ARRIVAL_THRESHOLD) waiting += group.length
    else clusters.push(clusterOf(group))
  }
  clusters.sort((left, right) => right.count - left.count)

  return { clusters, waiting, aged, contentless }
}

/** The marker that makes this group's issue findable again, on line one. */
export function arrivalMarker(cluster: Pick<ArrivalCluster, 'step' | 'runtime'>): string {
  return `<!-- arrival-cluster: step=${cluster.step} runtime=${cluster.runtime} -->`
}

/**
 * The title, and it deliberately carries no number.
 *
 * A count in a title is wrong the moment the next report lands, and this pass
 * comments rather than revises — so the number lives in the body and in the
 * comments under it, where each one is true about the day it was written.
 */
export function arrivalTitle(cluster: Pick<ArrivalCluster, 'step' | 'runtime'>): string {
  return `Agents are stopping at ${cluster.step} on ${cluster.runtime} and reporting it`
}

/**
 * A stranger's sentence, as a table cell is allowed to hold it.
 *
 * Whitespace collapsed and cut at 200 characters, because this is evidence of a
 * shape rather than a document; then backticks, pipes and angle brackets
 * removed, because each of the three can turn one cell into something the rest of
 * the body is not — a pipe ends a column, a backtick ends the code span, and an
 * angle bracket is what an HTML comment is made of. The marker on line one is how
 * this pass recognises its own issues, and nothing a stranger typed should be
 * able to write one.
 */
export function quoted(text: string): string {
  const flattened = text
    .replace(/\s+/g, ' ')
    .replace(/[`|<>]/g, '')
    .trim()
    .slice(0, 200)
  return flattened === '' ? '*empty*' : `\`${flattened}\``
}

function quotedRow(report: UnactedArrivalReport): string {
  return `| ${report.createdAt} | ${quoted(report.expected)} | ${quoted(report.actual)} |`
}

/** The finding, as the person who has to act on it reads it. */
export function arrivalIssueBody(cluster: ArrivalCluster): string {
  return [
    arrivalMarker(cluster),
    '',
    `**${cluster.count} agents reported stopping at \`${cluster.step}\` on \`${cluster.runtime}\`** ` +
      `between ${cluster.since} and ${cluster.until}.`,
    '',
    'None of them was a citizen when they wrote it. `POST /v1/arrival-reports` and ' +
      '`kolonie.arrival.report` take no credential on purpose (`#1009`): the agents that fail at ' +
      'the door are exactly the ones that cannot open a ticket about it, so before that channel ' +
      'existed the Colony’s evidence about arriving came entirely from arrivals that succeeded.',
    '',
    `**${cluster.arrivedLater} of the ${cluster.count} were followed by a registration from the ` +
      'same egress.** That is the whole of what the fingerprint is used for here — it says ' +
      'whether this door was eventually got through, and nothing else. The remaining ' +
      `${cluster.count - cluster.arrivedLater} are the population that was invisible.`,
    '',
    '| Reported | Expected | Got instead |',
    '|---|---|---|',
    ...cluster.quoted.map(quotedRow),
    ...(cluster.count > cluster.quoted.length
      ? ['', `…and ${cluster.count - cluster.quoted.length} more with the same step and runtime.`]
      : []),
    '',
    '## What to read it as',
    '',
    '**The count is the evidence and the prose is not.** Every word in that table was written by ' +
      'somebody the Colony cannot identify, into a channel anybody can reach, and none of it is ' +
      'checked against anything. One such row proves nothing whatever. What is hard to fake and ' +
      'expensive to ignore is that this many independent callers described the same step failing ' +
      'the same way inside a fortnight — so treat the rows as a hint about where to look and the ' +
      'number as the reason to look.',
    '',
    '**Nobody can be answered.** A report carries no agent, so there is no reply, no ticket and ' +
      'no one to tell when this is fixed. The reporters are gone. What closes this is the door ' +
      'working, verified by the reports stopping.',
    '',
    '## Where to act on it',
    '',
    'The route is `apps/api/src/routes/arrival-reports.ts` and the tool is ' +
      '`apps/api/src/mcp/tools/arrival-reports.ts`; the steps a report can name are ' +
      '`ArrivalStepSchema` in `packages/core`. If the step is `registering` or `checking-a-name`, ' +
      'the answer is usually in `apps/api/src/routes/register.ts` or in what the onboarding ' +
      'skill in `kolonie-docs` says about it — a door that works but is described wrongly fails ' +
      'in exactly this shape, and reads from outside as the door being broken.',
    '',
    '---',
    '',
    '**Filed by a machine**, by the arrival watcher in `apps/support-triage-runner` (`#1026`). ' +
      'Every report counted here is marked in the database as counted, so none of them is ever ' +
      'reported again: a later comment on this issue is new reports and never the same ones ' +
      `again. A group is filed at ${ARRIVAL_THRESHOLD} reports inside ${ARRIVAL_WINDOW_DAYS} ` +
      'days, and this issue is not closed by the watcher — closing it is a person saying the ' +
      'door is fixed.',
  ].join('\n')
}

/** What it says when more of the same arrive under an open issue. */
export function arrivalFollowUpComment(cluster: ArrivalCluster): string {
  return [
    `**${cluster.count} more agents reported stopping at \`${cluster.step}\` on ` +
      `\`${cluster.runtime}\`**, between ${cluster.since} and ${cluster.until}. These are new ` +
      'reports rather than the ones above counted again — every report is marked once.',
    '',
    `${cluster.arrivedLater} of them were followed by a registration from the same egress.`,
    '',
    '| Reported | Expected | Got instead |',
    '|---|---|---|',
    ...cluster.quoted.map(quotedRow),
    ...(cluster.count > cluster.quoted.length
      ? ['', `…and ${cluster.count - cluster.quoted.length} more.`]
      : []),
  ].join('\n')
}

/** The open issue for this group, if there is one. First line only — see {@link carryingMarker}. */
export function openArrivalIssue(
  issues: readonly KnownIssue[],
  cluster: Pick<ArrivalCluster, 'step' | 'runtime'>,
): KnownIssue | undefined {
  return carryingMarker(issues, arrivalMarker(cluster))
}

export interface ArrivalWatchDependencies {
  readonly issues: Issues
  /** The reports nothing has been done about, oldest first. */
  unread(): Promise<readonly UnactedArrivalReport[]>
  /** Mark these reports as counted into that issue. */
  actedOn(input: { readonly ids: readonly string[]; readonly issueUrl: string }): Promise<number>
  /** Mark these reports as finished with, having never become a finding. */
  letGo(ids: readonly string[]): Promise<number>
}

export interface ArrivalWatchOutcome {
  /** Groups that got a new issue. */
  readonly filed: number
  /** Groups that got a comment on one that was already open. */
  readonly commented: number
  /** Reports marked as counted into an issue. */
  readonly marked: number
  /** Reports left in the queue because their group is still too small. */
  readonly waiting: number
  /**
   * Reports finished with without becoming a finding: the ones that aged out of
   * the window, and the ones that stated no discrepancy to begin with.
   */
  readonly letGo: number
  /** How many of {@link letGo} stated no discrepancy — see {@link statesNoDiscrepancy}. */
  readonly contentless: number
  /** Set when the pass did nothing because a seam could not be read. */
  readonly skipped?: 'no-app' | 'unreadable'
}

const NOTHING: ArrivalWatchOutcome = {
  filed: 0,
  commented: 0,
  marked: 0,
  waiting: 0,
  letGo: 0,
  contentless: 0,
}

/**
 * One pass of the arrival watcher.
 *
 * **Nothing is marked before the issue exists.** The order is read, decide, file,
 * then mark exactly the reports that reached that issue — so a process that dies
 * between the two leaves its reports unmarked and files again next pass, which
 * the first-line marker turns into a comment on the issue it already filed. The
 * other order loses reports silently, and a report cannot be written twice: its
 * author is not coming back.
 *
 * **It does nothing at all when it cannot read GitHub**, on the rule the rest of
 * this runner already follows: an empty corpus and an unreadable one are
 * indistinguishable, and filing against that opens a second issue for a group
 * that already has one. Ageing out waits for the same pass, because a report let
 * go during an outage is one that was never given its chance to be filed.
 */
export async function watchArrivals(
  deps: ArrivalWatchDependencies,
  now: number = Date.now(),
): Promise<ArrivalWatchOutcome> {
  if (!deps.issues.available) return { ...NOTHING, skipped: 'no-app' }

  const corpus = await deps.issues.open()
  if (corpus.unreadable.includes(ARRIVAL_REPOSITORY)) return { ...NOTHING, skipped: 'unreadable' }

  const reading = clusterArrivals(await deps.unread(), now)

  let filed = 0
  let commented = 0
  let marked = 0

  for (const cluster of reading.clusters) {
    const open = openArrivalIssue(corpus.issues, cluster)

    if (open === undefined) {
      const url = await deps.issues.create({
        repository: ARRIVAL_REPOSITORY,
        title: arrivalTitle(cluster),
        body: arrivalIssueBody(cluster),
        /**
         * `from:watcher` because a threshold measured this and nobody read it and
         * decided it mattered — the same claim `defects.ts` makes about a log
         * signature, and the honest one here for the stronger reason that the
         * material is a stranger's.
         */
        labels: ['from:watcher', 'area:platform', 'p2'],
      })
      /** GitHub refused: nothing is marked, so the group is filed again next pass. */
      if (url === null) continue
      filed += 1
      marked += await deps.actedOn({ ids: cluster.ids, issueUrl: url })
      continue
    }

    await deps.issues.comment(open.url, arrivalFollowUpComment(cluster))
    commented += 1
    marked += await deps.actedOn({ ids: cluster.ids, issueUrl: open.url })
  }

  const letGo = await deps.letGo([...reading.aged, ...reading.contentless])

  return {
    filed,
    commented,
    marked,
    waiting: reading.waiting,
    letGo,
    contentless: reading.contentless.length,
  }
}
