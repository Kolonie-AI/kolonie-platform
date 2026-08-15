import type { WithdrawnDraftQueue } from '@kolonie-ai/db'
import { carryingMarker, type Issues, type KnownIssue } from './github.js'

/**
 * The alarm for walks the Colony took in and then threw away (`#917`, `#946`).
 *
 * ## What it used to watch, and why that condition no longer exists
 *
 * **It counted drafts waiting for a steward.** Measured on 2026-08-14, four
 * completed walks had sat unread on `/review` since 2026-08-12, and from outside
 * a queue nobody is told about is indistinguishable from an empty one — which is
 * how `#917` came to be filed believing the walks had never been written at all.
 *
 * That queue is gone. `#813` gave the recipe pass in `apps/moderation-runner` the
 * decision, and `#941` gave it a deadline: a draft is published, or it is held and
 * the fortnight runs out on it and it is withdrawn with the reason it was last
 * held on. **Nothing waits on a person any more**, so a watcher on *waiting*
 * would file an issue every half hour naming a queue nobody could clear.
 *
 * ## What it watches instead
 *
 * **Drafts that expired without publishing** — the outcome that is cheap to miss
 * and expensive to have. The walk behind each one was written once, in the minute
 * after a citizen got in, by an agent that is stateless and will not be back
 * (`#907`); a withdrawal is the Colony deciding it cannot use material it will
 * never be offered again.
 *
 * **A rate and not a backlog.** One withdrawal is an ordinary outcome. Several in
 * a week says the Colony is refusing its own incoming material, and the two
 * causes worth telling apart are both in the table this files: a rewrite rule too
 * tight to clear anything, or walkers recording steps with nothing in them. That
 * is why every row carries what it was held on.
 *
 * ## What it is not
 *
 * **Not a publisher and not a reviewer.** Nothing here publishes, refuses,
 * withdraws or edits anything — the pass next door does all of that, and this only
 * says how often the last of those is happening. `#600`'s rule — *what the Colony
 * says about somebody else's product passes a person* — was superseded by `#812`
 * and `#813`; `governance/the-atlas.md` in `kolonie-docs` carries the answer and
 * `#946` is where it was settled.
 *
 * **Not the debt watcher's twin, though it is built on its shape.** That one
 * reports a condition the Colony may be unable to end. This one reports something
 * that has already happened, so it closes itself as soon as the week behind it is
 * quiet again.
 */

/**
 * How far back a withdrawal still counts as news.
 *
 * **Seven days.** A withdrawal is an event rather than a state, so the window is
 * what lets the alarm fall silent: too short and a run of expiries reads as
 * unrelated single incidents, too long — a fortnight, matching the expiry itself —
 * and one withdrawal keeps an issue open for two weeks after there is anything to
 * say. A rolling week is the smallest window in which a rate reads as a rate.
 */
export const DRAFT_WINDOW_DAYS = 7

/** Where the alarm is filed. The catalogue is the platform's, and so is the pass. */
export const DRAFT_REPOSITORY = 'Kolonie-AI/kolonie-platform'

/**
 * The marker that makes this issue findable again.
 *
 * One issue for the condition — *the Colony is throwing walks away* — with the
 * list attached, on the shape `#720` settled for the debt alarm. One issue per
 * withdrawal would be four notifications for one reading.
 *
 * **It is not the marker the steward alarm carried.** An issue that watcher filed
 * is about a condition that no longer exists, so this deliberately does not adopt
 * it: the two are different findings and the old one is closed by hand, once.
 */
export const DRAFT_MARKER = '<!-- watch-finding: recipe-drafts-withdrawn -->'

export const DRAFT_TITLE = 'Walked recipes are being withdrawn without publishing'

/** How many the last pass recorded, so a growing run can be told from a standing one. */
const WITHDRAWN_MARKER = /<!-- withdrawn: count=(\d+) -->/

function withdrawnMarker(count: number): string {
  return `<!-- withdrawn: count=${count} -->`
}

/**
 * What the last pass recorded as the size of the run.
 *
 * **An issue filed before this marker existed reads as zero**, which is the safe
 * direction on `debt.ts`'s argument: the first pass after this ships treats the
 * run as newly grown and says so once, rather than treating its own deploy as a
 * reason to stay quiet.
 */
export function recordedWithdrawn(body: string): number {
  const found = WITHDRAWN_MARKER.exec(body)
  return found === null ? 0 : Number(found[1])
}

/** What the runner should do about the week it just measured. Arithmetic alone. */
export type DraftAction =
  /** Nothing was withdrawn inside the window and nothing is open. The ordinary answer. */
  | { readonly kind: 'quiet' }
  /** Drafts were withdrawn and nothing open says so. */
  | { readonly kind: 'file' }
  /** Drafts were withdrawn and an open issue already says so. */
  | { readonly kind: 'standing'; readonly issue: KnownIssue }
  /** An open issue says so, and more have been withdrawn since it did. */
  | { readonly kind: 'escalate'; readonly issue: KnownIssue }
  /** The window is quiet again and the issue it opened is still open. */
  | { readonly kind: 'close'; readonly issue: KnownIssue }

