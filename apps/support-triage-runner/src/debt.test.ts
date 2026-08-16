import { describe, expect, it, vi } from 'vitest'
import type { OutstandingDebt } from '@kolonie-ai/db'
import { noIssues, type Issues, type KnownIssue } from './github.js'
import {
  DEBT_MARKER,
  DEBT_REPOSITORY,
  DEBT_THRESHOLD_HOURS,
  NO_COLONY_ACTION_MARKER,
  debtEscalationComment,
  debtIssueBody,
  decideDebt,
  openDebtIssue,
  oursOnly,
  oursToFix,
  recordedOurs,
  watchDebt,
  whoseRefusal,
} from './debt.js'

/** The state measured in production on 2026-08-11, which is what `#720` is about. */
const theTwoDebts: OutstandingDebt = {
  count: 2,
  lamports: 1_125_000,
  refusals: [
    { refusal: 'no-verified-address', count: 1, lamports: 750_000 },
    { refusal: 'accruing-below-chain-minimum', count: 1, lamports: 375_000 },
  ],
  oldestSince: '2026-08-09T22:28:00.000Z',
}

const nothingOwed: OutstandingDebt = { count: 0, lamports: 0, refusals: [], oldestSince: null }

/**
 * The state measured in production on 2026-08-14, five days into `#727` — the
 * same two kinds, now three obligations, and still nothing the Colony can do.
 */
const threeDebtsNoneOurs: OutstandingDebt = {
  count: 3,
  lamports: 2_125_000,
  refusals: [
    { refusal: 'no-verified-address', count: 2, lamports: 1_750_000 },
    { refusal: 'accruing-below-chain-minimum', count: 1, lamports: 375_000 },
  ],
  oldestSince: '2026-08-09T22:28:00.000Z',
}

/** The same, with a debt the Colony itself failed to pay arriving behind them. */
const andOneOfOurs: OutstandingDebt = {
  count: 4,
  lamports: 3_125_000,
  refusals: [
    { refusal: 'no-verified-address', count: 2, lamports: 1_750_000 },
    { refusal: 'float-exhausted', count: 1, lamports: 1_000_000 },
    { refusal: 'accruing-below-chain-minimum', count: 1, lamports: 375_000 },
  ],
  oldestSince: '2026-08-09T22:28:00.000Z',
}

const anIssue = (body: string): KnownIssue => ({
  repository: DEBT_REPOSITORY,
  number: 721,
  title: 'The Colony owes money it has not paid',
  body,
  url: 'https://github.com/Kolonie-AI/kolonie-platform/issues/721',
})

/** An `Issues` that records what it was asked to do and reaches nothing. */
function spyIssues(
  open: readonly KnownIssue[] = [],
  unreadable: readonly string[] = [],
): Issues & {
  readonly created: unknown[]
  readonly closed_: unknown[]
  readonly commented: { url: string; body: string }[]
  readonly revised: { url: string; body: string }[]
} {
  const created: unknown[] = []
  const closed_: unknown[] = []
  const commented: { url: string; body: string }[] = []
  const revised: { url: string; body: string }[] = []
  return {
    available: true,
    open: async () => ({ issues: open, unreadable }),
    closed: async () => [],
    create: async (issue) => {
      created.push(issue)
      return 'https://github.com/Kolonie-AI/kolonie-platform/issues/721'
    },
    comment: async (url, body) => {
      commented.push({ url, body })
      return true
    },
    revise: async (url, body) => {
      revised.push({ url, body })
      return true
    },
    close: async (url, comment) => {
      closed_.push({ url, comment })
      return true
    },
    created,
    closed_,
    commented,
    revised,
  }
}

