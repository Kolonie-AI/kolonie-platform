import type { PayoutRefusal } from '@kolonie-ai/core'
import type { OutstandingDebt } from '@kolonie-ai/db'
import { carryingMarker, type ClosedIssue, type Issues, type KnownIssue } from './github.js'

/**
 * The alarm for money the Colony owes and has not paid (`#720`).
 *
 * ## The gap this fills
 *
 * Every other layer reports its own failures without anybody going to look:
 * `red-on-main.yml` opens an issue, Health Watch opens an issue,
 * `board-self-check.yml` opens an issue, and `payout.float.short` opens an issue
 * when the payout wallet runs dry. **Money owed and not delivered had no such
 * alarm**, which is how the state in `#719` stood for two days unnoticed.
 *
 * The float watcher was silent throughout and was **right** to be. It answers
 * *can the Colony pay* — `floatShort` was false, the wallet held 94,996,000
 * lamports. It does not answer *has the Colony paid*. Those two came apart the
 * first time real money went through a quest, and nothing was looking at the
 * gap.
 *
 * ## Why it lives here and not in the log detector
 *
 * The detector next door closes only one measured condition: **fourteen days
 * with no exact matching line** (`kolonie-docs#561`). It still never decides a
 * defect was dealt with, which remains a person's call. This watcher is the
 * same class of arithmetic over a different source: one SQL query with a
 * precise end — *nothing is outstanding past the threshold* — so it can close
 * itself, which is the shape Health Watch already has in `kolonie-infra`. It
 * shares the runner's GitHub App and its half-hour tick and nothing else.
 *
 * ## Why it is not `#719` again
 *
 * `#719` tells the **citizen** it is owed money. This tells **us** that the
 * Colony is carrying a debt it has not discharged. They fail independently: a bug
 * in the citizen-facing hint leaves us blind again, and the two most likely
 * causes of a stuck obligation — a citizen with no wallet, a price below the
 * chain floor — are things only we can act on. Two readers of the same query,
 * built as two.
 *
 * ## Deliberately not in scope
 *
 * Automatic forfeiture, write-off, or any change to what is owed. **The alarm
 * reports; it does not settle.** Anything that reduces a citizen's balance stays
 * a decision a person makes.
 */

/**
 * How long an obligation may stand before it is a condition rather than a queue.
 *
 * A day, and the reconciler runs every quarter of an hour — so ninety-six passes
 * have had a go at it before this says anything. An obligation written an hour
 * ago has not failed to be paid, it has not been tried enough times to know.
 */
export const DEBT_THRESHOLD_HOURS = 24

/** Where the alarm is filed. The debt is the platform's, and so is the fix. */
export const DEBT_REPOSITORY = 'Kolonie-AI/kolonie-platform'

/**
 * The marker that makes this issue findable again.
 *
 * The same mechanism the log detector uses, and a constant rather than a
 * parameter because there is exactly one of this condition — *the Colony owes
 * money it has not paid* — with a list attached, not one finding per obligation.
 * That is the shape `#720` asked for and it is what stops a reconciliation
 * running four times an hour from filing four issues.
 */
export const DEBT_MARKER = '<!-- watch-finding: payout-debt-outstanding -->'

export const DEBT_TITLE = 'The Colony owes money it has not paid'

/**
 * The same verdict as the prose in `dischargeVerdict`, in a form the routing pass
 * can act on (`#919`, second half).
 *
 * **A sentence addressed to a reader was not enough, because the reader that kept
 * getting this wrong is a script.** Nothing in this repository applies an
 * `agent:*` label; `kolonie-docs/.github/scripts/board-triage.sh` does, and its
 * one default is *anything I cannot place becomes `agent:claude`*. So a finding
 * with no Colony-side action was routed to an agent on every pass, and every
 * session that picked it up spent itself concluding there was nothing to do —
 * `#727` collected seven such comments over four days, and on 2026-08-16 a person
 * removed the label at 15:06 and the next pass restored it at 15:15.
 *
 * `#919` named the remedy as *it carries no agent label* and was closed with that
 * half unshipped, because it was written as though this runner applied the label.
 * This is the half this side can actually hold: **state the fact, deterministically
 * and in the body, and let the pass that owns routing decide what it means.**
 *
 * It is a fact and not an instruction, for the same reason the prose is: this
 * runner does not get to say what an issue of its own is worth. And it is written
 * only while `oursOnly` is empty — the moment a debt the Colony can act on arrives
 * behind these, the marker is gone on that same pass and the finding is ordinary
 * work again.
 */
