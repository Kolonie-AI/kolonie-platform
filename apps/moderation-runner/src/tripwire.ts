import {
  CHANGE_DISTINCT_REPORTERS,
  CHANGE_STABILITY_ATTEMPTS,
  type ProviderChange,
} from '@kolonie-ai/db'
import type { TaskId } from '@kolonie-ai/core'
import type { Log } from './loop.js'

/**
 * What the Colony does when it concludes the world moved under a task (#115).
 *
 * **Why it needs to be fast rather than merely eventual.** The briefing is
 * regenerated on a tick ten times slower than the moderation poll, which is
 * correct for the ordinary case — a task collecting two hundred reports should
 * cost one synthesis, not two hundred. It is exactly wrong for this case, where
 * the value of the update decays by the hour and every agent arriving in the
 * meantime is sent at the old wall with the old advice.
 *
 * **Why it opens an issue.** A provider change is usually work: the task's
 * instructions, its hints, sometimes its verifier. `AGENTS.md` §6 step 7 is
 * explicit that a finding which would otherwise have to be rediscovered belongs
 * in an issue *now*. This is that, automated.
 */
export interface Tripwire {
  /** Record the conclusion: demote what is no longer supported, start the cooldown. */
  record(taskId: TaskId): Promise<void>
  /** Rewrite the briefing now rather than on the slow tick. */
  resynthesise(taskId: TaskId): Promise<void>
  issues: IssueOpener
}

/**
 * The marker a finding puts on the first line of its body, so that the next pass
 * can find the issue it already filed (`#1161`).
 *
 * **On the first line and nowhere else**, which is the rule
 * `apps/support-triage-runner/src/github.ts` learnt the expensive way: `#946` was
 * written by hand *about* a watcher and quoted a marker inside a code fence, and
 * the watcher adopted it as its own alarm and rewrote a person's issue twelve
 * minutes after they filed it. Every finding here emits its marker as line one
 * and nothing else does, so line one is the question worth asking.
 *
 * The slug carries the id for a finding that is one-per-something, because the
 * lookup has to distinguish two provider changes on two tasks. A finding with
 * exactly one instance — there are none here yet — would pass a bare name.
 */
export function watchMarker(slug: string): string {
  return `<!-- watch-finding: ${slug} -->`
}

/** The first line of a body, with the carriage return GitHub sometimes leaves on. */
export function firstLine(body: string): string {
  const end = body.indexOf('\n')
  return (end === -1 ? body : body.slice(0, end)).trim()
}

/** An issue a finding of this runner's already has, and whether it is still open. */
export interface WatchedIssue {
  readonly url: string
  readonly open: boolean
}

/**
 * Where an automated finding goes.
 *
 * A seam rather than a GitHub client, for the reason every other outside
 * dependency here is one: the decision about *what to write* is testable without
 * a token, and a runner with no token degrades rather than stops — the same rule
 * the model key follows.
 */
export interface IssueOpener {
  /**
   * The issue carrying this marker on its first line, open **or closed**.
   *
   * **Closed is half the point** (`#1161`). Asking only whether something is
   * open answers *no* the moment a maintainer closes an issue about a condition
   * that has not gone away, and the next pass files a second copy: `#784` and
   * `#1047` are that, four days apart with identical bodies, and `#727`/`#867`
   * are the same shape in the other runner.
   *
   * Answers `null` when nothing matches **and when the lookup itself failed** —
   * the caller cannot tell those apart and should not: see {@link githubIssues}.
   */
  find(marker: string): Promise<WatchedIssue | null>
  open(input: { readonly title: string; readonly body: string }): Promise<string | null>
  /** Say something more on an issue that already exists. */
  comment(url: string, body: string): Promise<boolean>
  /** Reopen one that was closed while its condition still held. */
  reopen(url: string): Promise<boolean>
}

/**
 * What kind of thing a finding is, which is what decides whether a closed issue
 * about it may be reopened.
 *
 * **`standing` — the condition holds until somebody changes something.** A quest
 * held short of publication is held until the audit variables are set; a provider
 * change is a wall every arriving citizen still walks into. Closing one of these
 * while it still holds was premature, and the honest response to seeing it again
 * is to reopen the issue rather than to file a second one.
 *
 * **`event` — it happened once.** A steward pulled the lever; a red line was
 * upheld on one submission. Closing that issue is a maintainer saying *read*, and
 * reopening it would be the runner arguing with them about a fact neither of them
 * disputes. These carry a marker anyway, because the marker is also what stops a
 * second copy being filed for the same event.
 */