describe('deciding what to do about a debt', () => {
  it('files when there is a condition and nothing open says so', () => {
    expect(decideDebt(theTwoDebts, undefined)).toEqual({ kind: 'file' })
  })

  /**
   * One issue for the condition, not one per obligation and not one per
   * reconciliation run. Two obligations produced one finding above and this is
   * what stops the next pass producing a second issue.
   */
  it('stands rather than filing again while the same issue is open', () => {
    const open = anIssue(DEBT_MARKER)

    expect(decideDebt(theTwoDebts, open)).toEqual({ kind: 'standing', issue: open })
  })

  it('closes itself when nothing is outstanding past the threshold', () => {
    const open = anIssue(DEBT_MARKER)

    expect(decideDebt(nothingOwed, open)).toEqual({ kind: 'close', issue: open })
  })

  it('says nothing at all when there is no condition and no issue', () => {
    expect(decideDebt(nothingOwed, undefined)).toEqual({ kind: 'quiet' })
  })

  /** The marker and never the title, which anybody may edit. */
  it('recognises its own issue by the marker rather than by the title', () => {
    expect(openDebtIssue([anIssue('some other alarm entirely')])).toBeUndefined()
    expect(openDebtIssue([anIssue(`${DEBT_MARKER}\n<!-- ours: count=2 -->`)])).toBeDefined()
  })

  /**
   * **The marker on the first line, not anywhere in the body**, and this
   * assertion is the inverse of what it used to make. Matching anywhere adopts
   * any issue that *discusses* this alarm — which is what happened to `#946`
   * next door, where the draft watcher rewrote a person's issue twelve minutes
   * after it was filed because it quoted a marker in a code fence.
   */
  it('does not adopt an issue that merely quotes its marker', () => {
    expect(openDebtIssue([anIssue(`prose\n${DEBT_MARKER}\nmore prose`)])).toBeUndefined()
  })
})

describe('what the alarm says', () => {
  it('carries the count, the total, and each distinct refusal', () => {
    const body = debtIssueBody(theTwoDebts)

    expect(body).toContain('2 obligation(s) totalling 1125000 lamports')
    expect(body).toContain('`no-verified-address`')
    expect(body).toContain('`accruing-below-chain-minimum`')
    expect(body).toContain('750000')
    expect(body).toContain('375000')
    expect(body).toContain(String(DEBT_THRESHOLD_HOURS))
  })

  /**
   * *Which* refusal is what decides who fixes it, which is why `#720` asks for
   * the distinct values rather than a total.
   */
  it('says whose each refusal is to fix', () => {
    expect(whoseRefusal('float-exhausted')).toContain("the Colony's")
    expect(whoseRefusal('no-verified-address')).toContain("the citizen's")
    expect(whoseRefusal('accruing-below-chain-minimum')).toContain('pricing decision')
    // An obligation past the threshold that has never been attempted is a
    // reconciler that is not running, which no refusal would name.
    expect(whoseRefusal(null)).toContain('reconciler')
  })

  it('states what it is not, so it is not read as the float watcher or a settlement', () => {
    const body = debtIssueBody(theTwoDebts)

    expect(body).toContain('payout.float.short')
    expect(body).toContain('Not a settlement')
    expect(body).toContain('closes itself')
  })
})