export const NO_COLONY_ACTION_MARKER = '<!-- no-colony-action -->'

/**
 * Whether the Colony is the party that can do something about this refusal
 * (`#727`).
 *
 * ## Why the alarm needs this and did not have it
 *
 * `whoseRefusal` below has answered this in prose since `#720` — it is the
 * *Whose it is to fix* column — and **nothing acted on the answer**. Two of the
 * six refusals name obligations that no pass of this runner, and no decision
 * available to us today, can clear:
 *
 * - `no-verified-address` is the citizen's. It is told on its next waking
 *   (`#719`) and may never come back.
 * - `accruing-below-chain-minimum` is a pricing decision taken before the quest
 *   was published (`#718`). The obligation is correct and stands until the
 *   citizen accrues past the chain floor.
 *
 * Measured on 2026-08-14: `#727` had been open five days, and the three
 * obligations behind it were **all** of those two kinds. The body still quoted
 * one obligation at 750,000 lamports, because `decideDebt` answers `standing`
 * for every pass while an issue is open and `standing` deliberately writes
 * nothing.
 *
 * That silence is right for the same debt seen again. **It is wrong for a debt
 * of a different kind arriving behind it** — a `float-exhausted` obligation
 * tomorrow is the Colony unable to pay what it owes, the condition this whole
 * watcher exists for, and it would have produced no signal at all because an
 * issue was already open. The urgent case hid behind the permanent one.
 *
 * **Derived from the same `switch` as `whoseRefusal`**, so the sentence a reader
 * sees and the decision the runner takes cannot drift apart — which is precisely
 * what happened while the sentence existed and the decision did not.
 */
export function oursToFix(refusal: PayoutRefusal | null): boolean {
  switch (refusal) {
    // `null` is never attempted and past the threshold, which is the reconciler
    // not running — ours, and the most urgent of the lot, because it means
    // nothing at all is being paid. `unavailable` retries on the next pass, but
    // a day of retries that all failed is our infrastructure and not the
    // citizen's wallet.
    case null:
    case 'float-exhausted':
    case 'above-transaction-ceiling':
    case 'above-daily-ceiling':
    case 'unavailable':
      return true
    case 'no-verified-address':
    case 'accruing-below-chain-minimum':
      return false
  }
}

/** The share of a measured debt that the Colony itself could discharge. */
export function oursOnly(debt: OutstandingDebt): {
  readonly count: number
  readonly lamports: number
} {
  const mine = debt.refusals.filter((row) => oursToFix(row.refusal))
  return {
    count: mine.reduce((total, row) => total + row.count, 0),
    lamports: mine.reduce((total, row) => total + row.lamports, 0),
  }
}

/**
 * The Colony's own share, written into the body so the next pass can compare
 * against it.
 *
 * **The issue is the state, which is the shape this watcher already has.**
 * `openDebtIssue` finds the alarm by a marker in its body rather than by title;
 * this is the same idea carrying a number instead of a name, and it means a
 * runner restarting mid-condition still knows what was last reported. A field in
 * the runner's memory would not survive the deploy that is often what changed.
 */
const OURS_MARKER = /<!-- ours: count=(\d+) lamports=(\d+) -->/

function oursMarker(ours: { readonly count: number; readonly lamports: number }): string {
  return `<!-- ours: count=${ours.count} lamports=${ours.lamports} -->`
}

/**
 * What the last pass recorded as the Colony's own share.
 *
 * **An issue filed before this marker existed reads as zero**, and that is the
 * safe direction: the first pass after this ships treats any Colony-side debt as
 * newly arrived and says so once. Reading it as *unknown, so stay quiet* would
 * make the deploy itself a reason to miss the thing this is for.
 */
export function recordedOurs(body: string): number {
  const found = OURS_MARKER.exec(body)
  return found === null ? 0 : Number(found[1])
}