export type FindingKind = 'standing' | 'event'

/** One automated finding, ready to be filed or matched against what is already there. */
export interface Finding {
  readonly marker: string
  readonly title: string
  /** Without the marker: {@link fileFinding} puts it on line one. */
  readonly body: string
  readonly kind: FindingKind
  /**
   * What to say on an issue that is already open, if anything.
   *
   * **Absent means say nothing, and that is the default on purpose.** A pass that
   * re-measures the same standing condition every hour has nothing new to report,
   * and `debt.ts` in the other runner already names what happens when one writes
   * a comment anyway: *"forty-eight lines a day aimed at a maintainer is `#231`'s
   * wallpaper failure."* A recurrence line belongs here only where seeing the
   * finding again is a distinct event rather than the same measurement repeated.
   */
  readonly recurrence?: string
  /** Anything else the log line about this finding should carry — an id, a count. */
  readonly fields?: Readonly<Record<string, unknown>>
}

/** What {@link fileFinding} did about a finding. */
export interface FilingOutcome {
  readonly action: 'opened' | 'commented' | 'reopened' | 'quiet'
  readonly url: string | null
}

/**
 * File one finding: open an issue, or add to the one that is already there.
 *
 * **The one place all four of this runner's findings go through** (`#1161`).
 * Before it, each of them searched GitHub for its own id in a title, which
 * answered *nothing is open* for an issue that had been closed an hour earlier
 * and filed a duplicate. Four call sites meant four chances to get that wrong and
 * four places to fix it.
 *
 * A lookup that fails answers `null`, which lands here as *nothing matched* and
 * files a duplicate. That is the same trade the search has always made and it is
 * still the right one: a maintainer closes a duplicate in a second, and nothing
 * recovers a conclusion that was never filed.
 */
export async function fileFinding(
  issues: IssueOpener,
  finding: Finding,
  log: Log,
  events: { readonly opened: string; readonly recurred: string },
): Promise<FilingOutcome> {
  const fields = finding.fields ?? {}
  const existing = await issues.find(finding.marker)

  if (existing !== null) {
    if (finding.kind === 'event') return { action: 'quiet', url: existing.url }

    if (!existing.open) {
      await issues.reopen(existing.url)
      await issues.comment(existing.url, finding.recurrence ?? stillHolds())
      log.info(`reopened ${existing.url}`, {
        ...fields,
        event: events.recurred,
        url: existing.url,
        action: 'reopened',
      })
      return { action: 'reopened', url: existing.url }
    }

    if (finding.recurrence === undefined) return { action: 'quiet', url: existing.url }

    await issues.comment(existing.url, finding.recurrence)
    log.info(`commented on ${existing.url}`, {
      ...fields,
      event: events.recurred,
      url: existing.url,
      action: 'commented',
    })
    return { action: 'commented', url: existing.url }
  }

  const url = await issues.open({
    title: finding.title,
    body: `${finding.marker}\n${finding.body}`,
  })

  if (url !== null) log.info(`opened ${url}`, { ...fields, event: events.opened, url })
  return { action: url === null ? 'quiet' : 'opened', url }
}

/** What a reopening says when the caller had nothing more specific. */
function stillHolds(): string {
  return [
    'This was closed while the condition it describes still held, and the watcher that filed it',
    'has just measured it again. Reopened rather than filed a second time — the duplicate is the',
    'thing the next reader trusts.',
  ].join('\n')
}

/**
 * The whole response to a detected change, in the order that matters.
 *
 * **Recording comes first.** It is what demotes the contradicted claims and
 * starts the cooldown, and if the process dies after it the Colony has still
 * stopped serving advice it no longer believes — which is the half that protects
 * agents. Opening an issue first and dying would leave a maintainer reading about
 * a change the briefing was still contradicting.
 */
