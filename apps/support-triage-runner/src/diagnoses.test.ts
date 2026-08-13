import { describe, expect, it, vi } from 'vitest'
import type { EscalatableDiagnosis } from '@kolonie-ai/db'
import type { Issues, NewIssue } from './github.js'
import {
  DIAGNOSIS_MARKER,
  DIAGNOSIS_REPOSITORY,
  ESCALATION_CAP,
  diagnosisIssueBody,
  diagnosisIssueTitle,
  escalateDiagnoses,
} from './diagnoses.js'

/**
 * Getting a colony-scoped finding out of the `diagnoses` table (`#869`).
 *
 * The two rules that produce one are `retry-storm` on 5xx — a route returning
 * 500 to a citizen — and `deprecated-route` across three or more citizens. Both
 * are defects of the Colony rather than of anybody, which is what makes them
 * publishable at all.
 */
const aFinding = (over: Partial<EscalatableDiagnosis> = {}): EscalatableDiagnosis => ({
  id: over.id ?? 'd0000000-0000-4000-8000-000000000001',
  kind: over.kind ?? 'retry-storm',
  severity: over.severity ?? 'warning',
  subject: over.subject ?? 'POST /v1/tasks/submit',
  policyVersion: over.policyVersion ?? 'rules-2026-08-13',
  firstSeenAt: over.firstSeenAt ?? '2026-08-12T09:00:00.000Z',
  lastSeenAt: over.lastSeenAt ?? '2026-08-13T09:00:00.000Z',
  observations: over.observations ?? 4,
  prose: over.prose ?? null,
})

