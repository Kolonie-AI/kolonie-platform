import { describe, expect, it } from 'vitest'
import type { WithdrawnDraftQueue } from '@kolonie-ai/db'
import { noIssues, type Issues, type KnownIssue } from './github.js'
import {
  DRAFT_MARKER,
  DRAFT_REPOSITORY,
  DRAFT_WINDOW_DAYS,
  decideDrafts,
  draftClosingComment,
  draftEscalationComment,
  draftIssueBody,
  openDraftIssue,
  recordedWithdrawn,
  watchDrafts,
} from './drafts.js'

/**
 * A week in which the Colony threw four walks away — the condition `#946`
 * repointed this watcher at, on the four entries `#917` measured waiting.
 *
 * **Two of the four are held on the same thing**, and that is the shape the alarm
 * exists to make visible: a rewrite rule refusing material looks like a run of
 * identical reasons, and a walker recording nothing looks like a run of a
 * different identical reason.
 */
const theFourWithdrawals: WithdrawnDraftQueue = {
  count: 4,
  drafts: [
    {
      kind: 'code-hosting',
      provider: 'clawhub.example',
      category: 'code-hosting',
      since: '2026-08-12T07:26:52.000Z',
      heldOn: 'The sentence on step 2 is still the Colony’s to write.',
    },
    {
      kind: 'phone',
      provider: 'agentmessage.example',
      category: 'telephony',
      since: '2026-08-13T01:42:21.000Z',
      heldOn: 'The sentence on step 2 is still the Colony’s to write.',
    },
    {
      kind: 'code-hosting',
      provider: 'flow.example',
      category: 'code-hosting',
      since: '2026-08-13T01:44:38.000Z',
      heldOn: 'Step 3 recorded no instruction.',
    },
    {
      kind: 'social',
      provider: 'ieji.example',
      category: 'social-publishing',
      since: '2026-08-13T01:44:52.000Z',
      heldOn: null,
    },
  ],
  oldestSince: '2026-08-12T07:26:52.000Z',
}

const quietWeek: WithdrawnDraftQueue = { count: 0, drafts: [], oldestSince: null }

const aFifthWithdrawal: WithdrawnDraftQueue = {
  ...theFourWithdrawals,
  count: 5,
  drafts: [
    ...theFourWithdrawals.drafts,
    {
      kind: 'mailbox',
      provider: 'later.example',
      category: 'mailbox',
      since: '2026-08-14T09:00:00.000Z',
      heldOn: 'The sentence on step 2 is still the Colony’s to write.',
    },
  ],
}

const anIssue = (body: string): KnownIssue => ({
  repository: DRAFT_REPOSITORY,
  number: 920,
  title: 'Walked recipes are being withdrawn without publishing',
  body,
  url: 'https://github.com/Kolonie-AI/kolonie-platform/issues/920',
})

