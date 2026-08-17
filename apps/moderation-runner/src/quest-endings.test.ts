import { describe, expect, it } from 'vitest'
import type { TaskId, Timestamp } from '@kolonie-ai/core'
import type { EndedByLever } from '@kolonie-ai/db'
import { fakeIssues } from './__fixtures__/issues.js'
import {
  ENDING_WINDOW_DAYS,
  endingIssueBody,
  endingMarker,
  questEndingsTick,
  type QuestEndingsStore,
} from './quest-endings.js'

const anEnding = (overrides: Partial<EndedByLever> = {}): EndedByLever => ({
  taskId: '22222222-2222-4222-8222-222222222222' as TaskId,
  title: 'Name a provider that refused an agent signup',
  reason: 'The sponsor’s escrow was draining on answers that all named the same provider.',
  endedAt: '2026-08-15T09:00:00.000Z' as Timestamp,
  ...overrides,
})

const reading = (endings: readonly EndedByLever[] = [anEnding()]) => {
  const asked: { withinDays: number; limit: number }[] = []
  const store: QuestEndingsStore = {
    endedByLever: async (withinDays, limit) => {
      asked.push({ withinDays, limit })
      return endings
    },
  }
  return { store, asked }
}

const filing = (
  options: {
    readonly already?: 'open' | 'closed'
    readonly refuses?: boolean
  } = {},
) => {
  const issues = fakeIssues()

  if (options.already !== undefined) {
    issues.existing({
      body: `${endingMarker(anEnding().taskId)}\nSomebody already filed this one.`,
      state: options.already,
    })
  }

  if (options.refuses === true) issues.refusesToOpen()

  return { issues, filed: issues.opened }
}

/**
 * The trace behind the one lever the steward tier kept (`#944`).
 *
 * `kolonie.quests.end` is the only privileged thing one citizen may do to
 * another's row, and it survived the tier's removal because stopping a runaway
 * quest has to be immediate. **What the issue asked for in exchange is that
 * every use of it lands in front of a person**, which is the property under test
 * here: one ending, one issue, and nothing about the stop waiting on it.
 */
