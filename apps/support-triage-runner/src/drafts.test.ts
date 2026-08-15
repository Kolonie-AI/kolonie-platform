import { describe, expect, it } from 'vitest'
import type { StewardQueue } from '@kolonie-ai/db'
import { noIssues, type Issues, type KnownIssue } from './github.js'
import {
  DRAFT_MARKER,
  DRAFT_REPOSITORY,
  DRAFT_THRESHOLD_HOURS,
  decideDrafts,
  draftClosingComment,
  draftEscalationComment,
  draftIssueBody,
  openDraftIssue,
  recordedWaiting,
  watchDrafts,
} from './drafts.js'

/**
 * The state measured in production on 2026-08-14, which is what `#917` is about:
 * four completed walks, the oldest from 2026-08-12, and nothing saying so.
 */
const theFourWalks: StewardQueue = {
  count: 4,
  drafts: [
    {
      kind: 'code-hosting',
      provider: 'clawhub.example',
      category: 'code-hosting',
      since: '2026-08-12T07:26:52.000Z',
    },
    {
      kind: 'phone',
      provider: 'agentmessage.example',
      category: 'telephony',
      since: '2026-08-13T01:42:21.000Z',
    },
    {
      kind: 'code-hosting',
      provider: 'flow.example',
      category: 'code-hosting',
      since: '2026-08-13T01:44:38.000Z',
    },
    {
      kind: 'social',
      provider: 'ieji.example',
      category: 'social-publishing',
      since: '2026-08-13T01:44:52.000Z',
    },
  ],
  oldestSince: '2026-08-12T07:26:52.000Z',
}

const emptyQueue: StewardQueue = { count: 0, drafts: [], oldestSince: null }

const aFifthWalk: StewardQueue = {
  ...theFourWalks,
  count: 5,
  drafts: [
    ...theFourWalks.drafts,
    {
      kind: 'mailbox',
      provider: 'later.example',
      category: 'mailbox',
      since: '2026-08-14T09:00:00.000Z',
    },
  ],
}