describe('one pass of the watcher', () => {
  it('files into the platform, labelled as a machine finding', async () => {
    const issues = spyIssues()

    const outcome = await watchDebt({ issues, measure: async () => theTwoDebts })

    expect(outcome.action).toBe('file')
    expect(issues.created).toHaveLength(1)
    expect(issues.created[0]).toMatchObject({
      repository: DEBT_REPOSITORY,
      labels: ['from:watcher', 'area:platform', 'p1'],
    })
  })

  it('closes the standing issue, saying why, when the debt is gone', async () => {
    const issues = spyIssues([anIssue(DEBT_MARKER)])

    const outcome = await watchDebt({ issues, measure: async () => nothingOwed })

    expect(outcome.action).toBe('close')
    expect(issues.closed_).toHaveLength(1)
    expect((issues.closed_[0] as { comment: string }).comment).toContain('condition has ended')
    expect(issues.created).toHaveLength(0)
  })

  it('writes nothing while the condition simply continues', async () => {
    const issues = spyIssues([anIssue(DEBT_MARKER)])

    const outcome = await watchDebt({ issues, measure: async () => theTwoDebts })

    expect(outcome.action).toBe('standing')
    expect(issues.created).toHaveLength(0)
    expect(issues.closed_).toHaveLength(0)
  })

  /**
   * The rejection case that matters. With no App, `open()` answers `[]` — and an
   * empty corpus is indistinguishable from an unreadable one, so filing against
   * it would open a fresh alarm every half hour for a condition that already had
   * an issue.
   */
  it('does not file when it cannot read GitHub at all', async () => {
    const create = vi.fn()

    const outcome = await watchDebt({
      issues: { ...noIssues, create },
      measure: async () => theTwoDebts,
    })

    expect(outcome.skipped).toBe('no-app')
    expect(outcome.count).toBe(2)
    expect(create).not.toHaveBeenCalled()
  })

  /**
   * `#867`, as a case. The App was configured and `available` was true; GitHub
   * answered the installation listing with a 500 (`#868`), the corpus came back
   * empty, and the watcher filed a second copy of an alarm that had been open
   * since 2026-08-11. An empty corpus and an unreadable one are the same
   * corpus — the difference has to be carried, and this is it.
   */
  it('does not file when the App is configured and the listing failed anyway', async () => {
    const issues = spyIssues([], [DEBT_REPOSITORY])

    const outcome = await watchDebt({ issues, measure: async () => theTwoDebts })

    expect(outcome.skipped).toBe('unreadable')
    expect(outcome.action).toBe('quiet')
    expect(outcome.count).toBe(2)
    expect(issues.created).toHaveLength(0)
  })

  /**
   * And only that repository. The condition is read from the database and is not
   * in doubt; what is in doubt is whether an issue already says so, which is a
   * question about `DEBT_REPOSITORY` alone. A debt is still a debt when
   * `kolonie-infra` cannot be listed.
   */
  it('files anyway when the repository that failed is not the one it files into', async () => {
    const issues = spyIssues([], ['Kolonie-AI/kolonie-infra'])

    const outcome = await watchDebt({ issues, measure: async () => theTwoDebts })

    expect(outcome.skipped).toBeUndefined()
    expect(outcome.action).toBe('file')
    expect(issues.created).toHaveLength(1)
  })
})

/**
 * Whose debt it is, and what the alarm does about it (`#727`).
 *
 * ## The defect these are about
 *
 * `#727` stood open for five days on obligations that no pass of this runner
 * could ever clear — `no-verified-address` is the citizen's and
 * `accruing-below-chain-minimum` is a pricing decision already taken. The alarm
 * was right to file for them: `#720`'s founding measurement was two obligations
 * of exactly those kinds, and surfacing them is what produced `#719` and `#718`.
 *
 * What was wrong is what happened **next**. `decideDebt` answered `standing` on
 * every subsequent pass, and `standing` writes nothing by design — so an issue
 * that could not close absorbed everything that arrived behind it. A
 * `float-exhausted` obligation, the Colony unable to pay what it owes and the
 * condition this whole watcher exists for, would have produced **no signal at
 * all**.
 *
 * So the condition is unchanged and the silence is not: the same debt again is
 * still silent, and a debt of the Colony's own arriving behind one that is not
 * gets said once.
 */
describe('whose debt it is', () => {
  it('counts a refusal only the citizen or a past decision can clear as not ours', () => {
    expect(oursToFix('no-verified-address')).toBe(false)
    expect(oursToFix('accruing-below-chain-minimum')).toBe(false)
  })

  it('counts every refusal the Colony could act on as ours', () => {
    expect(oursToFix('float-exhausted')).toBe(true)
    expect(oursToFix('above-transaction-ceiling')).toBe(true)
    expect(oursToFix('above-daily-ceiling')).toBe(true)
    expect(oursToFix('unavailable')).toBe(true)
  })

  /**
   * Past the threshold and never attempted is the reconciler not running, which
   * is ours and is the most urgent of the lot: nothing is being paid at all.
   */
  it('counts an obligation nothing ever attempted as ours', () => {
    expect(oursToFix(null)).toBe(true)
  })

  it('adds up only the Colony’s own share', () => {
    expect(oursOnly(threeDebtsNoneOurs)).toEqual({ count: 0, lamports: 0 })
    expect(oursOnly(andOneOfOurs)).toEqual({ count: 1, lamports: 1_000_000 })
  })
})

