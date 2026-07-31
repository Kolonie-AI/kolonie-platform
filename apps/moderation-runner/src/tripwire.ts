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
 * Where an automated finding goes.
 *
 * A seam rather than a GitHub client, for the reason every other outside
 * dependency here is one: the decision about *what to write* is testable without
 * a token, and a runner with no token degrades rather than stops — the same rule
 * the model key follows.
 */
export interface IssueOpener {
  /**
   * Whether an issue about this task is already open.
   *
   * **Duplicate issues are not opened while one is still open for the same
   * task**, which is this issue's own criterion and also the thing an automated
   * writer gets wrong first.
   */
  isOpen(taskId: TaskId): Promise<boolean>
  open(input: { readonly title: string; readonly body: string }): Promise<string | null>
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
      `${change.reporters} distinct reporters in ${change.windowHours}h`,
  )

  await tripwire.resynthesise(change.taskId)

  if (await tripwire.issues.isOpen(change.taskId)) return

  const url = await tripwire.issues.open({
    title: `Provider change suspected on task ${change.taskId}`,
    body: issueBody(change),
  })

  if (url !== null) log.info(`opened ${url}`)
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
    `Opened automatically by the tripwire in \`apps/moderation-runner\`. The threshold is ` +
      `${CHANGE_DISTINCT_REPORTERS} distinct reporters in ${change.windowHours}h and it is a ` +
      'starting position rather than a measurement — if this is a false positive, that number ' +
      'is the thing to argue with.',
  ].join('\n')
}

/** A tripwire that opens nothing, for a runner with no token. */
export const noIssues: IssueOpener = {
  isOpen: async () => false,
  open: async () => null,
}

/** Where the automated finding is filed, and how it is labelled. */
export const TRIPWIRE_REPOSITORY = 'Kolonie-AI/kolonie-platform'
export const TRIPWIRE_LABELS = ['area:platform'] as const

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
    log.warn(`${TRIPWIRE_TOKEN_VAR} is not set — provider changes will be concluded but not filed`)
    return noIssues
  }

  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'content-type': 'application/json',
  }

  return {
    /**
     * Searched by the task id in the title, which is what makes this reliable
     * without storing an issue number: the id is in every title this opener
     * writes and in no title anybody else writes.
     */
    isOpen: async (taskId) => {
      const query = encodeURIComponent(`repo:${TRIPWIRE_REPOSITORY} is:issue is:open "${taskId}"`)
      const response = await fetch(`https://api.github.com/search/issues?q=${query}`, { headers })

      // A search that fails answers *not open*, which risks a duplicate issue
      // rather than a silent miss. A maintainer closes a duplicate in a second;
      // nothing recovers a conclusion that was never filed.
      if (!response.ok) return false

      const body = (await response.json()) as { total_count?: number }
      return (body.total_count ?? 0) > 0
    },

    open: async (input) => {
      const response = await fetch(`https://api.github.com/repos/${TRIPWIRE_REPOSITORY}/issues`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...input, labels: [...TRIPWIRE_LABELS] }),
      })

      if (!response.ok) {
        log.error(`could not open an issue: ${response.status}`, await response.text())
        return null
      }

      const body = (await response.json()) as { html_url?: string }
      return body.html_url ?? null
    },
  }
}