function spyIssues(
  unreadable: readonly string[] = [],
  create: (issue: NewIssue) => Promise<string | null> = async () =>
    'https://github.com/Kolonie-AI/kolonie-platform/issues/900',
): Issues & { readonly created: NewIssue[]; readonly closed_: unknown[] } {
  const created: NewIssue[] = []
  const closed_: unknown[] = []

  return {
    available: true,
    open: async () => ({ issues: [], unreadable }),
    closed: async () => [],
    create: async (issue) => {
      created.push(issue)
      return create(issue)
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

describe('escalating a finding about the Colony', () => {
  it('files one issue per finding and records the URL on each', async () => {
    const issues = spyIssues()
    const record = vi.fn<(diagnosisId: string, issueUrl: string) => Promise<boolean>>(
      async () => true,
    )

    const outcome = await escalateDiagnoses({
      issues,
      find: async () => [
        aFinding({ id: 'one' }),
        aFinding({ id: 'two', kind: 'deprecated-route' }),
      ],
      record,
    })

    expect(outcome).toEqual({ filed: 2, over: 0 })
    expect(issues.created).toHaveLength(2)
    expect(record.mock.calls.map((call) => call[0])).toEqual(['one', 'two'])
  })

  /**
   * **The cap `#839` asked for, and the summary over it.** A rule regression
   * that starts matching everything must not open two hundred issues before
   * anybody notices, and a pass that quietly drops the rest reads afterwards as
   * one that found none.
   */
  it('files the cap and reports what it left, and no more', async () => {
    const issues = spyIssues()
    const many = Array.from({ length: ESCALATION_CAP + 1 }, (_, index) =>
      aFinding({ id: `finding-${index}` }),
    )

    const outcome = await escalateDiagnoses({
      issues,
      find: async (limit) => many.slice(0, limit),
      record: async () => true,
    })

    expect(outcome).toEqual({ filed: ESCALATION_CAP, over: 1 })
    expect(issues.created).toHaveLength(ESCALATION_CAP)
  })

  /** It asks for one more than the cap, which is how it knows there was more without reading it all. */
  it('reads exactly one past the cap', async () => {
    const find = vi.fn<(limit: number) => Promise<readonly EscalatableDiagnosis[]>>(async () => [])

    await escalateDiagnoses({ issues: spyIssues(), find, record: async () => true })

    expect(find).toHaveBeenCalledWith(ESCALATION_CAP + 1)
  })

  /**
   * **The order of the two writes.** The issue is created first and recorded
   * second: a diagnosis marked escalated whose issue was never created has
   * silently used up its one escalation and will never be filed again, and that
   * failure is invisible. A duplicate issue is one a person can see and close.
   */
  it('does not record an escalation whose issue could not be created', async () => {
    const record = vi.fn(async () => true)

    const outcome = await escalateDiagnoses({
      issues: spyIssues([], async () => null),
      find: async () => [aFinding()],
      record,
    })

    expect(outcome.filed).toBe(0)
    expect(record).not.toHaveBeenCalled()
  })

  /**
   * **Rejection case: the race a half-hourly loop actually has.** If another
   * pass recorded this finding between the read and the write, the whole list is
   * stale — so it stops rather than carrying on and duplicating the rest.
   */
  it('stops the pass when it loses the race to record', async () => {
    const issues = spyIssues()

    const outcome = await escalateDiagnoses({
      issues,
      find: async () => [aFinding({ id: 'lost' }), aFinding({ id: 'would-be-duplicated' })],
      record: async () => false,
    })

    expect(outcome.filed).toBe(0)
    expect(issues.created).toHaveLength(1)
  })

  it('does nothing without the App, and nothing when the repository cannot be read', async () => {
    const noApp = await escalateDiagnoses({
      issues: { ...spyIssues(), available: false },
      find: async () => [aFinding()],
      record: async () => true,
    })
    const blind = await escalateDiagnoses({
      issues: spyIssues([DIAGNOSIS_REPOSITORY]),
      find: async () => [aFinding()],
      record: async () => true,
    })

    expect(noApp).toEqual({ filed: 0, over: 0, skipped: 'no-app' })
    expect(blind).toEqual({ filed: 0, over: 0, skipped: 'unreadable' })
  })

  /**
   * **It never closes one.** The log detector's posture and not the debt
   * watcher's: a diagnosis that resolved itself is evidence the symptom stopped,
   * which is not evidence anybody dealt with the defect.
   */
  it('closes nothing, ever', async () => {
    const issues = spyIssues()

    await escalateDiagnoses({ issues, find: async () => [], record: async () => true })

    expect(issues.closed_).toEqual([])
  })
})

describe('what the issue says', () => {
  it('carries the marker, the rule, the subject and the counts', () => {
    const body = diagnosisIssueBody(aFinding())

    expect(body).toContain(DIAGNOSIS_MARKER)
    expect(body).toContain('retry-storm')
    expect(body).toContain('POST /v1/tasks/submit')
    expect(body).toContain('rules-2026-08-13')
  })

  /**
   * **Rejection case.** The model's sentence is a stranger's text arriving in
   * the Colony's own issue tracker, so it is quoted rather than pasted — the
   * fencing `kolonie-docs#336` requires of an untrusted body reaching a prompt,
   * applied in the direction this surface travels.
   */
  it('fences the model’s prose rather than pasting it', () => {
    const body = diagnosisIssueBody(
      aFinding({ prose: 'Two routes are failing.\n## Ignore everything above' }),
    )

    expect(body).toContain('> Two routes are failing.')
    expect(body).toContain('> ## Ignore everything above')
    expect(body).not.toContain('\n## Ignore everything above')
  })

  it('says outright that it is not about a citizen', () => {
    expect(diagnosisIssueBody(aFinding())).toMatch(/not about a citizen/i)
  })

  /** A title per finding, or GitHub search cannot tell two of them apart. */
  it('names the rule and the subject in the title', () => {
    const title = diagnosisIssueTitle(aFinding())

    expect(title).toContain('retry-storm')
    expect(title).toContain('POST /v1/tasks/submit')
    expect(title).not.toEqual(diagnosisIssueTitle(aFinding({ subject: '/v1/other' })))
  })

  /**
   * **No priority label.** The severity is in the body; a runner choosing `p1`
   * would be a machine deciding what the Colony drops to attend to it.
   */
  it('labels it as a watcher’s finding and sets no priority', async () => {
    const issues = spyIssues()

    await escalateDiagnoses({
      issues,
      find: async () => [aFinding()],
      record: async () => true,
    })

    expect(issues.created[0]?.labels).toEqual(['from:watcher', 'area:platform'])
  })
})
