import type { PayoutRefusal } from '@kolonie-ai/core'
import type { OutstandingDebt } from '@kolonie-ai/db'
import type { Issues, KnownIssue } from './github.js'

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
 * The detector next door reads Loki and **never closes an issue**, deliberately:
 * a model's reading of an error line is a finding, and whether a finding is dealt
 * with is a person's call. This is a different class of thing. The condition is
 * one SQL query with a precise end — *nothing is outstanding past the threshold*
 * — so it can close itself, which is the shape Health Watch already has in
 * `kolonie-infra`. It shares the runner's GitHub App and its half-hour tick and
 * nothing else.
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

/** What the runner should do about the debt it just measured. Arithmetic alone. */
export type DebtAction =
  /** Nothing is outstanding and nothing is open. The ordinary answer. */
  | { readonly kind: 'quiet' }
  /** There is a condition and nothing open says so. */
  | { readonly kind: 'file' }
  /** There is a condition and an open issue already says so. */
  | { readonly kind: 'standing'; readonly issue: KnownIssue }
  /** The condition has ended and the issue it opened is still open. */
  | { readonly kind: 'close'; readonly issue: KnownIssue }

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
 */
export function decideDebt(debt: OutstandingDebt, open: KnownIssue | undefined): DebtAction {
  if (debt.count === 0)
    return open === undefined ? { kind: 'quiet' } : { kind: 'close', issue: open }
  return open === undefined ? { kind: 'file' } : { kind: 'standing', issue: open }
}

/** The open issue carrying this alarm's marker, if there is one. */
export function openDebtIssue(issues: readonly KnownIssue[]): KnownIssue | undefined {
  return issues.find((issue) => issue.body.includes(DEBT_MARKER))
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

/** The alarm, as somebody who has to act on it reads it. */
export function debtIssueBody(debt: OutstandingDebt): string {
  const rows = debt.refusals.map(
    (row) =>
      `| ${row.lamports} | ${row.count} | \`${row.refusal ?? 'none recorded'}\` | ` +
      `${whoseRefusal(row.refusal)} |`,
  )

  return [
    DEBT_MARKER,
    '',
    `**${debt.count} obligation(s) totalling ${debt.lamports} lamports have stood unpaid for ` +
      `more than ${DEBT_THRESHOLD_HOURS} hours.**`,
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
    '---',
    '',
    '**Filed by a machine**, by the debt watcher in `apps/support-triage-runner` (`#720`). While ' +
      'the condition holds this issue is left exactly as it is rather than commented on every ' +
      'pass — a debt is a state and not an event, and the numbers above are as of filing. ' +
      '**It closes itself** when nothing is outstanding past the threshold, which is the one ' +
      'way it differs from the log detector beside it. Closing it by hand while the condition ' +
      'holds files it again.',
  ].join('\n')
}

/** What it says on the way out. */
export function debtClosingComment(): string {
  return (
    'Nothing has stood unpaid past the threshold on this pass, so the condition has ended and ' +
    'this closes itself. It is filed again if the Colony carries an undischarged debt for more ' +
    `than ${DEBT_THRESHOLD_HOURS} hours again — the alarm reports a state, so a new issue ` +
    'means a new occurrence rather than a duplicate.'
  )
}

export interface DebtWatchDependencies {
  readonly issues: Issues
  measure(): Promise<OutstandingDebt>
}

export interface DebtWatchOutcome {
  readonly action: DebtAction['kind']
  readonly count: number
  readonly lamports: number
  /** Set when the pass did nothing because a seam could not be read. */
  readonly skipped?: 'no-app'
}

/**
 * One pass of the debt watcher.
 *
 * **It does not act when it cannot read GitHub**, on the same argument the log
 * detector gives: with no App, `open()` answers `[]`, and an empty corpus is
 * indistinguishable from an unreadable one. Filing against that would open a
 * fresh alarm every half hour for a condition that already had an issue.
 */
export async function watchDebt(deps: DebtWatchDependencies): Promise<DebtWatchOutcome> {
  const debt = await deps.measure()
  if (!deps.issues.available) {
    return { action: 'quiet', count: debt.count, lamports: debt.lamports, skipped: 'no-app' }
  }

  const action = decideDebt(debt, openDebtIssue(await deps.issues.open()))

  if (action.kind === 'file') {
    await deps.issues.create({
      repository: DEBT_REPOSITORY,
      title: DEBT_TITLE,
      body: debtIssueBody(debt),
      // `from:watcher` because nobody read this before it was filed, and `p1`
      // because an undischarged debt is the Colony failing at the one promise
      // every other claim it makes rests on.
      labels: ['from:watcher', 'area:platform', 'p1'],
    })
  }

  if (action.kind === 'close') await deps.issues.close(action.issue.url, debtClosingComment())

  return { action: action.kind, count: debt.count, lamports: debt.lamports }
}