/** What the runner should do about the debt it just measured. Arithmetic alone. */
export type DebtAction =
  /** Nothing is outstanding and nothing is open. The ordinary answer. */
  | { readonly kind: 'quiet' }
  /** There is a condition and nothing open says so. */
  | { readonly kind: 'file' }
  /** There is a condition and an open issue already says so. */
  | { readonly kind: 'standing'; readonly issue: KnownIssue }
  /**
   * An open issue says so, and the Colony's own share has grown since it did.
   *
   * The one case that earns a comment on a standing condition (`#727`): not the
   * same debt seen again, but a debt of a kind the Colony can act on arriving
   * behind one it cannot.
   */
  | { readonly kind: 'escalate'; readonly issue: KnownIssue }
  /** The condition has ended and the issue it opened is still open. */
  | { readonly kind: 'close'; readonly issue: KnownIssue }
  /**
   * The condition still holds and the issue that said so has been closed
   * (`#1161`).
   *
   * **A debt is measured, so closing its issue does not end it.** Somebody read
   * the alarm and closed it — which is a statement about their attention, not
   * about what the Colony owes. Filing a second issue is what happened before:
   * `#867` beside `#727`, about the same standing condition, for a person to
   * notice and close by hand.
   */
  | { readonly kind: 'reopen'; readonly issue: ClosedIssue }

/**
 * What to do, decided from the measurement and the board alone.
 *
 * **No comment on a standing condition, and that is the one judgement here.**
 * The log detector comments on recurrence because each recurrence is a new
 * occurrence of an event. A debt is not an event — it is a state, and it is the
 * *same* debt every half hour. A comment per pass would put forty-eight lines a
 * day on an issue whose body already carries the numbers, which is `#231`'s
 * wallpaper failure aimed at a maintainer. The body going stale is the accepted
 * cost, and it is bounded: the issue is closed the moment the condition ends,
 * and what is owed exactly is one query away for whoever opens it.
 *
 * **One exception, and it is the whole of `#727`.** *The same debt* every half
 * hour is a state. *A debt the Colony can act on, arriving behind one it
 * cannot*, is an event — and it is the event this watcher was built for. Under
 * the rule above it produced nothing at all, because an issue was already open.
 * So `escalate` comments once when the Colony's own share grows, and only then.
 *
 * **The condition itself is unchanged: any obligation past the threshold.**
 * Narrowing it to the Colony's share was the first thing tried and it is wrong —
 * `#720`'s founding measurement was two obligations, both of them a citizen's,
 * and surfacing exactly that is what produced `#719` and `#718`. An alarm that
 * would not have fired for its own founding case is not the fix.
 *
 * **Nothing open is two states, and telling them apart is `#1161`.** Nobody has
 * ever filed this alarm, or somebody filed it and closed it while the money was
 * still owed. The first is a `file`; the second is a `reopen`, because the
 * condition is measured and the measurement has not changed. Reading both as
 * *nothing open* is what put `#867` beside `#727`.
 *
 * **A closed corpus that could not be read reads as empty, and that is the safe
 * direction**: the answer falls back to `file`, which is exactly the behaviour
 * before this change. A duplicate issue is a bad outcome; silence about money
 * the Colony owes is a worse one.
 */
export function decideDebt(
  debt: OutstandingDebt,
  open: KnownIssue | undefined,
  closed: readonly ClosedIssue[] = [],
): DebtAction {
  if (debt.count === 0)
    return open === undefined ? { kind: 'quiet' } : { kind: 'close', issue: open }
  if (open === undefined) {
    const shut = closedDebtIssue(closed)
    if (shut === undefined) return { kind: 'file' }
    return heldThrough(debt, shut) ? { kind: 'reopen', issue: shut } : { kind: 'file' }
  }
  return oursOnly(debt).count > recordedOurs(open.body)
    ? { kind: 'escalate', issue: open }
    : { kind: 'standing', issue: open }
}