/**
 * What to do, decided from the measurement and the board alone.
 *
 * **No comment on a standing run**, on the rule `#720` and `#727` settled
 * together next door: the same four withdrawals every half hour is a state, not
 * an event, and a comment per pass is wallpaper aimed at the one person who has
 * to act. The body is rewritten instead, which notifies nobody and keeps the
 * table true.
 *
 * **One exception, and it is the same one.** A fifth withdrawal behind four means
 * the Colony is still throwing walks away after somebody was told, which is a
 * different fact from four having been thrown away. That comments, once.
 *
 * **Falling to zero closes it**, and the window is what makes that reachable: the
 * condition ends by a quiet week rather than by anybody doing anything to the
 * rows, which are withdrawn and stay withdrawn.
 */
export function decideDrafts(
  queue: WithdrawnDraftQueue,
  open: KnownIssue | undefined,
): DraftAction {
  if (queue.count === 0)
    return open === undefined ? { kind: 'quiet' } : { kind: 'close', issue: open }
  if (open === undefined) return { kind: 'file' }
  return queue.count > recordedWithdrawn(open.body)
    ? { kind: 'escalate', issue: open }
    : { kind: 'standing', issue: open }
}

/**
 * The open issue carrying this alarm's marker on its first line, if there is one.
 *
 * **First line rather than anywhere**, and this alarm is why: `#946` quoted the
 * old marker while asking for this file to be repointed, and was adopted and
 * overwritten. {@link carryingMarker} carries the whole argument.
 */
export function openDraftIssue(issues: readonly KnownIssue[]): KnownIssue | undefined {
  return carryingMarker(issues, DRAFT_MARKER)
}

/** One row of the table, and the reason is the half worth reading. */
function row(draft: WithdrawnDraftQueue['drafts'][number]): string {
  return (
    `| \`${draft.provider}\` | ${draft.kind} | ${draft.category} | ${draft.since} | ` +
    `${draft.heldOn ?? '*no verdict recorded a reason*'} |`
  )
}

/** The alarm, as the person who has to act on it reads it. */
export function draftIssueBody(queue: WithdrawnDraftQueue): string {
  const unlisted = queue.count - queue.drafts.length

  return [
    DRAFT_MARKER,
    withdrawnMarker(queue.count),
    '',
    `**${queue.count} walked recipe(s) have been withdrawn unpublished in the last ` +
      `${DRAFT_WINDOW_DAYS} days.**`,
    '',
    'Each one was a citizen’s account of how it joined a provider, written in the minute after ' +
      'it got in. The Colony held it, waited a fortnight for it to become publishable, and gave ' +
      'up — so **nothing is offered to any agent for that provider**, and the walk behind it ' +
      'cannot be asked for again: the citizen that wrote it is stateless and gone.',
    '',
    '| Provider | Kind | Shelf | Withdrawn | Held on |',
    '|---|---|---|---|---|',
    ...queue.drafts.map(row),
    ...(unlisted > 0 ? ['', `…and ${unlisted} more not listed here.`] : []),
    '',
    ...(queue.oldestSince === null
      ? []
      : [`The earliest inside the window is ${queue.oldestSince}.`, '']),
    '## What to read it as',
    '',
    '**One withdrawal is an ordinary outcome**, and this is not an accusation that anything is ' +
      'broken. A walk that recorded nothing usable, or a provider with no honest route, ends ' +
      'exactly here and should.',
    '',
    '**The column that decides is *Held on*.** Several rows held on the same thing is the ' +
      'finding, and there are two of them worth telling apart. If the reasons are about the ' +
      'Colony’s own wording — a sentence it would not write, a claim it would not stand behind ' +
      '— the rewrite rule is too tight and is refusing material it could use. If they are about ' +
      'what the walk recorded — a step with nothing in it, no proof method, no shelf — then the ' +
      'walkers are the place to fix it, and the entries here are the evidence of how.',
    '',
    '## Where to act on it',
    '',
    'The pass is `apps/moderation-runner` (`#813`): it judges every draft, publishes what it ' +
      'can clear, holds what it cannot, and withdraws what a fortnight did not fix (`#941`). ' +
      'The rewrite rule is `recipe-wording.ts` and `recipe-prompts.ts`; what a walk is required ' +
      'to record is `walked-recipe.ts` in `core`. A withdrawn entry keeps its steps and is ' +
      'readable, so **a fresh walk replaces one** — nothing here has to be undone first.',
    '',
    '## What this is not',
    '',
    '**Not a steward queue, and there is no longer one to be behind on.** This alarm replaced ' +
      'one that counted drafts waiting to be read by a person (`#917`). `#600`’s rule — *what ' +
      'the Colony says about somebody else’s product passes a person* — was superseded by ' +
      '`#812` and `#813`, and `governance/the-atlas.md` carries the answer. Drafts are decided ' +
      'by the pass on the ordinary poll; nothing is waiting on anybody.',
    '',
    '**Not something to clear by hand.** These entries are already withdrawn and staying that ' +
      'way is correct. What ends this alarm is a quieter week, which is what makes it a ' +
      'measurement rather than a task.',
    '',
    '---',
    '',
    '**Filed by a machine**, by the withdrawal watcher in `apps/support-triage-runner` ' +
      '(`#917`, repointed by `#946`). While the run stands this is not commented on every pass ' +
      '— a rate is a state and not an event. **The body is kept current**, which notifies ' +
      `nobody. **It closes itself** on the first pass where nothing has been withdrawn in ` +
      `${DRAFT_WINDOW_DAYS} days.`,
  ].join('\n')
}

