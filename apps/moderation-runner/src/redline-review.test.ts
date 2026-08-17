import { describe, expect, it } from 'vitest'
import type { SubmissionId, TaskId, Timestamp } from '@kolonie-ai/core'
import type { HeldReport } from '@kolonie-ai/db'
import type { Model } from './llm.js'
import { fakeIssues } from './__fixtures__/issues.js'
import {
  RED_LINE_DEFENCE_PROMPT,
  REVIEW_CHOICES,
  redLineReviewTick,
  reviewHeldReport,
  upheldIssueBody,
  upheldMarker,
  type RedLineReviewStore,
} from './redline-review.js'

const aHeldReport = (overrides: Partial<HeldReport> = {}): HeldReport => ({
  submissionId: '55555555-5555-4555-8555-555555555555' as SubmissionId,
  taskId: '66666666-6666-4666-8666-666666666666' as TaskId,
  questTitle: 'Describe a task another agent could take',
  questInstructions: 'Write the task description you would hand to a citizen taking this on.',
  flaggedFor: 'It instructs the reader to install a package.',
  model: 'first-pass-model',
  heldAt: '2026-08-15T09:00:00.000Z' as Timestamp,
  answers: [{ questionKey: 'task', text: 'Step one: run npm install and then open the console.' }],
  ...overrides,
})

const model = (options: {
  readonly decision?: (typeof REVIEW_CHOICES)[number] | string
  readonly reason?: string
  readonly throws?: boolean
}) => {
  const asked: { system: string; user: string; choices: readonly string[] }[] = []
  const impl: Model = {
    name: 'second-pass-model',
    classify: async (request) => {
      asked.push({ system: request.system, user: request.user, choices: request.choices })
      if (options.throws === true) throw new Error('the gateway did not answer')
      return { decision: options.decision ?? 'does-not-cross', reason: options.reason ?? 'fine' }
    },
    mark: async () => [],
    compose: async () => [],
    embed: async () => [],
  }
  return { model: impl, asked }
}

const recording = (
  reports: readonly HeldReport[] = [aHeldReport()],
  outcome: 'upheld' | 'released' | 'not-held' | 'follow' = 'follow',
) => {
  const resolved: {
    crossed: boolean
    flaggedFor: string
    ruling: string
    releasedBecause?: string
  }[] = []

  const store: RedLineReviewStore = {
    held: async () => reports,
    resolve: async (input) => {
      resolved.push({
        crossed: input.crossed,
        flaggedFor: input.flaggedFor,
        ruling: input.ruling,
        ...(input.releasedBecause === undefined ? {} : { releasedBecause: input.releasedBecause }),
      })

      if (outcome !== 'follow') return { outcome }
      return { outcome: input.crossed ? 'upheld' : 'released' }
    },
  }

  return { store, resolved }
}

const filing = () => {
  const issues = fakeIssues()
  return { issues, filed: issues.opened }
}

/**
 * The second reading that lifts a red-line hold (`#942`).
 *
 * What is being tested is one property in four shapes: **there is no route out
 * of `held` other than a verdict**, and every route that is not an independent
 * agreement is a release.
 */