/**
 * Whether the debt outstanding now was already outstanding when that issue was
 * closed.
 *
 * **This is what separates a wrong closure from a second episode**, and it is
 * `#560`'s guard pointed the other way. `#560` asks whether a defect's lines are
 * newer than the closure, because a returning error is a new occurrence. Here
 * the interesting answer is the opposite one: an obligation written *before* the
 * closure was outstanding while somebody was closing the issue about it, so the
 * closure ended the conversation and not the condition — and that is `#727`,
 * exactly.
 *
 * Debt that arrived entirely *after* the closure is a second episode, and the
 * closing comment promises it a new issue rather than a resurrection: the alarm
 * closed itself because nothing was owed, and that reading was true on the day.
 *
 * **Unreadable timestamps reopen**, which is the direction that cannot repeat
 * `#867`. The cost is an old thread coming back carrying a comment that says
 * what is owed today; the cost the other way is the duplicate this change exists
 * to stop.
 */
function heldThrough(debt: OutstandingDebt, issue: ClosedIssue): boolean {
  if (issue.closedAt === null || debt.oldestSince === null) return true
  const shutAt = Date.parse(issue.closedAt)
  const owedSince = Date.parse(debt.oldestSince)
  if (Number.isNaN(shutAt) || Number.isNaN(owedSince)) return true
  return owedSince <= shutAt
}

/**
 * The open issue carrying this alarm's marker on its first line, if there is one.
 *
 * **First line rather than anywhere**, for the reason {@link carryingMarker}
 * gives: an issue written *about* this watcher quotes the marker, and matching
 * anywhere in the body adopts it and overwrites what a person wrote.
 */
export function openDebtIssue(issues: readonly KnownIssue[]): KnownIssue | undefined {
  return carryingMarker(issues, DEBT_MARKER)
}

/**
 * The same question asked of the closed corpus (`#1161`).
 *
 * **The most recently closed one wins, and the list is already in that order** —
 * `Issues.closed()` sorts by update time, descending. Where the alarm has been
 * closed more than once over the Colony's life, the one to bring back is the
 * last conversation about it rather than a thread from March.
 */
export function closedDebtIssue(issues: readonly ClosedIssue[]): ClosedIssue | undefined {
  return carryingMarker(issues, DEBT_MARKER)
}

/**
 * Who has to act on each refusal.
 *
 * **This is the field that decides who reads the issue**, which is why `#720`
 * asks for the distinct values rather than a total. `float-exhausted` is ours and
 * urgent; `no-verified-address` is the citizen's and is now hinted (`#719`);
 * `accruing-below-chain-minimum` is a pricing decision taken before the quest was
 * published, which `#718` now states at the point it is taken.
 */
export function whoseRefusal(refusal: PayoutRefusal | null): string {
  switch (refusal) {
    case null:
      return 'never attempted — the reconciler may not be running'
    case 'float-exhausted':
      return "the Colony's: the wallet held less than it owed"
    case 'above-transaction-ceiling':
    case 'above-daily-ceiling':
      return "the Colony's: a limit it sets on itself"
    case 'no-verified-address':
      return "the citizen's: no wallet verified, and it is told so on its next waking (#719)"
    case 'accruing-below-chain-minimum':
      return 'a pricing decision taken before publication (#718)'
    case 'unavailable':
      return 'the chain could not be reached; the next pass retries'
  }
}

/**
 * The one line a session assembling a work package needs, and the timestamp that
 * makes it worth reading (`#919`).
 *
 * **The verdict was already computed and was not written down.** `oursToFix` has
 * decided since `#727` whether anything here is the Colony's, and the body said
 * so in prose — but not *as of when*, which is the whole of the question a
 * package-assembling session is asking. `AGENTS.md` §4 sends it to the Blocked
 * column; the body carries current figures; the only way to learn the answer was
 * to redo the query. `#727` collected six identical blocked-check comments in
 * three days from four sessions, each reaching this sentence by hand.
 *
 * So it is stated, with the moment it was last true, and refreshed on the same
 * pass that refreshes the figures — which costs nothing, because that pass is
 * already rewriting the body.
 *
 * **And it says the finding is not agent work**, which is the second half of
 * `#919`. Nothing in this repository applies the `agent:*` label; the routing
 * pass in `kolonie-docs` reads the issue and decides. A finding with no
 * Colony-side action saying so plainly is the lever this side actually has, and
 * it is addressed to a reader rather than to a parser for that reason.
 */
