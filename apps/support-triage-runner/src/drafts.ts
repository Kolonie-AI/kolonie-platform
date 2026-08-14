import type { StewardQueue } from '@kolonie-ai/db'
import type { Issues, KnownIssue } from './github.js'

/**
 * The alarm for walks a citizen finished and nobody has read (`#917`).
 *
 * ## The gap this fills, which is not the one it looks like
 *
 * **The queue has a page and always did.** `unpublishedSection` on `/backend`
 * and `/review` has listed every draft with its steps, its shelf and a Publish
 * button since `#604`. What did not exist is anything that *says so* — and
 * measured on 2026-08-14, four completed walks had been sitting there unread,
 * the oldest since 2026-08-12. From outside, a queue nobody is told about is
 * indistinguishable from a queue that is empty, which is exactly how that
 * looked: `#917` was filed believing the walks had never been written.
 *
 * ## Why it is worth an alarm rather than a habit
 *
 * **The material is perishable in one direction only.** A citizen writes its
 * walk once, in the minute after it joins, and is stateless by the next session
 * — so the walk cannot be asked for again, and `#907` exists because that
 * one-way door is the whole reason the catalogue is thin. Something that has
 * already been captured and is then lost to inattention is the most expensive
 * kind of loss the Atlas has, because it is the only one nobody has to pay
 * twice for.
 *
 * ## What it is not
 *
 * **Not a proposal queue.** A proposal asks *does this provider belong on the
 * map*; a draft asks *is this route good enough to offer*. Only the second has a
 * citizen's completed walk behind it, and only the second has a clock on it.
 *
 * **Not a publisher.** Nothing here publishes, refuses or edits a draft. What
 * the Colony says about somebody else's product passes a person — `#600`'s rule
 * — and this alarm exists precisely to get it in front of one.
 *
 * **Not the debt watcher's twin, though it is built on its shape.** That one
 * reports a condition the Colony may be unable to end. This one reports a queue
 * that a person can empty in ten minutes, which is why it closes itself as soon
 * as they have.
 */

/**
 * How long a draft may wait before it is a backlog rather than a queue.
 *
 * **Two days**, and the number is the one the measurement produced rather than a
 * round figure: the oldest of the four had waited two days and the newest one
 * day, and a threshold under that would have fired on a steward who simply had
 * not got to this morning's walk yet. A draft written an hour ago has not been
 * neglected.
 */
export const DRAFT_THRESHOLD_HOURS = 48

/** Where the alarm is filed. The catalogue is the platform's, and so is the queue. */
export const DRAFT_REPOSITORY = 'Kolonie-AI/kolonie-platform'

/**
 * The marker that makes this issue findable again.
 *
 * One issue for the condition — *walks are waiting* — with a list attached, on
 * the shape `#720` settled for the debt alarm. One issue per draft would be four
 * notifications for one afternoon's reading.
 */
export const DRAFT_MARKER = '<!-- watch-finding: steward-drafts-waiting -->'

export const DRAFT_TITLE = 'Completed walks are waiting for a steward'

/** How many drafts the last pass recorded, so a growing queue can be told from a standing one. */
const WAITING_MARKER = /<!-- waiting: count=(\d+) -->/

function waitingMarker(count: number): string {
  return `<!-- waiting: count=${count} -->`
}

/**
 * What the last pass recorded as the depth of the queue.
 *
 * **An issue filed before this marker existed reads as zero**, which is the safe
 * direction on `debt.ts`'s argument: the first pass after this ships treats the
 * queue as newly grown and says so once, rather than treating its own deploy as
 * a reason to stay quiet.
 */
export function recordedWaiting(body: string): number {
  const found = WAITING_MARKER.exec(body)
  return found === null ? 0 : Number(found[1])
}

/** What the runner should do about the queue it just measured. Arithmetic alone. */
export type DraftAction =
  /** Nothing has waited past the threshold and nothing is open. The ordinary answer. */
  | { readonly kind: 'quiet' }
  /** Walks are waiting and nothing open says so. */
  | { readonly kind: 'file' }
  /** Walks are waiting and an open issue already says so. */
  | { readonly kind: 'standing'; readonly issue: KnownIssue }
  /** An open issue says so, and more walks have joined the queue since it did. */
  | { readonly kind: 'escalate'; readonly issue: KnownIssue }
  /** The queue is empty and the issue it opened is still open. */
  | { readonly kind: 'close'; readonly issue: KnownIssue }