describe('reading a held report a second time', () => {
  it('releases when the second pass argues the report does not cross', async () => {
    const { store, resolved } = recording()
    const { model: impl } = model({
      decision: 'does-not-cross',
      reason: 'The quest asked for a task description, so the imperatives address its taker.',
    })

    const judgement = await reviewHeldReport(aHeldReport(), { store, model: impl })

    expect(judgement).toMatchObject({ kind: 'released', cause: 'defended' })
    expect(resolved).toHaveLength(1)
    expect(resolved[0]?.crossed).toBe(false)
    expect(resolved[0]?.releasedBecause).toBe('defended')
  })

  it('upholds only when the second pass reaches the same line', async () => {
    const { store, resolved } = recording()
    const { issues, filed } = filing()
    const { model: impl } = model({
      decision: 'crosses-as-flagged',
      reason: 'The instruction is addressed to the sponsor reading the report.',
    })

    const judgement = await reviewHeldReport(aHeldReport(), { store, model: impl, issues })

    expect(judgement.kind).toBe('upheld')
    expect(resolved[0]?.crossed).toBe(true)
    expect(filed()).toHaveLength(1)
    // `#1161`: the marker is the first line, so a second pass over the same
    // submission finds this issue instead of filing beside it.
    expect(filed()[0]?.body.split('\n')[0]).toBe(upheldMarker(aHeldReport().submissionId))
  })

  /**
   * **An upheld ruling is an event, not a condition** (`#1161`). Two agreeing
   * readings happened once, on a date. A maintainer who closed the issue has
   * read it, and there is nothing left that could stop holding — so a later pass
   * over the same submission stays quiet rather than reopening the argument.
   */
  it('neither refiles nor reopens once the ruling has an issue', async () => {
    const { store } = recording()
    const { issues, filed } = filing()
    issues.existing({
      body: `${upheldMarker(aHeldReport().submissionId)}\nRead and closed by a maintainer.`,
      state: 'closed',
    })
    const { model: impl } = model({ decision: 'crosses-as-flagged', reason: 'It still crosses.' })

    await reviewHeldReport(aHeldReport(), { store, model: impl, issues })

    expect(filed()).toEqual([])
    expect(issues.reopened()).toEqual([])
    expect(issues.comments()).toEqual([])
  })

  /**
   * The distinction `#942` turns on. A second pass that finds *some* fault has
   * not confirmed the charge that was brought — it has brought a new one that no
   * reading has argued against — and refusing on it would be refusing on an
   * untested accusation.
   */
  it('releases when the second pass crosses a different line from the one flagged', async () => {
    const { store, resolved } = recording()
    const { issues, filed } = filing()
    const { model: impl } = model({
      decision: 'crosses-a-different-line',
      reason: 'It names a third party by their full name.',
    })

    const judgement = await reviewHeldReport(aHeldReport(), { store, model: impl, issues })

    expect(judgement).toMatchObject({ kind: 'released', cause: 'different-line' })
    expect(resolved[0]?.crossed).toBe(false)
    expect(filed()).toHaveLength(0)
  })

  /**
   * Required by the issue, and the case that decides whether the hold is really
   * self-clearing: a gateway that is down must not leave a citizen's attempt
   * open forever, and must not refuse it either.
   */
  it('releases when the model cannot be reached at all', async () => {
    const { store, resolved } = recording()
    const { model: impl } = model({ throws: true })

    const judgement = await reviewHeldReport(aHeldReport(), { store, model: impl })

    expect(judgement).toMatchObject({ kind: 'released', cause: 'unreachable' })
    expect(resolved).toHaveLength(1)
    expect(resolved[0]?.crossed).toBe(false)
    expect(resolved[0]?.releasedBecause).toBe('unreachable')
  })

  it('releases when the answer is not one of the three verdicts', async () => {
    const { store, resolved } = recording()
    const { model: impl } = model({ decision: 'maybe' })

    const judgement = await reviewHeldReport(aHeldReport(), { store, model: impl })

    expect(judgement).toMatchObject({ kind: 'released', cause: 'unreadable' })
    expect(resolved[0]?.crossed).toBe(false)
  })

  /**
   * The charge the citizen is answering has to be the one the first pass
   * brought, or the defence is arguing against something nobody said.
   */
  it('hands the second pass the first pass’s reason and its own brief', async () => {
    const { store } = recording()
    const { model: impl, asked } = model({})

    await reviewHeldReport(aHeldReport(), { store, model: impl })

    expect(asked).toHaveLength(1)
    expect(asked[0]?.system).toBe(RED_LINE_DEFENCE_PROMPT)
    expect(asked[0]?.system).not.toBe('')
    expect(asked[0]?.user).toContain('It instructs the reader to install a package.')
    expect(asked[0]?.user).toContain('Step one: run npm install')
    expect(asked[0]?.choices).toEqual([...REVIEW_CHOICES])
  })

  it('files nothing and still resolves when no issue opener is wired', async () => {
    const { store, resolved } = recording()
    const { model: impl } = model({ decision: 'crosses-as-flagged' })

    const judgement = await reviewHeldReport(aHeldReport(), { store, model: impl })

    expect(judgement.kind).toBe('upheld')
    expect(resolved[0]?.crossed).toBe(true)
  })

  /** Ruled on between the read and the write. Nothing is filed about a verdict that did not land. */
  it('reports a stale hold and files nothing', async () => {
    const { store } = recording([aHeldReport()], 'not-held')
    const { issues, filed } = filing()
    const { model: impl } = model({ decision: 'crosses-as-flagged' })

    const judgement = await reviewHeldReport(aHeldReport(), { store, model: impl, issues })

    expect(judgement.kind).toBe('stale')
    expect(filed()).toHaveLength(0)
  })
})

describe('the issue an upheld refusal files', () => {
  /**
   * `tripwire.ts`'s rule, and this writer is the one most tempted to break it:
   * the whole point of the hold was that the text is not served anywhere.
   */
  it('carries the ids and both reasons and never the report', () => {
    const body = upheldIssueBody(aHeldReport(), 'The defence failed.', 'second-pass-model')

    expect(body).toContain('55555555-5555-4555-8555-555555555555')
    expect(body).toContain('It instructs the reader to install a package.')
    expect(body).toContain('The defence failed.')
    expect(body).not.toContain('Step one: run npm install')
  })

  it('bounds a reason long enough to be a quotation', () => {
    const body = upheldIssueBody(
      aHeldReport({ flaggedFor: 'x'.repeat(2000) }),
      'fine',
      'second-pass-model',
    )

    expect(body).toContain('…')
    expect(body).not.toContain('x'.repeat(600))
  })
})

describe('one pass over the held queue', () => {
  it('counts what it ruled and leaves nothing held', async () => {
    const reports = [
      aHeldReport(),
      aHeldReport({ submissionId: '77777777-7777-4777-8777-777777777777' as SubmissionId }),
    ]
    const { store, resolved } = recording(reports)
    const { model: impl } = model({ decision: 'does-not-cross' })

    const outcome = await redLineReviewTick({ store, model: impl }, 10)

    expect(outcome).toEqual({ read: 2, released: 2, upheld: 0, stale: 0 })
    expect(resolved).toHaveLength(2)
  })

  it('is a no-op on an empty queue', async () => {
    const { store } = recording([])
    const { model: impl, asked } = model({})

    const outcome = await redLineReviewTick({ store, model: impl }, 10)

    expect(outcome).toEqual({ read: 0, released: 0, upheld: 0, stale: 0 })
    expect(asked).toHaveLength(0)
  })
})