/** An `Issues` that records what it was asked to do and reaches nothing. */
function spyIssues(
  open: readonly KnownIssue[] = [],
  unreadable: readonly string[] = [],
): Issues & {
  readonly created: { repository: string; title: string; body: string; labels: string[] }[]
  readonly closed_: { url: string; comment: string }[]
  readonly commented: { url: string; body: string }[]
  readonly revised: { url: string; body: string }[]
} {
  const created: { repository: string; title: string; body: string; labels: string[] }[] = []
  const closed_: { url: string; comment: string }[] = []
  const commented: { url: string; body: string }[] = []
  const revised: { url: string; body: string }[] = []
  return {
    available: true,
    open: async () => ({ issues: open, unreadable }),
    closed: async () => [],
    create: async (issue) => {
      created.push({
        repository: issue.repository,
        title: issue.title,
        body: issue.body,
        labels: [...(issue.labels ?? [])],
      })
      return 'https://github.com/Kolonie-AI/kolonie-platform/issues/920'
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

describe('deciding what to do about walks the Colony threw away', () => {
  it('files when walks have been withdrawn and nothing open says so', () => {
    expect(decideDrafts(theFourWithdrawals, undefined)).toEqual({ kind: 'file' })
  })

  /**
   * One issue for the condition, not one per withdrawal. Four withdrawals are one
   * reading, and this is what stops the next pass producing a second issue.
   */
  it('stands rather than filing again while the same issue is open', () => {
    const open = anIssue(`${DRAFT_MARKER}\n<!-- withdrawn: count=4 -->`)

    expect(decideDrafts(theFourWithdrawals, open)).toEqual({ kind: 'standing', issue: open })
  })

  /**
   * **The run growing is an event where the run standing still is a state.** A
   * fifth withdrawal after somebody was told about four means the Colony is still
   * throwing walks away, which is a different fact from four having been thrown.
   */
  it('escalates once when more have been withdrawn under an open alarm', () => {
    const open = anIssue(`${DRAFT_MARKER}\n<!-- withdrawn: count=4 -->`)

    expect(decideDrafts(aFifthWithdrawal, open)).toEqual({ kind: 'escalate', issue: open })
  })

  /**
   * The rejection case for the escalation, and the window is what makes it
   * reachable: withdrawals ageing out of the week is the ordinary way this number
   * falls, and it is not news.
   */
  it('stays silent when the week behind it has got quieter', () => {
    const open = anIssue(`${DRAFT_MARKER}\n<!-- withdrawn: count=5 -->`)

    expect(decideDrafts(theFourWithdrawals, open)).toEqual({ kind: 'standing', issue: open })
  })

  /**
   * **Closing is by a quiet week and not by anybody clearing anything.** The rows
   * this alarm listed are withdrawn and stay withdrawn; the condition it reports
   * is a rate, so it ends on its own or not at all.
   */
  it('closes itself once nothing has been withdrawn inside the window', () => {
    const open = anIssue(DRAFT_MARKER)

    expect(decideDrafts(quietWeek, open)).toEqual({ kind: 'close', issue: open })
  })

  it('is quiet when nothing was withdrawn and nothing is open', () => {
    expect(decideDrafts(quietWeek, undefined)).toEqual({ kind: 'quiet' })
  })

  /**
   * An issue filed before the marker existed reads as zero, which is the safe
   * direction: the first pass after this ships says it once rather than treating
   * its own deploy as a reason to stay quiet.
   */
  it('reads a body with no marker as no run at all', () => {
    expect(recordedWithdrawn('nothing here')).toBe(0)
    expect(recordedWithdrawn('<!-- withdrawn: count=7 -->')).toBe(7)
  })

  it('finds its own alarm by marker rather than by title', () => {
    const mine = anIssue(DRAFT_MARKER)
    const somebodyElse = anIssue('<!-- watch-finding: payout-debt-outstanding -->')

    expect(openDraftIssue([somebodyElse, mine])).toBe(mine)
    expect(openDraftIssue([somebodyElse])).toBeUndefined()
  })

  /**
   * **The alarm this replaced is not adopted, and that is deliberate.** An issue
   * carrying the steward-queue marker reports a condition that no longer exists —
   * `#813` and `#941` between them removed the queue — so rewriting its body with
   * a withdrawal table would leave one issue claiming to be two findings. The old
   * one is closed by hand, once.
   */
  it('leaves the steward-queue alarm it replaced alone', () => {
    const theOldAlarm = anIssue('<!-- watch-finding: steward-drafts-waiting -->')

    expect(openDraftIssue([theOldAlarm])).toBeUndefined()
    expect(decideDrafts(theFourWithdrawals, openDraftIssue([theOldAlarm]))).toEqual({
      kind: 'file',
    })
  })

  /**
   * The rejection case, and it is not hypothetical: `#946` was filed by hand to
   * ask for this watcher's repointing, quoted the marker in a code fence while
   * doing so, and was adopted and overwritten twelve minutes later.
   */
  it('does not adopt an issue that merely quotes its marker', () => {
    const aboutTheWatcher = anIssue(
      [
        'Repoint the withdrawal watcher',
        '',
        '```',
        `DRAFT_MARKER = '${DRAFT_MARKER}'   (:64)`,
        '```',
      ].join('\n'),
    )

    expect(openDraftIssue([aboutTheWatcher])).toBeUndefined()
    expect(decideDrafts(theFourWithdrawals, openDraftIssue([aboutTheWatcher]))).toEqual({
      kind: 'file',
    })
  })

  /** GitHub hands some bodies back with CRLF, and a marker is still a marker. */
  it('finds its own alarm through a carriage return', () => {
    const mine = anIssue(`${DRAFT_MARKER}\r\n<!-- withdrawn: count=4 -->`)

    expect(openDraftIssue([mine])).toBe(mine)
  })
})

describe('what the alarm says', () => {
  it('names every withdrawal, its shelf, when it went and what held it', () => {
    const body = draftIssueBody(theFourWithdrawals)

    expect(body).toContain(DRAFT_MARKER)
    expect(body).toContain('<!-- withdrawn: count=4 -->')
    expect(body).toContain(`last ${DRAFT_WINDOW_DAYS} days`)
    for (const draft of theFourWithdrawals.drafts) expect(body).toContain(draft.provider)
    expect(body).toContain('telephony')
    expect(body).toContain('2026-08-12T07:26:52.000Z')
    expect(body).toContain('Step 3 recorded no instruction.')
  })

  /** A row whose verdict recorded no reason says so rather than showing a gap. */
  it('says plainly where no verdict recorded a reason', () => {
    expect(draftIssueBody(theFourWithdrawals)).toContain('*no verdict recorded a reason*')
  })

  /**
   * **The whole diagnostic value is telling the two causes apart**, so the body
   * has to name both. A run of identical reasons about the Colony's own wording
   * is a rewrite rule refusing usable material; a run about what the walk recorded
   * is the walkers, and the fix for one is no help against the other.
   */
  it('names both readings of a run of identical reasons', () => {
    const body = draftIssueBody(theFourWithdrawals)

    expect(body).toContain('Held on')
    expect(body).toContain('the rewrite rule is too tight')
    expect(body).toContain('the walkers are the place to fix it')
  })

  /**
   * **The queue this used to watch is gone and the body must not imply otherwise.**
   * An alarm that tells a reader to go and read a page nobody is behind on teaches
   * a fix for a condition that has not existed since `#813`.
   */
  it('does not send anybody to a steward queue', () => {
    const body = draftIssueBody(theFourWithdrawals)

    expect(body).toContain('there is no longer one to be behind on')
    expect(body).not.toMatch(/waiting for a steward|\/review/)
  })

  /** Nothing *here* publishes, and the body says who does (`#946`). */
  it('says plainly that this alarm clears nothing and names what does', () => {
    const body = draftIssueBody(theFourWithdrawals)

    expect(body).toContain('apps/moderation-runner')
    expect(body).toContain('`#813`')
    expect(body).toContain('a fresh walk replaces one')
  })

  /**
   * The `#600` question, settled: the rule that a person passes what the Colony
   * says about somebody else's product was superseded, and the body says so
   * rather than leaving a reader to find two live rules that contradict.
   */
  it('says which of the two rules about stewardship is stale', () => {
    const body = draftIssueBody(theFourWithdrawals)

    expect(body).toContain('`#600`')
    expect(body).toContain('superseded by')
    expect(body).toContain('governance/the-atlas.md')
  })

  it('says how many it did not list when the run is longer than the table', () => {
    const long: WithdrawnDraftQueue = { ...theFourWithdrawals, count: 30 }

    expect(draftIssueBody(long)).toContain('and 26 more not listed here')
  })

  it('repeats the numbers in an escalation rather than pointing at the body', () => {
    const comment = draftEscalationComment(aFifthWithdrawal, 4)

    expect(comment).toContain('5 walked recipes have now been withdrawn')
    expect(comment).toContain('up from 4')
    expect(comment).toContain('later.example')
  })

  it('says on the way out that it will come back', () => {
    const closing = draftClosingComment()

    expect(closing).toContain(String(DRAFT_WINDOW_DAYS))
    expect(closing).toContain('stay withdrawn')
  })
})

describe('one pass of the withdrawal watcher', () => {
  it('files the alarm with the labels a watcher’s finding carries', async () => {
    const issues = spyIssues()

    const outcome = await watchDrafts({ issues, measure: async () => theFourWithdrawals })

    expect(outcome).toEqual({ action: 'file', withdrawn: 4 })
    expect(issues.created).toHaveLength(1)
    expect(issues.created[0]?.repository).toBe(DRAFT_REPOSITORY)
    expect(issues.created[0]?.labels).toEqual(['from:watcher', 'area:platform', 'p2'])
  })

  /**
   * **The body is rewritten on a standing pass and no comment is written.** A
   * comment notifies everybody watching; a body edit notifies nobody, so the
   * table stays true for free and the marker the next pass reads stays true too.
   */
  it('keeps the body current without commenting while the run stands', async () => {
    const issues = spyIssues([anIssue(`${DRAFT_MARKER}\n<!-- withdrawn: count=4 -->`)])

    const outcome = await watchDrafts({ issues, measure: async () => theFourWithdrawals })

    expect(outcome.action).toBe('standing')
    expect(issues.commented).toHaveLength(0)
    expect(issues.revised).toHaveLength(1)
  })

  it('comments once and rewrites the body when more are withdrawn', async () => {
    const issues = spyIssues([anIssue(`${DRAFT_MARKER}\n<!-- withdrawn: count=4 -->`)])

    const outcome = await watchDrafts({ issues, measure: async () => aFifthWithdrawal })

    expect(outcome.action).toBe('escalate')
    expect(issues.commented).toHaveLength(1)
    expect(issues.commented[0]?.body).toContain('up from 4')
    expect(issues.revised[0]?.body).toContain('<!-- withdrawn: count=5 -->')
  })

  it('closes the alarm once the week behind it is quiet', async () => {
    const issues = spyIssues([anIssue(DRAFT_MARKER)])

    const outcome = await watchDrafts({ issues, measure: async () => quietWeek })

    expect(outcome.action).toBe('close')
    expect(issues.closed_).toHaveLength(1)
  })

  /**
   * `#868`'s lesson, taken here before it has to be learned again: an empty
   * corpus is indistinguishable from an unreadable one, and filing against that
   * opens a fresh alarm every half hour for a condition that already has an
   * issue. That is exactly how `#867` came to duplicate `#727`.
   */
  it('does nothing when the repository it files into could not be read', async () => {
    const issues = spyIssues([], [DRAFT_REPOSITORY])

    const outcome = await watchDrafts({ issues, measure: async () => theFourWithdrawals })

    expect(outcome).toEqual({ action: 'quiet', withdrawn: 4, skipped: 'unreadable' })
    expect(issues.created).toHaveLength(0)
  })

  it('does nothing when there is no App at all', async () => {
    const outcome = await watchDrafts({ issues: noIssues, measure: async () => theFourWithdrawals })

    expect(outcome).toEqual({ action: 'quiet', withdrawn: 4, skipped: 'no-app' })
  })
})