/**
 * What to do, decided from the measurement and the board alone.
 *
 * **No comment on a standing queue**, on the rule `#720` and `#727` settled
 * together next door: a queue of the same four walks every half hour is a state,
 * not an event, and a comment per pass is wallpaper aimed at the one person who
 * has to act. The body is rewritten instead, which notifies nobody and keeps the
 * table true.
 *
 * **One exception, and it is the same one.** A queue that has *grown* is a new
 * fact: a fifth walk arriving behind four that nobody has read means the drafts
 * are accumulating faster than they are being cleared, which is a different
 * problem from four walks waiting. That comments, once, and only then.
 */
export function decideDrafts(queue: StewardQueue, open: KnownIssue | undefined): DraftAction {
  if (queue.count === 0)
    return open === undefined ? { kind: 'quiet' } : { kind: 'close', issue: open }
  if (open === undefined) return { kind: 'file' }
  return queue.count > recordedWaiting(open.body)
    ? { kind: 'escalate', issue: open }
    : { kind: 'standing', issue: open }
}

/** The open issue carrying this alarm's marker, if there is one. */
export function openDraftIssue(issues: readonly KnownIssue[]): KnownIssue | undefined {
  return issues.find((issue) => issue.body.includes(DRAFT_MARKER))
}

/** The alarm, as the steward who has to act on it reads it. */
export function draftIssueBody(queue: StewardQueue): string {
  const rows = queue.drafts.map(
    (draft) => `| \`${draft.provider}\` | ${draft.kind} | ${draft.category} | ${draft.since} |`,
  )

  const unlisted = queue.count - queue.drafts.length

  return [
    DRAFT_MARKER,
    waitingMarker(queue.count),
    '',
    `**${queue.count} completed walk(s) have waited more than ${DRAFT_THRESHOLD_HOURS} hours ` +
      'for a steward.**',
    '',
    'Each one is a citizen’s account of how it joined a provider, written in the minute after ' +
      'it got in. **Nothing is offered to any agent until one of them is published** — a draft ' +
      'reaches no public surface, by design, because publishing it would put a route in front ' +
      'of an agent that no steward has stood behind.',
    '',
    '| Provider | Kind | Shelf | Waiting since |',
    '|---|---|---|---|',
    ...rows,
    ...(unlisted > 0 ? ['', `…and ${unlisted} more not listed here.`] : []),
    '',
    ...(queue.oldestSince === null
      ? []
      : [`The oldest has waited since ${queue.oldestSince}.`, '']),
    '## Where to act on it',
    '',
    'The queue itself is **`/review`** (stewards) and **`/backend`** (the maintainer), under ' +
      '*Not published, and nobody outside can see them*. Each row carries the walked steps, the ' +
      'proof method, the shelf and the walker’s own account, with **Publish** and **Refuse** ' +
      'beside it. A refusal takes a sentence, because the citizen is told the outcome and *no* ' +
      'with no reason teaches nothing.',
    '',
    '## What this is not',
    '',
    '**Not a claim that the page was missing.** It was not: `#604` built it and it has listed ' +
      'every draft since. What was missing was anything saying the page had something on it — ' +
      'and a queue nobody is told about is indistinguishable from an empty one, which is how ' +
      'four walks came to sit unread for two days.',
    '',
    '**Not a proposal queue.** A proposal asks whether a provider belongs on the map at all. ' +
      'These are walks somebody finished, and the question is only whether the route is good ' +
      'enough to offer.',
    '',
    '**Not something a machine may clear.** Nothing here publishes or refuses anything. What ' +
      'the Colony says about somebody else’s product passes a person (`#600`), which is the ' +
      'whole reason this alarm’s job is to reach one.',
    '',
    '---',
    '',
    '**Filed by a machine**, by the draft watcher in `apps/support-triage-runner` (`#917`). ' +
      'While walks are waiting this is not commented on every pass — a queue is a state and not ' +
      'an event. **The body is kept current**, which notifies nobody. **It closes itself** on ' +
      'the first pass where nothing has waited past the threshold, so clearing the queue is all ' +
      'that is needed; closing it by hand while walks are waiting files it again.',
  ].join('\n')
}

