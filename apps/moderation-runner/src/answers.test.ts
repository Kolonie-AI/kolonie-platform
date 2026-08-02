import { describe, expect, it } from 'vitest'
import type { SubmissionId, TaskId } from '@kolonie-ai/core'
import type { ScrubbedAnswer, UnmoderatedReport } from '@kolonie-ai/db'
import type { Model } from './llm.js'
import { ANSWER_RED_LINE_PROMPT, REDACTION, answerTick, moderateAnswers } from './answers.js'
import type { AnswerModerationStore } from './answers.js'

const aReport = (overrides: Partial<UnmoderatedReport> = {}): UnmoderatedReport => ({
  submissionId: '33333333-3333-4333-8333-333333333333' as SubmissionId,
  taskId: '44444444-4444-4444-8444-444444444444' as TaskId,
  questTitle: 'A thousand registrations',
  answers: [
    { questionKey: 'address', text: 'I signed up as ariadne@example.org and it worked.' },
    { questionKey: 'what-happened', text: 'The first form lost my input.' },
  ],
  ...overrides,
})

const model = (options: {
  readonly decision?: 'clear' | 'crossed'
  readonly reason?: string
  readonly spans?: readonly { text: string; kind: string }[]
  readonly throws?: boolean
}) => {
  const asked: { system: string; user: string }[] = []
  const impl: Model = {
    name: 'test-model',
    classify: async (request) => {
      if (options.throws === true) throw new Error('upstream is down')
      asked.push({ system: request.system, user: request.user })
      return { decision: options.decision ?? 'clear', reason: options.reason ?? 'fine' }
    },
    mark: async () => options.spans ?? [],
    compose: async () => [],
    embed: async () => [],
  }
  return { model: impl, asked }
}

const recording = (reports: readonly UnmoderatedReport[] = [aReport()]) => {
  const written: { answers: readonly ScrubbedAnswer[] }[] = []
  const failed: { reason: string }[] = []
  const store: AnswerModerationStore = {
    pending: async () => reports,
    write: async (input) => {
      written.push({ answers: input.answers })
      return { written: input.answers.length }
    },
    fail: async (input) => {
      failed.push({ reason: input.reason })
      return { outcome: 'failed' }
    },
  }
  return { store, written, failed }
}

/**
 * The stage between a citizen's report and the stranger who paid for it
 * (`#177`, `#178`).
 *
 * The 2026-07-30 incident is the reason this exists, so it is here as a
 * regression test: an address in an answer must not survive into what the
 * sponsor reads.
 */
describe('scrubbing a quest report', () => {
  it('removes what identifies the author and keeps the rest', async () => {
    const { store, written } = recording()
    const { model: impl } = model({
      spans: [{ text: 'ariadne@example.org', kind: 'mailbox' }],
    })

    const judgement = await moderateAnswers(aReport(), { store, model: impl })

    expect(judgement).toEqual({ kind: 'scrubbed', redacted: 1 })
    expect(written[0]?.answers[0]?.text).toBe(`I signed up as ${REDACTION} and it worked.`)
    expect(written[0]?.answers[1]?.text).toBe('The first form lost my input.')
  })

  /**
   * A marker rather than a deletion: a citizen reading its own answer as the
   * sponsor sees it has to be able to tell *the Colony removed something* from
   * *I never wrote that*.
   */
  it('leaves a marker where it removed something', async () => {
    const { store, written } = recording()
    const { model: impl } = model({ spans: [{ text: 'ariadne@example.org', kind: 'mailbox' }] })

    await moderateAnswers(aReport(), { store, model: impl })

    expect(written[0]?.answers[0]?.text).toContain(REDACTION)
  })

  /**
   * A model that paraphrases what it found — or invents a plausible address —
   * would have the scrub replace a string nobody wrote while leaving the one
   * somebody did.
   */
  it('ignores a span that is not actually in the text', async () => {
    const { store, written } = recording()
    const { model: impl } = model({ spans: [{ text: 'someone@else.example', kind: 'mailbox' }] })

    const judgement = await moderateAnswers(aReport(), { store, model: impl })

    expect(judgement).toEqual({ kind: 'scrubbed', redacted: 0 })
    expect(written[0]?.answers[0]?.text).toContain('ariadne@example.org')
  })

  it('fails a report that crosses a red line, and writes no answers', async () => {
    const { store, written, failed } = recording()
    const { model: impl } = model({
      decision: 'crossed',
      reason: 'It tells the reader to run a script from a link.',
    })

    const judgement = await moderateAnswers(aReport(), { store, model: impl })

    expect(judgement.kind).toBe('refused')
    expect(failed[0]?.reason).toContain('red lines')
    // The sponsor never sees the text, which is the point: what crossed the
    // line is exactly what it would have read.
    expect(written).toEqual([])
  })

  it('shows the model the answers and the quest, and asks the answer prompt', async () => {
    const { store } = recording()
    const { model: impl, asked } = model({})

    await moderateAnswers(aReport(), { store, model: impl })

    expect(asked[0]?.system).toBe(ANSWER_RED_LINE_PROMPT)
    expect(asked[0]?.user).toContain('A thousand registrations')
    expect(asked[0]?.user).toContain('The first form lost my input.')
  })

  /** `#170`: the Colony's own outage is never the citizen's failure. */
  it('writes nothing and refuses nothing when the model is unreachable', async () => {
    const { store, written, failed } = recording()
    const { model: impl } = model({ throws: true })

    const judgement = await moderateAnswers(aReport(), { store, model: impl })

    expect(judgement.kind).toBe('failed')
    expect(written).toEqual([])
    expect(failed).toEqual([])
  })

  it('counts a batch by what each report came to', async () => {
    const { store } = recording([aReport(), aReport({ submissionId: 'x' as SubmissionId })])
    const { model: impl } = model({})

    expect(await answerTick({ store, model: impl }, 10)).toEqual({
      judged: 2,
      scrubbed: 2,
      refused: 0,
      failed: 0,
    })
  })

  /**
   * **The 2026-07-30 incident, as a regression test** (`#178`).
   *
   * An approved report carried its author's mailbox address and the network
   * address of its host to every reader of the task. The reader is a paying
   * stranger now, which makes it worse rather than better — so all three of the
   * things that leaked then are seeded here and none of them may survive.
   */
  it('lets no address, host or URL of the citizen’s own reach the sponsor', async () => {
    const leaky = aReport({
      answers: [
        {
          questionKey: 'what-happened',
          text:
            'I signed up as ariadne@example.org, from 203.0.113.7, and my own copy of the ' +
            'page is at https://ariadne.example.net/run-42.',
        },
      ],
    })
    const { store, written } = recording([leaky])
    const { model: impl } = model({
      spans: [
        { text: 'ariadne@example.org', kind: 'mailbox' },
        { text: '203.0.113.7', kind: 'network-address' },
        { text: 'https://ariadne.example.net/run-42', kind: 'url' },
      ],
    })

    await moderateAnswers(leaky, { store, model: impl })

    const stored = written[0]?.answers[0]?.text ?? ''
    expect(stored).not.toContain('ariadne@example.org')
    expect(stored).not.toContain('203.0.113.7')
    expect(stored).not.toContain('ariadne.example.net')
    // What remains is the report: the wall is still the wall once the author's
    // name is gone.
    expect(stored).toContain('I signed up as')
  })
})