function dischargeVerdict(
  mine: { readonly count: number; readonly lamports: number },
  confirmedAt: number,
): readonly string[] {
  const at = new Date(confirmedAt).toISOString()

  if (mine.count > 0) {
    return [
      `**${mine.count} of them, totalling ${mine.lamports} lamports, are the Colony’s own to ` +
        'discharge.** That is the urgent part of this issue and the reason it is `p1`.',
      '',
      `Last confirmed ${at}.`,
    ]
  }

  return [
    '**None of it is the Colony’s own to discharge.** Every obligation below is waiting on ' +
      'something outside this runner — a citizen that has not verified a wallet, or a price ' +
      'below the chain floor. Nothing here is a failure to pay; it is money the Colony holds ' +
      'and cannot deliver yet.',
    '',
    `**Nothing on the board discharges this, last confirmed ${at}.** That sentence is the ` +
      'answer to the blocked-check, and it is rewritten every pass — so it needs no query to ' +
      'trust and no comment to record. **This is not agent work while it says so**: there is ' +
      'no Colony-side action to take, so it wants no `agent:*` route and no owner. It clears ' +
      'itself when the third party acts, and the line above changes on the same pass if a debt ' +
      'the Colony *can* act on arrives behind these.',
  ]
}

/** The alarm, as somebody who has to act on it reads it. */
export function debtIssueBody(debt: OutstandingDebt, confirmedAt: number = Date.now()): string {
  const rows = debt.refusals.map(
    (row) =>
      `| ${row.lamports} | ${row.count} | \`${row.refusal ?? 'none recorded'}\` | ` +
      `${whoseRefusal(row.refusal)} |`,
  )

  const mine = oursOnly(debt)

  return [
    DEBT_MARKER,
    oursMarker(mine),
    // Written only while none of it is ours, and rewritten every pass alongside
    // the sentence it agrees with (`#919`). The two cannot drift: both are
    // `mine.count`.
    ...(mine.count > 0 ? [] : [NO_COLONY_ACTION_MARKER]),
    '',
    `**${debt.count} obligation(s) totalling ${debt.lamports} lamports have stood unpaid for ` +
      `more than ${DEBT_THRESHOLD_HOURS} hours.**`,
    '',
    // The line that decides who has to act now, said before the table rather
    // than left to be read out of it (`#727`). Both readings are worth having
    // and only one of them is urgent.
    ...dischargeVerdict(mine, confirmedAt),
    '',
    '| Owed | Obligations | Last refusal | Whose it is to fix |',
    '|---|---|---|---|',
    ...rows,
    '',
    ...(debt.oldestSince === null ? [] : [`The oldest was written ${debt.oldestSince}.`, '']),
    '## What this is not',
    '',
    '**Not the float watcher.** `payout.float.short` asks whether the Colony *can* pay and is ' +
      'silent while the wallet is healthy. This asks whether it *has*. Both were true at once ' +
      'on 2026-08-11, which is the gap this exists for.',
    '',
    '**Not a settlement.** Nothing here forfeits, writes off, or changes what is owed. The ' +
      'alarm reports; anything that reduces a citizen’s balance stays a decision a person makes.',
    '',
    '**Not the citizen-facing half.** Each affected citizen is told on its next waking through ' +
      'the standing hint channel (`#719`). This one is addressed to us.',
    '',
    '**Not silent about what arrives behind it.** While this is open the runner writes nothing ' +
      'for the same debt seen again — but a debt **the Colony can act on**, appearing behind ' +
      'one it cannot, is a new fact and gets a comment here (`#727`). Before that, an open ' +
      'issue absorbed it and nobody was told.',
    '',
    '---',
    '',
    '**Filed by a machine**, by the debt watcher in `apps/support-triage-runner` (`#720`). While ' +
      'the condition holds this issue is not commented on every pass — a debt is a state and ' +
      'not an event, and forty-eight lines a day aimed at a maintainer is noise. **The body is ' +
      'kept current**, which notifies nobody and is therefore not the thing that objection was ' +
      'about (`#727`). ' +
      '**It closes itself** when nothing is outstanding past the threshold, which is the one ' +
      'way it differs from the log detector beside it. **Closing it by hand while the condition ' +
      'holds reopens it** rather than filing a second one (`#1161`): what is owed is measured, ' +
      'so this issue ends when the measurement says nothing is owed and not before.',
  ].join('\n')
}