/**
 * What it says when the queue has grown under an open alarm.
 *
 * **It repeats the numbers rather than saying "see above"**, for `debt.ts`'s
 * reason: the body a reader scrolls past may be from a different day, and a
 * comment pointing at a table that has moved is worse than no comment.
 */
export function draftEscalationComment(queue: StewardQueue, was: number): string {
  return [
    `**${queue.count} completed walks are now waiting**, up from ${was} when this was last ` +
      'reported. The queue is growing rather than standing still, which is why this is a ' +
      'comment and not another silent pass.',
    '',
    '| Provider | Kind | Shelf | Waiting since |',
    '|---|---|---|---|',
    ...queue.drafts.map(
      (draft) => `| \`${draft.provider}\` | ${draft.kind} | ${draft.category} | ${draft.since} |`,
    ),
    '',
    'They are on `/review` and `/backend`, under *Not published, and nobody outside can see ' +
      'them*. Publishing or refusing any of them is what makes this quieter.',
  ].join('\n')
}

/** What it says on the way out. */
export function draftClosingComment(): string {
  return (
    'Nothing has waited past the threshold on this pass, so the queue is clear and this closes ' +
    'itself. Thank you — every one of those was a citizen’s account of a signup that no later ' +
    'session could have reconstructed. It is filed again if walks wait more than ' +
    `${DRAFT_THRESHOLD_HOURS} hours again.`
  )
}

export interface DraftWatchDependencies {
  readonly issues: Issues
  measure(): Promise<StewardQueue>
}

export interface DraftWatchOutcome {
  readonly action: DraftAction['kind']
  readonly waiting: number
  /** Set when the pass did nothing because a seam could not be read. */
  readonly skipped?: 'no-app' | 'unreadable'
}

/**
 * One pass of the draft watcher.
 *
 * **It does not act when it cannot read GitHub**, which is `#868`'s lesson taken
 * before it has to be learned again here: an empty corpus is indistinguishable
 * from an unreadable one, and filing against that opens a fresh alarm every half
 * hour for a condition that already had an issue. The queue is read from the
 * database and is not in doubt; what is in doubt is only whether an issue
 * already says so.
 */
export async function watchDrafts(deps: DraftWatchDependencies): Promise<DraftWatchOutcome> {
  const queue = await deps.measure()
  if (!deps.issues.available) return { action: 'quiet', waiting: queue.count, skipped: 'no-app' }

  const corpus = await deps.issues.open()
  if (corpus.unreadable.includes(DRAFT_REPOSITORY)) {
    return { action: 'quiet', waiting: queue.count, skipped: 'unreadable' }
  }

  const action = decideDrafts(queue, openDraftIssue(corpus.issues))

  if (action.kind === 'file') {
    await deps.issues.create({
      repository: DRAFT_REPOSITORY,
      title: DRAFT_TITLE,
      body: draftIssueBody(queue),
      /**
       * `from:watcher` because nobody read this before it was filed, and `p2`
       * rather than `p1`: the walks are safe where they are and the cost of
       * leaving them is a catalogue that is thinner than it should be, not a
       * promise the Colony is breaking.
       */
      labels: ['from:watcher', 'area:platform', 'p2'],
    })
  }

  if (action.kind === 'escalate') {
    await deps.issues.comment(
      action.issue.url,
      draftEscalationComment(queue, recordedWaiting(action.issue.body)),
    )
    await deps.issues.revise(action.issue.url, draftIssueBody(queue))
  }

  if (action.kind === 'standing') await deps.issues.revise(action.issue.url, draftIssueBody(queue))

  if (action.kind === 'close') await deps.issues.close(action.issue.url, draftClosingComment())

  return { action: action.kind, waiting: queue.count }
}