describe('a debt of the Colony’s own arriving behind one that is not', () => {
  /**
   * The whole of `#727`. Before this, an open issue absorbed it: `standing`,
   * nothing written, nobody told.
   */
  it('is said once, rather than absorbed by the open issue', () => {
    const open = anIssue(debtIssueBody(threeDebtsNoneOurs))

    expect(decideDebt(andOneOfOurs, open)).toEqual({ kind: 'escalate', issue: open })
  })

  it('is not said again on the next pass, because the body now records it', () => {
    const afterEscalating = anIssue(debtIssueBody(andOneOfOurs))

    expect(decideDebt(andOneOfOurs, afterEscalating)).toEqual({
      kind: 'standing',
      issue: afterEscalating,
    })
  })

  /**
   * **The rejection case.** More obligations, none of them ours: the same state
   * this alarm has been sitting on for five days, and it must stay silent. An
   * alarm that spoke here would be the forty-eight-lines-a-day failure `#720`
   * refused, arriving by a different route.
   */
  it('says nothing when the debt grows but none of the growth is ours', () => {
    const open = anIssue(debtIssueBody(theTwoDebts))

    expect(decideDebt(threeDebtsNoneOurs, open)).toEqual({ kind: 'standing', issue: open })
  })

  /**
   * The other rejection case: our share shrinking is not an escalation. An
   * obligation we paid is good news and the body records it silently.
   */
  it('says nothing when the Colony’s own share falls', () => {
    const open = anIssue(debtIssueBody(andOneOfOurs))

    expect(decideDebt(threeDebtsNoneOurs, open)).toEqual({ kind: 'standing', issue: open })
  })

  /**
   * An issue filed before the marker existed reads as zero, which makes the
   * first pass after this ships treat any Colony-side debt as newly arrived.
   * That is the safe direction: reading it as *unknown, so stay quiet* would
   * make the deploy itself a reason to miss the thing this is for.
   */
  it('treats an issue filed before the marker existed as having recorded nothing', () => {
    expect(recordedOurs(DEBT_MARKER)).toBe(0)
    expect(decideDebt(andOneOfOurs, anIssue(DEBT_MARKER))).toEqual({
      kind: 'escalate',
      issue: anIssue(DEBT_MARKER),
    })
  })

  it('repeats the numbers rather than pointing at a table from another day', () => {
    const said = debtEscalationComment(andOneOfOurs)

    expect(said).toContain('1000000')
    expect(said).toContain('float-exhausted')
    expect(said).toContain('as of filing')
    // The citizen-side rows are not in the escalation: what is new is ours.
    expect(said).not.toContain('no-verified-address')
  })
})

describe('what the alarm keeps current', () => {
  /**
   * The body is rewritten every standing pass and the objection to speaking on a
   * standing condition is untouched. They are different acts: a comment notifies
   * everybody watching, a body edit notifies nobody. `#720` argued against
   * forty-eight comments a day, which is what it said, and this was read for
   * years afterwards as an argument for the numbers being wrong.
   */
  it('rewrites the body on a standing pass, and comments on nothing', async () => {
    const issues = spyIssues([anIssue(debtIssueBody(threeDebtsNoneOurs))])

    const outcome = await watchDebt({ issues, measure: async () => threeDebtsNoneOurs })

    expect(outcome.action).toBe('standing')
    expect(issues.revised).toHaveLength(1)
    expect(issues.commented).toHaveLength(0)
    expect(issues.created).toHaveLength(0)
  })

  it('comments and rewrites when the Colony’s own share has grown', async () => {
    const issues = spyIssues([anIssue(debtIssueBody(threeDebtsNoneOurs))])

    const outcome = await watchDebt({ issues, measure: async () => andOneOfOurs })

    expect(outcome.action).toBe('escalate')
    expect(issues.commented).toHaveLength(1)
    expect(issues.commented[0]?.body).toContain('float-exhausted')
    expect(issues.revised).toHaveLength(1)
    expect(issues.created).toHaveLength(0)
  })

  it('says in the body which part of the debt is the Colony’s own', () => {
    expect(debtIssueBody(threeDebtsNoneOurs)).toContain('None of it is the Colony')
    expect(debtIssueBody(andOneOfOurs)).toContain('are the Colony')
  })
})