const anIssue = (body: string): KnownIssue => ({
  repository: DRAFT_REPOSITORY,
  number: 920,
  title: 'Completed walks are waiting for a steward',
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

describe('deciding what to do about walks waiting for a steward', () => {
  it('files when walks are waiting and nothing open says so', () => {
    expect(decideDrafts(theFourWalks, undefined)).toEqual({ kind: 'file' })
  })

  /**
   * One issue for the condition, not one per draft. Four walks produced one
   * finding, and this is what stops the next pass producing a second.
   */
  it('stands rather than filing again while the same issue is open', () => {
    const open = anIssue(`${DRAFT_MARKER}\n<!-- waiting: count=4 -->`)

    expect(decideDrafts(theFourWalks, open)).toEqual({ kind: 'standing', issue: open })
  })

  /**
   * **The queue growing is an event where the queue standing still is a state.**
   * A fifth walk arriving behind four nobody has read means drafts are
   * accumulating faster than they are cleared, which is a different problem.
   */
  it('escalates once when the queue has grown under an open alarm', () => {
    const open = anIssue(`${DRAFT_MARKER}\n<!-- waiting: count=4 -->`)

    expect(decideDrafts(aFifthWalk, open)).toEqual({ kind: 'escalate', issue: open })
  })

  /** The rejection case for the escalation: a queue that shrinks says nothing. */
  it('stays silent when the queue has shrunk', () => {
    const open = anIssue(`${DRAFT_MARKER}\n<!-- waiting: count=5 -->`)

    expect(decideDrafts(theFourWalks, open)).toEqual({ kind: 'standing', issue: open })
  })

  it('closes itself once the queue is clear', () => {
    const open = anIssue(DRAFT_MARKER)

    expect(decideDrafts(emptyQueue, open)).toEqual({ kind: 'close', issue: open })
  })

  it('is quiet when there is nothing waiting and nothing open', () => {
    expect(decideDrafts(emptyQueue, undefined)).toEqual({ kind: 'quiet' })
  })

  /**
   * An issue filed before the marker existed reads as zero, which is the safe
   * direction: the first pass after this ships says it once rather than treating
   * its own deploy as a reason to stay quiet.
   */
  it('reads a body with no marker as an empty queue', () => {
    expect(recordedWaiting('nothing here')).toBe(0)
    expect(recordedWaiting('<!-- waiting: count=7 -->')).toBe(7)
  })

  it('finds its own alarm by marker rather than by title', () => {
    const mine = anIssue(DRAFT_MARKER)
    const somebodyElse = anIssue('<!-- watch-finding: payout-debt-outstanding -->')

    expect(openDraftIssue([somebodyElse, mine])).toBe(mine)
    expect(openDraftIssue([somebodyElse])).toBeUndefined()
  })

  /**
   * The rejection case, and it is not hypothetical: `#946` was filed by hand to
   * ask for this watcher's retirement, quoted `DRAFT_MARKER` in a code fence
   * while doing so, and was adopted and overwritten twelve minutes later.
   */
  it('does not adopt an issue that merely quotes its marker', () => {
    const aboutTheWatcher = anIssue(
      [
        "Retire the 'waiting for a steward' watcher",
        '',
        '```',
        `DRAFT_MARKER = '${DRAFT_MARKER}'   (:64)`,
        '```',
      ].join('\n'),
    )

    expect(openDraftIssue([aboutTheWatcher])).toBeUndefined()
    expect(decideDrafts(theFourWalks, openDraftIssue([aboutTheWatcher]))).toEqual({ kind: 'file' })
  })

  /** GitHub hands some bodies back with CRLF, and a marker is still a marker. */
  it('finds its own alarm through a carriage return', () => {
    const mine = anIssue(`${DRAFT_MARKER}\r\n<!-- waiting: count=4 -->`)

    expect(openDraftIssue([mine])).toBe(mine)
  })
})

describe('what the alarm says', () => {
  it('names every waiting walk, its shelf and how long it has waited', () => {
    const body = draftIssueBody(theFourWalks)

    expect(body).toContain(DRAFT_MARKER)
    expect(body).toContain('<!-- waiting: count=4 -->')
    expect(body).toContain(`more than ${DRAFT_THRESHOLD_HOURS} hours`)
    for (const draft of theFourWalks.drafts) expect(body).toContain(draft.provider)
    expect(body).toContain('telephony')
    expect(body).toContain('2026-08-12T07:26:52.000Z')
  })

  /** The alarm is only worth anything if it says where to act, so it names the page. */
  it('names the page the queue is on', () => {
    expect(draftIssueBody(theFourWalks)).toContain('/review')
    expect(draftIssueBody(theFourWalks)).toContain('/backend')
  })

  /**
   * **The page was never missing and the body must not claim it was.** `#604`
   * built it; what was missing was anything saying it had something on it, and
   * an alarm that misdescribes the defect it reports teaches the wrong fix.
   */
  it('does not claim the queue had no page', () => {
    const body = draftIssueBody(theFourWalks)

    expect(body).toContain('Not a claim that the page was missing')
    expect(body).not.toMatch(/no console|nowhere to (see|read)/i)
  })

  /** Nothing here publishes: what the Colony says about somebody else’s product passes a person. */
  it('says plainly that no machine clears this queue', () => {
    expect(draftIssueBody(theFourWalks)).toContain('Not something a machine may clear')
  })

  it('says how many it did not list when the queue is longer than the table', () => {
    const long: StewardQueue = { ...theFourWalks, count: 30 }

    expect(draftIssueBody(long)).toContain('and 26 more not listed here')
  })

  it('repeats the numbers in an escalation rather than pointing at the body', () => {
    const comment = draftEscalationComment(aFifthWalk, 4)

    expect(comment).toContain('5 completed walks are now waiting')
    expect(comment).toContain('up from 4')
    expect(comment).toContain('later.example')
  })

  it('says on the way out that it will come back', () => {
    expect(draftClosingComment()).toContain(String(DRAFT_THRESHOLD_HOURS))
  })
})

describe('one pass of the draft watcher', () => {
  it('files the alarm with the labels a watcher’s finding carries', async () => {
    const issues = spyIssues()

    const outcome = await watchDrafts({ issues, measure: async () => theFourWalks })

    expect(outcome).toEqual({ action: 'file', waiting: 4 })
    expect(issues.created).toHaveLength(1)
    expect(issues.created[0]?.repository).toBe(DRAFT_REPOSITORY)
    expect(issues.created[0]?.labels).toEqual(['from:watcher', 'area:platform', 'p2'])
  })

  /**
   * **The body is rewritten on a standing pass and no comment is written.** A
   * comment notifies everybody watching; a body edit notifies nobody, so the
   * table stays true for free and the marker the next pass reads stays true too.
   */
  it('keeps the body current without commenting while the queue stands', async () => {
    const issues = spyIssues([anIssue(`${DRAFT_MARKER}\n<!-- waiting: count=4 -->`)])

    const outcome = await watchDrafts({ issues, measure: async () => theFourWalks })

    expect(outcome.action).toBe('standing')
    expect(issues.commented).toHaveLength(0)
    expect(issues.revised).toHaveLength(1)
  })

  it('comments once and rewrites the body when the queue grows', async () => {
    const issues = spyIssues([anIssue(`${DRAFT_MARKER}\n<!-- waiting: count=4 -->`)])

    const outcome = await watchDrafts({ issues, measure: async () => aFifthWalk })

    expect(outcome.action).toBe('escalate')
    expect(issues.commented).toHaveLength(1)
    expect(issues.commented[0]?.body).toContain('up from 4')
    expect(issues.revised[0]?.body).toContain('<!-- waiting: count=5 -->')
  })

  it('closes the alarm when a steward has cleared the queue', async () => {
    const issues = spyIssues([anIssue(DRAFT_MARKER)])

    const outcome = await watchDrafts({ issues, measure: async () => emptyQueue })

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

    const outcome = await watchDrafts({ issues, measure: async () => theFourWalks })

    expect(outcome).toEqual({ action: 'quiet', waiting: 4, skipped: 'unreadable' })
    expect(issues.created).toHaveLength(0)
  })

  it('does nothing when there is no App at all', async () => {
    const outcome = await watchDrafts({ issues: noIssues, measure: async () => theFourWalks })

    expect(outcome).toEqual({ action: 'quiet', waiting: 4, skipped: 'no-app' })
  })
})