export async function respondToChange(
  change: ProviderChange,
  tripwire: Tripwire,
  log: Log,
): Promise<void> {
  await tripwire.record(change.taskId)
  log.warn(
    `provider change concluded on task ${change.taskId}: ` +
      `${change.reporters} distinct reporters in ${change.windowHours}h, ` +
      `against a baseline of ${change.baseline} and a bar of ${change.required}`,
    {
      event: 'tripwire.change.concluded',
      taskId: change.taskId,
      reporters: change.reporters,
      windowHours: change.windowHours,
      baseline: change.baseline,
      required: change.required,
    },
  )

  await tripwire.resynthesise(change.taskId)

  await fileFinding(
    tripwire.issues,
    {
      marker: changeMarker(change.taskId),
      title: `Provider change suspected on task ${change.taskId}`,
      body: issueBody(change),
      // The wall is there until somebody changes the task, its hints or its
      // verifier, and none of those is something this runner can do.
      kind: 'standing',
      recurrence: recurrenceBody(change),
    },
    log,
    { opened: 'tripwire.issue.opened', recurred: 'tripwire.issue.recurred' },
  )
}

/** One marker per task: two provider changes on two tasks are two findings. */
export function changeMarker(taskId: TaskId): string {
  return watchMarker(`provider-change:${taskId}`)
}

/**
 * What the automated issue says.
 *
 * **No citizen text, and an automated writer is exactly the writer most likely
 * to break that rule.** It names counts and the task and points at where a
 * maintainer can read the entries — every value in it is a number or an id this
 * function was handed, and there is no expression here that reads a report.
 *
 * Three sentences is a complete issue at this bar: `AGENTS.md` §7's standard
 * applies to **Ready**, not to what may exist, and this lands in Inbox.
 */
export function issueBody(change: ProviderChange): string {
  return [
    `${change.reporters} distinct citizens reported something the moderator judged new on ` +
      `task \`${change.taskId}\` within ${change.windowHours} hours. The task had at least ` +
      `${CHANGE_STABILITY_ATTEMPTS} closed attempts behind it, so this is a change rather than ` +
      'a task nobody had tried yet.',
    '',
    'The Colony has already demoted the claims nothing has confirmed since, and rewritten the ' +
      'briefing from what is left. What is likely still wrong is upstream of that: the task ' +
      "instructions, its hints, or its verifier. Nobody's report is quoted here — the entries " +
      'are readable through moderation.',
    '',
    `Opened automatically by the tripwire in \`apps/moderation-runner\`. A window on this task ` +
      `ordinarily carries ${change.baseline} distinct reporters, so the cluster had to reach ` +
      `${change.required} — never fewer than the floor of ${CHANGE_DISTINCT_REPORTERS} — before ` +
      'this was filed. If it is a false positive, those are the numbers to argue with.',
  ].join('\n')
}

/**
 * What a second cluster on the same task says on the issue that is already there.
 *
 * **A recurrence here is a distinct event and not the same measurement twice**,
 * which is why this one has a comment at all while the held-quest pass has none.
 * A conclusion only happens once per cooldown per task, so a second one means a
 * fresh cluster of citizens walked into the same wall after the Colony had
 * already rewritten the briefing about it — a fact a maintainer wants, and about
 * two lines a month rather than forty-eight a day.
 */
export function recurrenceBody(change: ProviderChange): string {
  return [
    `Concluded again: ${change.reporters} distinct citizens within ${change.windowHours} hours, ` +
      `against a baseline of ${change.baseline} and a bar of ${change.required}.`,
    '',
    'The claims nothing has confirmed since have been demoted again and the briefing rewritten ' +
      'from what is left. Commented rather than filed a second time — `#784` and `#1047` are ' +
      'what filing looks like.',
  ].join('\n')
}

/** A tripwire that opens nothing, for a runner with no token. */
export const noIssues: IssueOpener = {
  find: async () => null,
  open: async () => null,
  comment: async () => false,
  reopen: async () => false,
}

/**
 * Where the automated finding is filed, and how it is labelled.
 *
 * **`from:watcher` since `#686`.** This tripwire counts distinct reporters
 * against a threshold and files when the count is reached — a measurement, and
 * one nobody read before it became an issue. The label is what lets a reader
 * tell that from the maintainer agent's issues, which are judgements, and from
 * `from:citizen`, which is text the Colony did not write.
 *
 * **No priority, deliberately.** `AGENTS.md` §5 class 6 keeps that a human's
 * call for anything arriving from outside, and the reporters here are citizens.
 */
export const TRIPWIRE_REPOSITORY = 'Kolonie-AI/kolonie-platform'
export const TRIPWIRE_LABELS = ['area:platform', 'from:watcher'] as const

/** The token the opener reads. Absent degrades to {@link noIssues}. */
export const TRIPWIRE_TOKEN_VAR = 'MODERATION_GITHUB_TOKEN'