/**
 * What it says when a debt of the Colony's own arrives behind one that is not.
 *
 * **It repeats the numbers rather than saying "see above"**, because the body it
 * hangs under is by construction the one from when the issue was filed — the
 * whole design is that a standing condition is not rewritten. A comment that
 * referred to a table describing a different day would be worse than no comment.
 */
export function debtEscalationComment(debt: OutstandingDebt): string {
  const mine = debt.refusals.filter((row) => oursToFix(row.refusal))
  const totals = oursOnly(debt)

  return [
    `**${totals.count} obligation(s) totalling ${totals.lamports} lamports are now the Colony’s ` +
      'own to discharge.** That is more than when this issue was filed, so this is a new fact ' +
      'rather than the same debt seen again.',
    '',
    '| Owed | Obligations | Last refusal | Whose it is to fix |',
    '|---|---|---|---|',
    ...mine.map(
      (row) =>
        `| ${row.lamports} | ${row.count} | \`${row.refusal ?? 'none recorded'}\` | ` +
        `${whoseRefusal(row.refusal)} |`,
    ),
    '',
    'The table in the body above is as of filing and has not been rewritten — a debt is a state ' +
      'and this runner does not comment on one repeating. It comments on this, because until ' +
      '`#727` an open issue absorbed it: the alarm for *the Colony has not paid* was held open ' +
      'by obligations no pass of it could ever clear, and the case it exists for arrived behind ' +
      'them in silence.',
  ].join('\n')
}

/** What it says on the way out. */
export function debtClosingComment(): string {
  return (
    'Nothing has stood unpaid past the threshold on this pass, so the condition has ended and ' +
    'this closes itself. A **new** debt standing longer than ' +
    `${DEBT_THRESHOLD_HOURS} hours gets a new issue — the alarm reports a state, so that is a ` +
    'new occurrence rather than a duplicate. A debt written *before* this closure and still ' +
    'outstanding reopens this one instead, because the closure would not have ended it (`#1161`).'
  )
}

/**
 * What it says on the way back in (`#1161`).
 *
 * **Addressed to the person who closed it, and it does not tell them they were
 * wrong.** Closing an issue is a reasonable thing to do with one that has been
 * open for days; what they could not know is that the alarm underneath it is a
 * measurement rather than a report. So this says what is owed *now* and why the
 * issue came back, and leaves the body below to carry the table.
 */
export function debtReopeningComment(debt: OutstandingDebt): string {
  return [
    `**Reopened: ${debt.count} obligation(s) totalling ${debt.lamports} lamports are still ` +
      `outstanding past ${DEBT_THRESHOLD_HOURS} hours.**`,
    '',
    'This alarm reports a condition the Colony measures rather than an event somebody observed, ' +
      'so it ends when the measurement says nothing is owed and not when the issue is closed. ' +
      'Closing it while money is outstanding used to file a second issue instead — `#867` beside ' +
      '`#727` — which somebody then had to read and close by hand.',
    '',
    'The body above has been rewritten with what is owed on this pass. It closes itself, without ' +
      'anybody doing anything, once nothing has stood unpaid past the threshold.',
  ].join('\n')
}

export interface DebtWatchDependencies {
  readonly issues: Issues
  measure(): Promise<OutstandingDebt>
  /**
   * When this pass ran, for the *last confirmed* stamp on the verdict (`#919`).
   *
   * Injected on the convention `logs.ts` and `watch.ts` already use here, and
   * for the reason they use it: a timestamp read from the ambient clock makes
   * the body of this issue untestable, and the body is now where the answer to
   * the blocked-check lives.
   */
  readonly now?: () => number
}

export interface DebtWatchOutcome {
  readonly action: DebtAction['kind']
  readonly count: number
  readonly lamports: number
  /** Set when the pass did nothing because a seam could not be read. */
  readonly skipped?: 'no-app' | 'unreadable'
}