describe('filing what the lever stopped', () => {
  it('opens one issue per ending, naming the quest and the reason given', async () => {
    const { store } = reading()
    const { issues, filed } = filing()

    const outcome = await questEndingsTick({ store, issues }, 10)

    expect(outcome).toEqual({ read: 1, filed: 1, skipped: 0 })
    expect(filed()).toHaveLength(1)
    expect(filed()[0]?.title).toBe(
      'Quest stopped by the steward lever: Name a provider that refused an agent signup',
    )
    expect(filed()[0]?.body).toContain('22222222-2222-4222-8222-222222222222')
    expect(filed()[0]?.body).toContain('2026-08-15T09:00:00.000Z')
    expect(filed()[0]?.body).toContain('all named the same provider')
  })

  /**
   * **The marker is the first line, and nothing else is** (`#1161`). A finding
   * whose marker is buried where GitHub's search can still see it is a finding
   * the next pass cannot recognise — and, read the other way round, an issue
   * somebody wrote *about* this watcher is not one the watcher may adopt. That
   * is `#946`, which is why the rule is positional rather than a substring.
   */
  it('puts the marker on the first line of what it files', async () => {
    const { store } = reading()
    const { issues, filed } = filing()

    await questEndingsTick({ store, issues }, 10)

    expect(filed()[0]?.body.split('\n')[0]).toBe(endingMarker(anEnding().taskId))
  })

  /**
   * The dedup is the marker rather than a column, and {@link ENDING_WINDOW_DAYS}
   * is now only about what the read costs: one bounded query per pass rather
   * than one that grows with the ledger.
   */
  it('reads only inside the window', async () => {
    const { store, asked } = reading()
    const { issues } = filing()

    await questEndingsTick({ store, issues }, 25)

    expect(asked).toEqual([{ withinDays: ENDING_WINDOW_DAYS, limit: 25 }])
  })

  it('files nothing while an issue about the quest is still open', async () => {
    const { store } = reading()
    const { issues, filed } = filing({ already: 'open' })

    const outcome = await questEndingsTick({ store, issues }, 10)

    expect(outcome).toEqual({ read: 1, filed: 0, skipped: 1 })
    expect(filed()).toHaveLength(0)
  })

  /**
   * **An ending is an event, so a closed issue ends the matter** (`#1161`). The
   * marker finds the closed issue — that is the whole change — but a steward
   * pulled a lever on a date, and that is not a condition that could stop
   * holding. A maintainer who closed this has read it, and reopening it nightly
   * would be the pass arguing about a fact neither of them disputes.
   */
  it('leaves a closed issue closed rather than reopening it', async () => {
    const { store } = reading()
    const { issues, filed } = filing({ already: 'closed' })

    const outcome = await questEndingsTick({ store, issues }, 10)

    expect(outcome).toEqual({ read: 1, filed: 0, skipped: 1 })
    expect(filed()).toHaveLength(0)
    expect(issues.reopened()).toHaveLength(0)
    expect(issues.comments()).toHaveLength(0)
  })

  /**
   * A lookup that failed answers *nothing matched*, and the pass files. That is
   * the direction the real opener chose deliberately: a duplicate a maintainer
   * closes costs a minute, and a silent miss costs the trace `#944` asked for.
   */
  it('files rather than staying quiet when the lookup itself broke', async () => {
    const { store } = reading()
    const { issues, filed } = filing({ already: 'open' })
    issues.breaksLookup()

    const outcome = await questEndingsTick({ store, issues }, 10)

    expect(outcome).toEqual({ read: 1, filed: 1, skipped: 0 })
    expect(filed()).toHaveLength(1)
  })

  /** A refused write loses the issue, never the stop: the quest is already retired. */
  it('counts an opener that answered nothing as skipped rather than filed', async () => {
    const { store } = reading()
    const { issues } = filing({ refuses: true })

    const outcome = await questEndingsTick({ store, issues }, 10)

    expect(outcome).toEqual({ read: 1, filed: 0, skipped: 1 })
  })

  it('is a no-op when the lever was not pulled', async () => {
    const { store } = reading([])
    const { issues, filed } = filing()

    const outcome = await questEndingsTick({ store, issues }, 10)

    expect(outcome).toEqual({ read: 0, filed: 0, skipped: 0 })
    expect(filed()).toHaveLength(0)
  })

  /**
   * Wired without an opener the pass still reads and still counts. The runner
   * runs in deployments with no GitHub token, and a trace that cannot be filed
   * must not stop the poll it shares with three other passes.
   */
  it('runs with no issue opener at all', async () => {
    const { store } = reading()

    const outcome = await questEndingsTick({ store }, 10)

    expect(outcome).toEqual({ read: 1, filed: 0, skipped: 1 })
  })
})

describe('what a maintainer reads', () => {
  it('bounds a reason too long to belong in an issue', () => {
    const body = endingIssueBody(anEnding({ reason: 'x'.repeat(2000) }))
    const quoted = body.split('- Reason given: ')[1]?.split('\n')[0] ?? ''

    expect(quoted).toHaveLength(500)
    expect(quoted.endsWith('…')).toBe(true)
  })

  it('says so when no reason was recorded', () => {
    expect(endingIssueBody(anEnding({ reason: '   ' }))).toContain(
      '- Reason given: (no reason recorded)',
    )
  })

  /**
   * **What is here is a privileged act and its reason, and nothing else.** The
   * shape the pass is handed carries no sponsor, no citizen and no answers, and
   * the guard is that the body is assembled from that shape alone — a later
   * field added to make the issue *more useful* is how a maintainer's issue
   * turns into a place quest answers get republished.
   */
  it('says what happened and what to do about it, from the ending alone', () => {
    const ending = anEnding()
    const body = endingIssueBody(ending)

    expect(body).toContain('`kolonie.quests.end`')
    expect(body).toContain('`#944`')
    expect(body).toContain('If it does hold, close this.')

    const carried = [ending.taskId as string, ending.endedAt as string, ending.reason]
    for (const line of body.split('\n').filter((line) => line.startsWith('- '))) {
      expect(carried.some((value) => line.includes(value))).toBe(true)
    }
  })
})
