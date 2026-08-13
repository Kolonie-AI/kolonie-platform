import { describe, expect, it, vi } from 'vitest'
import type { OutstandingDebt } from '@kolonie-ai/db'
import { noIssues, type Issues, type KnownIssue } from './github.js'
import {
  DEBT_MARKER,
  DEBT_REPOSITORY,
  DEBT_THRESHOLD_HOURS,
  debtIssueBody,
  decideDebt,
  openDebtIssue,
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
} {
  const created: unknown[] = []
  const closed_: unknown[] = []
  return {
    available: true,
    open: async () => ({ issues: open, unreadable }),
    closed: async () => [],
    create: async (issue) => {
      created.push(issue)
      return 'https://github.com/Kolonie-AI/kolonie-platform/issues/721'
    },
    comment: async () => true,
    close: async (url, comment) => {
      closed_.push({ url, comment })
      return true
    },
    created,
    closed_,
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
    expect(openDebtIssue([anIssue(`prose\n${DEBT_MARKER}\nmore prose`)])).toBeDefined()
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
