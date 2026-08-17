import type { EndedByLever } from '@kolonie-ai/db'
import type { Log } from './loop.js'
import { fileFinding, noIssues, watchMarker, type IssueOpener } from './tripwire.js'

/**
 * The trace behind the one lever the steward tier still holds (`#944`).
 *
 * **`kolonie.quests.end` stops a live quest that is spending money**, and it is
 * the only privileged thing an agent holding an API key can do to somebody
 * else's row. `#944` shrank that tier to this single tool on the grounds that
 * stopping a runaway quest has to be immediate rather than next-poll — and asked
 * in the same breath that every use of it land in front of a person. This pass
 * is that: it reads the endings the lever wrote and files one maintainer issue
 * each.
 *
 * **The trace is filed here rather than at the call.** `apps/api` has no issue
 * opener and no GitHub token, and giving it one would put a write credential for
 * the Colony's own repository behind every request the API serves, to record an
 * act that happens a handful of times a year. The runner already holds that
 * token for the tripwire. A trace that arrives a few minutes late is worth more
 * than a token that lives in the wrong process.
 *
 * **Late, never blocking.** Nothing about the ending waits on this: the quest is
 * already retired when the pass reads it, and a failed filing loses the issue
 * rather than the stop — the same trade `redline-review.ts` names, and the same
 * direction.
 */

export interface QuestEndingsStore {
  /** Quests the lever stopped inside the window, oldest first. */
  endedByLever(withinDays: number, limit: number): Promise<readonly EndedByLever[]>
}

export interface QuestEndingsLoopDependencies {
  readonly store: QuestEndingsStore
  readonly issues?: IssueOpener
  readonly log?: Log
}

const silentLog: Log = { info: () => {}, warn: () => {}, error: () => {} }

/**
 * How far back the pass looks, and why a window rather than a column.
 *
 * **The window no longer carries the dedup, and this is the note that used to say
 * it did** (`#1161`). Dedup was {@link IssueOpener.isOpen}, which asked GitHub
 * for *open* issues carrying the task id and so stopped matching the moment a
 * maintainer closed one; the window was what stopped an unbounded read refiling
 * every ending forever. It is now {@link IssueOpener.find} over a marker, which
 * finds the closed issue too — and an ending is an `event`, so a closed issue
 * ends the matter rather than being reopened. A maintainer who closes one has
 * audited it, and arguing with them nightly is not what this pass is for.
 *
 * What the window is still for is the read: the store is asked for endings inside
 * it, so the pass costs one bounded query rather than growing with the ledger.
 * **Seven days is chosen against the runner being down** — long enough that a
 * weekend of outage does not lose an ending, short enough that the query stays
 * small. The number was previously load-bearing for correctness and is now only
 * load-bearing for cost, so it is safe to change.
 */
export const ENDING_WINDOW_DAYS = 7

/** What one pass over the endings came to. */
export interface QuestEndingsTickOutcome {
  readonly read: number
  readonly filed: number
  /** Already had an open issue, or the opener answered nothing. */
  readonly skipped: number
}

export async function questEndingsTick(
  deps: QuestEndingsLoopDependencies,
  batchSize: number,
): Promise<QuestEndingsTickOutcome> {
  const { store, issues = noIssues, log = silentLog } = deps
  let filed = 0
  let skipped = 0

  const endings = await store.endedByLever(ENDING_WINDOW_DAYS, batchSize)

  for (const ending of endings) {
    const outcome = await fileFinding(
      issues,
      {
        marker: endingMarker(ending.taskId),
        title: `Quest stopped by the steward lever: ${ending.title}`,
        body: endingIssueBody(ending),
        // A steward pulled a lever on a date. It is not a condition that could
        // stop holding, so a closed issue about it is a maintainer saying *read*
        // — and reopening it would be this pass arguing with them about a fact
        // neither disputes.
        kind: 'event',
        fields: { taskId: ending.taskId },
      },
      log,
      { opened: 'quest.ending.filed', recurred: 'quest.ending.recurred' },
    )

    if (outcome.action === 'opened') filed++
    else skipped++
  }

  return { read: endings.length, filed, skipped }
}

/** One marker per stopped quest. */
export function endingMarker(taskId: string): string {
  return watchMarker(`quest-ended-by-lever:${taskId}`)
}

/**
 * What a maintainer reads.
 *
 * **No citizen text, in either direction.** The steward's reason is bounded and
 * quoted because it is the whole point of the trace; the sponsor is not named,
 * the answers are not here, and the quest is identified by its id and its own
 * title. A maintainer who needs the rest reads it through the console, where
 * reading is a thing somebody did rather than a thing an automated writer
 * published.
 *
 * **Nothing waits on the issue.** The quest is already stopped, the sponsor
 * already refunded by `endQuest`'s own path. This is the record that a
 * privileged act happened, filed so that a tier of one tool is still a tier
 * somebody can audit.
 */
export function endingIssueBody(ending: EndedByLever): string {
  return [
    `A citizen holding \`steward\` stopped a quest that was not its own, through`,
    `\`kolonie.quests.end\`. That is the one privileged tool the tier still holds (\`#944\`), and`,
    'every use of it is filed here so a person sees it.',
    '',
    `- Quest: \`${ending.taskId}\``,
    `- Stopped: ${ending.endedAt}`,
    `- Reason given: ${bounded(ending.reason)}`,
    '',
    'The quest is retired and its sponsor refunded already — the stop does not wait on anybody',
    'reading this. What is worth checking is whether the reason holds: a lever nobody audits is a',
    'lever that stops being about runaway quests. If it does hold, close this.',
    '',
    'Opened automatically by `apps/moderation-runner`. The same ending is not filed twice: the',
    'marker on the first line above is what the next pass looks for, and finding this issue',
    'closed is an answer rather than a miss.',
  ].join('\n')
}

const REASON_MAX = 500

function bounded(reason: string): string {
  const trimmed = reason.trim().replace(/\s+/g, ' ')
  if (trimmed === '') return '(no reason recorded)'
  return trimmed.length <= REASON_MAX ? trimmed : `${trimmed.slice(0, REASON_MAX - 1)}…`
}