/**
 * What it says when more have been withdrawn under an open alarm.
 *
 * **It repeats the numbers rather than saying "see above"**, for `debt.ts`'s
 * reason: the body a reader scrolls past may be from a different day, and a
 * comment pointing at a table that has moved is worse than no comment.
 */
export function draftEscalationComment(queue: WithdrawnDraftQueue, was: number): string {
  return [
    `**${queue.count} walked recipes have now been withdrawn unpublished**, up from ${was} when ` +
      'this was last reported. They are still accumulating rather than having been a bad week, ' +
      'which is why this is a comment and not another silent pass.',
    '',
    '| Provider | Kind | Shelf | Withdrawn | Held on |',
    '|---|---|---|---|---|',
    ...queue.drafts.map(row),
    '',
    'The *Held on* column is what says whether this is the rewrite rule refusing usable ' +
      'material or the walks arriving with nothing in them.',
  ].join('\n')
}

/** What it says on the way out. */
export function draftClosingComment(): string {
  return (
    `Nothing has been withdrawn unpublished in ${DRAFT_WINDOW_DAYS} days, so this closes ` +
    'itself. The entries listed above stay withdrawn — that is the correct state for them, and ' +
    'a fresh walk is what replaces one. It is filed again if the Colony starts throwing walks ' +
    'away again.'
  )
}

export interface DraftWatchDependencies {
  readonly issues: Issues
  measure(): Promise<WithdrawnDraftQueue>
}

export interface DraftWatchOutcome {
  readonly action: DraftAction['kind']
  readonly withdrawn: number
  /** Set when the pass did nothing because a seam could not be read. */
  readonly skipped?: 'no-app' | 'unreadable'
}

/**
 * One pass of the withdrawal watcher.
 *
 * **It does not act when it cannot read GitHub**, which is `#868`'s lesson taken
 * before it has to be learned again here: an empty corpus is indistinguishable
 * from an unreadable one, and filing against that opens a fresh alarm every half
 * hour for a condition that already had an issue. The measurement is read from
 * the database and is not in doubt; what is in doubt is only whether an issue
 * already says so.
 */
export async function watchDrafts(deps: DraftWatchDependencies): Promise<DraftWatchOutcome> {
  const queue = await deps.measure()
  if (!deps.issues.available) return { action: 'quiet', withdrawn: queue.count, skipped: 'no-app' }

  const corpus = await deps.issues.open()
  if (corpus.unreadable.includes(DRAFT_REPOSITORY)) {
    return { action: 'quiet', withdrawn: queue.count, skipped: 'unreadable' }
  }

  const action = decideDrafts(queue, openDraftIssue(corpus.issues))

  if (action.kind === 'file') {
    await deps.issues.create({
      repository: DRAFT_REPOSITORY,
      title: DRAFT_TITLE,
      body: draftIssueBody(queue),
      /**
       * `from:watcher` because nobody read this before it was filed, and `p2`
       * rather than `p1`: what it reports has already happened and cannot be
       * undone in a hurry, so the cost of reading it tomorrow is one more day of
       * the same rate rather than anything lost.
       */
      labels: ['from:watcher', 'area:platform', 'p2'],
    })
  }

  if (action.kind === 'escalate') {
    await deps.issues.comment(
      action.issue.url,
      draftEscalationComment(queue, recordedWithdrawn(action.issue.body)),
    )
    await deps.issues.revise(action.issue.url, draftIssueBody(queue))
  }

  if (action.kind === 'standing') await deps.issues.revise(action.issue.url, draftIssueBody(queue))

  if (action.kind === 'close') await deps.issues.close(action.issue.url, draftClosingComment())

  return { action: action.kind, withdrawn: queue.count }
}