/**
 * `#919`: what the six identical blocked-check comments on `#727` were each
 * establishing by hand, written into the body that is rewritten anyway.
 *
 * The waste was structural rather than anybody's oversight. A session assembling
 * a work package is sent to the Blocked column, finds a `p1` carrying an agent
 * label, and can only learn it needs nothing by redoing the query — then writes
 * the conclusion as a comment, where the next session does not read it before
 * repeating the work.
 */
describe('the blocked-check the body answers by itself', () => {
  /** A fixed moment, so the sentence under test is a string and not a clock. */
  const noon = Date.parse('2026-08-14T12:00:00.000Z')

  it('states that nothing on the board discharges it, and when that was last true', () => {
    const said = debtIssueBody(threeDebtsNoneOurs, noon)

    expect(said).toContain('Nothing on the board discharges this')
    expect(said).toContain('last confirmed 2026-08-14T12:00:00.000Z')
  })

  it('says it is not agent work, which is what put it into package assembly', () => {
    const said = debtIssueBody(threeDebtsNoneOurs, noon)

    expect(said).toContain('not agent work')
    expect(said).toContain('`agent:*`')
  })

  /**
   * The claim is *nothing here is ours*, so it must not be made about a debt
   * that is. A verdict that read the same either way would be worse than none:
   * the next session would learn to distrust it and go back to the query.
   */
  it('makes no such claim when the Colony has its own share to discharge', () => {
    const said = debtIssueBody(andOneOfOurs, noon)

    expect(said).not.toContain('Nothing on the board discharges this')
    expect(said).not.toContain('not agent work')
    // Still stamped, because *as of when* is the question in both directions.
    expect(said).toContain('Last confirmed 2026-08-14T12:00:00.000Z')
  })

  /**
   * A stamp written once and never refreshed answers the same way forever, which
   * is the failure mode `recordedOurs`' marker was given the same treatment for.
   * The standing pass already rewrites the body; this rides on it.
   */
  it('is refreshed on every standing pass rather than fixed at filing', async () => {
    const issues = spyIssues([anIssue(debtIssueBody(threeDebtsNoneOurs, noon))])

    const later = noon + 7 * 3_600_000
    const outcome = await watchDebt({
      issues,
      measure: async () => threeDebtsNoneOurs,
      now: () => later,
    })

    expect(outcome.action).toBe('standing')
    expect(issues.revised[0]?.body).toContain('last confirmed 2026-08-14T19:00:00.000Z')
    expect(issues.commented).toHaveLength(0)
  })

  /**
   * The prose above is addressed to a reader, and the reader that kept getting
   * this wrong is a script: `board-triage.sh` routes anything it cannot place to
   * `agent:claude`, so the finding was handed to an agent on every pass. The
   * marker is the same verdict in the one form that pass can act on, and the two
   * are written from the same `mine.count` so they cannot disagree.
   */
  it('carries the marker the routing pass reads, so it is not routed to an agent', () => {
    expect(debtIssueBody(threeDebtsNoneOurs, noon)).toContain(NO_COLONY_ACTION_MARKER)
  })

  it('drops the marker the moment a debt the Colony can act on arrives behind it', () => {
    expect(debtIssueBody(andOneOfOurs, noon)).not.toContain(NO_COLONY_ACTION_MARKER)
  })

  it('carries the stamp on the pass that files it', async () => {
    const issues = spyIssues([])

    await watchDebt({ issues, measure: async () => threeDebtsNoneOurs, now: () => noon })

    expect(issues.created[0]).toMatchObject({
      body: expect.stringContaining('last confirmed 2026-08-14T12:00:00.000Z'),
    })
  })
})