/**
 * One pass of the debt watcher.
 *
 * **It does not act when it cannot read GitHub**, on the same argument the log
 * detector gives: an empty corpus is indistinguishable from an unreadable one,
 * and filing against that opens a fresh alarm every half hour for a condition
 * that already had an issue.
 *
 * There are two ways not to be able to read it, and until `#867` this checked
 * only the first. No App is decided once, at construction, and `available`
 * carries it. **A pass that has an App and could not use it is the other**, and
 * it is the one that actually happened: on 2026-08-13 at 14:37:04 GitHub
 * answered the installation listing with a 500 (`#868`), `open()` answered `[]`
 * two seconds before this filed `#867`, and the alarm it duplicated — `#727` —
 * had been open for two days.
 *
 * The condition is read from the database and is not in doubt; what is in doubt
 * is only whether an issue already says so. So it is `DEBT_REPOSITORY` that has
 * to have been readable, and not the other two: a debt is still a debt when
 * `kolonie-infra` cannot be listed.
 */
export async function watchDebt(deps: DebtWatchDependencies): Promise<DebtWatchOutcome> {
  const now = deps.now ?? Date.now
  const debt = await deps.measure()
  if (!deps.issues.available) {
    return { action: 'quiet', count: debt.count, lamports: debt.lamports, skipped: 'no-app' }
  }

  const corpus = await deps.issues.open()
  if (corpus.unreadable.includes(DEBT_REPOSITORY)) {
    return { action: 'quiet', count: debt.count, lamports: debt.lamports, skipped: 'unreadable' }
  }

  // **The closed corpus is read only when nothing is open**, which is the only
  // state its answer could change — and it is a page per repository, so asking
  // on every pass would be three requests to learn nothing on the passes where
  // the alarm is already standing.
  //
  // It carries no `unreadable` list of its own, so a repository that answered a
  // 500 is indistinguishable here from one with nothing closed. That resolves to
  // `file`, which is what this did before `#1161` — the duplicate is bad and the
  // silence about money owed would be worse.
  const open = openDebtIssue(corpus.issues)
  const action = decideDebt(debt, open, open === undefined ? await deps.issues.closed() : [])

  if (action.kind === 'file') {
    await deps.issues.create({
      repository: DEBT_REPOSITORY,
      title: DEBT_TITLE,
      body: debtIssueBody(debt, now()),
      // `from:watcher` because nobody read this before it was filed, and `p1`
      // because an undischarged debt is the Colony failing at the one promise
      // every other claim it makes rests on.
      labels: ['from:watcher', 'area:platform', 'p1'],
    })
  }

  // **The comment is the notification and the body is the record** (`#727`).
  //
  // Only an escalation writes a comment, because only an escalation is a new
  // fact: a debt the Colony can act on arriving behind one it cannot. The same
  // debt seen again writes nothing, exactly as before.
  //
  // The body is rewritten on **every** standing pass, and that does not
  // contradict the paragraph above it. The objection to speaking on a standing
  // condition was to forty-eight comments a day aimed at a maintainer; a body
  // edit notifies nobody. So the numbers stay current for free, and the marker
  // this alarm reads back next pass stays true — a marker it could write and
  // never update would answer the same way forever.
  if (action.kind === 'escalate') {
    await deps.issues.comment(action.issue.url, debtEscalationComment(debt))
    await deps.issues.revise(action.issue.url, debtIssueBody(debt, now()))
  }

  if (action.kind === 'standing')
    await deps.issues.revise(action.issue.url, debtIssueBody(debt, now()))

  if (action.kind === 'close') await deps.issues.close(action.issue.url, debtClosingComment())

  // The reopen carries the comment; the body is rewritten after it, on the same
  // argument as `standing` — the table has to describe this pass and not the day
  // the issue was originally filed.
  if (action.kind === 'reopen') {
    await deps.issues.reopen(action.issue.url, debtReopeningComment(debt))
    await deps.issues.revise(action.issue.url, debtIssueBody(debt, now()))
  }

  return { action: action.kind, count: debt.count, lamports: debt.lamports }
}