/**
 * An opener that talks to GitHub.
 *
 * **A missing token degrades this to {@link noIssues} rather than stopping the
 * runner**, which is the rule the model key follows one file over and applies
 * more cleanly here: an unopened issue costs a maintainer a discovery, and a
 * moderation runner that refuses to start costs every citizen its publication.
 *
 * The issue is opened with `area:platform` and no status field — the board's own
 * workflow adds new issues to **Inbox**, which is where this belongs. Setting a
 * column from here would be a second writer of the one thing `AGENTS.md` §4 says
 * only a human or an agent claiming work may move.
 */
export function githubIssues(token: string | undefined, log: Log): IssueOpener {
  if (token === undefined || token.trim() === '') {
    log.warn(
      `${TRIPWIRE_TOKEN_VAR} is not set — provider changes will be concluded but not filed`,
      {
        event: 'config.missing',
        variable: TRIPWIRE_TOKEN_VAR,
      },
    )
    return noIssues
  }

  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'content-type': 'application/json',
  }

  return {
    /**
     * **The search narrows; the first line decides.**
     *
     * Search is the only way to find an issue without storing its number, and it
     * is a full-text index over rendered bodies — it will match a marker quoted
     * in a code fence, a comment somebody wrote *about* a watcher, and the word
     * `provider-change` in prose. `#946` is what happens when a match like that
     * is trusted: a marker inside a hand-written issue was adopted as the
     * watcher's own alarm and the watcher rewrote a person's issue twelve minutes
     * after they filed it.
     *
     * So the query is a filter over candidates and the answer is the one whose
     * *first line* is the marker exactly. An open issue wins over a closed one —
     * both existing means somebody filed a duplicate before this change landed,
     * and the open one is the live thread.
     *
     * `is:open` is deliberately absent. Finding the closed issue is half the
     * point: without it, the pass after a maintainer closes a still-standing
     * finding files a second copy.
     */
    find: async (marker) => {
      const query = encodeURIComponent(`repo:${TRIPWIRE_REPOSITORY} is:issue "${marker}"`)
      const response = await fetch(
        `https://api.github.com/search/issues?q=${query}&sort=updated&order=desc&per_page=50`,
        { headers },
      )

      // A search that fails answers *nothing matched*, which risks a duplicate
      // issue rather than a silent miss. A maintainer closes a duplicate in a
      // second; nothing recovers a conclusion that was never filed.
      if (!response.ok) return null

      const body = (await response.json()) as {
        items?: readonly { html_url?: string; body?: string | null; state?: string }[]
      }

      const carrying = (body.items ?? [])
        .filter((item) => firstLine(item.body ?? '') === marker)
        .map((item) => ({ url: item.html_url ?? '', open: item.state === 'open' }))
        .filter((item) => item.url !== '')

      return carrying.find((item) => item.open) ?? carrying[0] ?? null
    },

    comment: async (url, body) => {
      const response = await fetch(`${apiFor(url)}/comments`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ body }),
      })

      if (!response.ok) {
        log.error(`could not comment on ${url}: ${response.status}`, await response.text(), {
          event: 'tripwire.issue.comment.failed',
          status: response.status,
          url,
        })
      }

      return response.ok
    },

    reopen: async (url) => {
      const response = await fetch(apiFor(url), {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ state: 'open' }),
      })

      if (!response.ok) {
        log.error(`could not reopen ${url}: ${response.status}`, await response.text(), {
          event: 'tripwire.issue.reopen.failed',
          status: response.status,
          url,
        })
      }

      return response.ok
    },

    open: async (input) => {
      const response = await fetch(`https://api.github.com/repos/${TRIPWIRE_REPOSITORY}/issues`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...input, labels: [...TRIPWIRE_LABELS] }),
      })

      if (!response.ok) {
        log.error(`could not open an issue: ${response.status}`, await response.text(), {
          event: 'tripwire.issue.create.failed',
          status: response.status,
        })
        return null
      }

      const body = (await response.json()) as { html_url?: string }
      return body.html_url ?? null
    },
  }
}

/**
 * The API address of an issue, from the address a reader sees.
 *
 * Search hands back `html_url` because that is what goes in a log a human reads,
 * and every write needs the other one. Rewriting it here rather than carrying
 * both keeps {@link WatchedIssue} the one thing a test has to construct.
 */
function apiFor(htmlUrl: string): string {
  return htmlUrl.replace('https://github.com/', 'https://api.github.com/repos/')
}
