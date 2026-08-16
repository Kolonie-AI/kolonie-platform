import { describe, expect, it } from 'vitest'
import { WALK_PROSE_QUESTIONS, type WalkProse } from '@kolonie-ai/core'
import type { ApprovedWalkProseWithoutScrub, UnmoderatedWalkProse } from '@kolonie-ai/db'
import type { Model } from './llm.js'
import { ANSWER_RED_LINE_PROMPT, REDACTION } from './answers.js'
import { CONFIDENTIALITY_PROMPT } from './confidentiality.js'
import { moderateWalkProse, walkProseTick, type WalkProseModerationStore } from './walk-prose.js'

const aWalk = (prose: WalkProse = {}): UnmoderatedWalkProse => ({
  walkId: '11111111-1111-4111-8111-111111111111',
  kind: 'mailbox',
  provider: 'clawmail.com',
  prose: {
    did: 'I opened the signup page and filled the form in myself.',
    broke: 'It asked for a phone number at the last step.',
    ...prose,
  },
})

/**
 * A model answering each question in that question's own vocabulary.
 *
 * Keyed on the prompt rather than on call order, for the reason the recipe
 * pass's fake gives: the order is part of what is under test.
 */
const answering = (
  over: {
    readonly redLine?: 'clear' | 'crossed'
    readonly spans?: readonly string[]
  } = {},
) => {
  const asked: { system: string; user: string }[] = []
  const model: Model = {
    name: 'test-model',
    classify: async (request) => {
      asked.push({ system: request.system, user: request.user })
      return { decision: over.redLine ?? 'clear', reason: 'It names a person.' }
    },
    mark: async (request) => {
      asked.push({ system: request.system, user: request.user })
      return (over.spans ?? []).map((text) => ({ kind: 'contact' as const, text }))
    },
    compose: async () => [],
    embed: async () => [],
  }

  return { model, asked }
}

/** A store that records what it was told to do rather than doing it. */
const recording = (
  pending: readonly UnmoderatedWalkProse[] = [aWalk()],
  approvedWithoutScrub: readonly ApprovedWalkProseWithoutScrub[] = [],
) => {
  const written: { walkId: string; scrubbed: WalkProse }[] = []
  const refused: string[] = []
  const rescrubbed: {
    walkId: string
    decision: 'approved' | 'rejected'
    scrubbed?: WalkProse
  }[] = []
  const stale: { kind: string; provider: string }[] = []
  const limits = { pending: [] as number[], approvedWithoutScrub: [] as number[] }
  const store: WalkProseModerationStore = {
    pending: async (limit) => {
      limits.pending.push(limit)
      return pending.slice(0, limit)
    },
    approvedWithoutScrub: async (limit) => {
      limits.approvedWithoutScrub.push(limit)
      return approvedWithoutScrub.slice(0, limit)
    },
    write: async ({ walk, scrubbed }) => {
      written.push({ walkId: walk.walkId, scrubbed })
    },
    refuse: async ({ walk }) => {
      refused.push(walk.walkId)
    },
    rescrub: async ({ walk, ...decision }) => {
      rescrubbed.push({ walkId: walk.walkId, ...decision })
    },
    markProviderStale: async (where) => {
      stale.push(where)
    },
  }

  return { store, written, refused, rescrubbed, stale, limits }
}

describe('the Colony scrubbing what a walker wrote', () => {
  it('asks both questions about the whole page, with each answer under its question', async () => {
    const { model, asked } = answering()
    const { store, written } = recording()

    const judgement = await moderateWalkProse(aWalk(), { store, model })

    expect(judgement).toEqual({ kind: 'scrubbed', redacted: 0 })
    /** One red-line call and one marking call — not one pair per field. */
    expect(asked).toHaveLength(2)
    expect(asked[0]?.system).toBe(ANSWER_RED_LINE_PROMPT)
    expect(asked[1]?.system).toBe(CONFIDENTIALITY_PROMPT)
    /** The same bytes both times, so a span marked in one is found in the other. */
    expect(asked[0]?.user).toBe(asked[1]?.user)
    expect(asked[0]?.user).toContain(WALK_PROSE_QUESTIONS.did)
    expect(asked[0]?.user).toContain(WALK_PROSE_QUESTIONS.broke)
    expect(written[0]?.scrubbed).toEqual(aWalk().prose)
  })

  it('removes a span from the field that holds it and leaves the rest alone', async () => {
    const { model } = answering({ spans: ['clawmail.com'] })
    const { store, written } = recording([
      aWalk({ note: 'The address I made was colette@clawmail.com and it worked.' }),
    ])

    const judgement = await moderateWalkProse(
      aWalk({ note: 'The address I made was colette@clawmail.com and it worked.' }),
      { store, model },
    )

    expect(judgement).toEqual({ kind: 'scrubbed', redacted: 1 })
    expect(written[0]?.scrubbed.note).toBe(
      `The address I made was colette@${REDACTION} and it worked.`,
    )
    /** Untouched fields go back the way they came, so nothing is lost to a scrub. */
    expect(written[0]?.scrubbed.did).toBe(aWalk().prose.did)
  })

  /**
   * The rule `markConfidential` set and this pass inherits: a span the page does
   * not contain is a paraphrase, and redacting on one replaces a string nobody
   * wrote while leaving the one somebody did.
   */
  it('ignores a span the page does not actually contain', async () => {
    const { model } = answering({ spans: ['a phone number the walker never typed'] })
    const { store, written } = recording()

    const judgement = await moderateWalkProse(aWalk(), { store, model })

    expect(judgement).toEqual({ kind: 'scrubbed', redacted: 0 })
    expect(written[0]?.scrubbed).toEqual(aWalk().prose)
  })

  it('refuses a page that crosses a red line, without paying for the marking', async () => {
    const { model, asked } = answering({ redLine: 'crossed' })
    const { store, written, refused } = recording()

    const judgement = await moderateWalkProse(aWalk(), { store, model })

    expect(judgement.kind).toBe('refused')
    expect(asked).toHaveLength(1)
    expect(refused).toEqual(['11111111-1111-4111-8111-111111111111'])
    expect(written).toHaveLength(0)
  })

  /**
   * A failure leaves the row pending rather than approving or refusing it, so a
   * model that fell over costs a page one poll and never a verdict it did not
   * reach.
   */
  it('writes nothing when the model fails', async () => {
    const model: Model = {
      name: 'test-model',
      classify: async () => {
        throw new Error('the provider is unreachable')
      },
      mark: async () => [],
      compose: async () => [],
      embed: async () => [],
    }
    const { store, written, refused } = recording()

    const judgement = await moderateWalkProse(aWalk(), { store, model })

    expect(judgement.kind).toBe('failed')
    expect(written).toHaveLength(0)
    expect(refused).toHaveLength(0)
  })

  it('counts a batch it took through, one outcome at a time', async () => {
    const { model } = answering()
    const { store } = recording([
      aWalk(),
      { ...aWalk(), walkId: '22222222-2222-4222-8222-222222222222' },
    ])

    const outcome = await walkProseTick({ store, model }, 10)

    expect(outcome).toEqual({ judged: 2, scrubbed: 2, refused: 0, failed: 0 })
  })

  it('re-scrubs a finished approval through the same marker and stores only redacted prose', async () => {
    const prose = { note: 'The private handle I used was identifying-handle.' }
    const { model } = answering({ spans: ['identifying-handle'] })
    const { store, rescrubbed } = recording([], [aWalk(prose)])

    const outcome = await walkProseTick({ store, model }, 10)

    expect(outcome).toEqual({ judged: 1, scrubbed: 1, refused: 0, failed: 0 })
    expect(rescrubbed).toEqual([
      {
        walkId: '11111111-1111-4111-8111-111111111111',
        decision: 'approved',
        scrubbed: { ...aWalk().prose, note: `The private handle I used was ${REDACTION}.` },
      },
    ])
    expect(JSON.stringify(rescrubbed)).not.toContain('identifying-handle')
  })

  it('reverses an approval when the second reading finds a crossed line', async () => {
    const { model } = answering({ redLine: 'crossed' })
    const { store, rescrubbed } = recording([], [aWalk()])

    const outcome = await walkProseTick({ store, model }, 10)

    expect(outcome).toEqual({ judged: 1, scrubbed: 0, refused: 1, failed: 0 })
    expect(rescrubbed).toEqual([
      {
        walkId: '11111111-1111-4111-8111-111111111111',
        decision: 'rejected',
      },
    ])
  })

  it('marks each provider in the repair batch stale once, however many walks it repairs', async () => {
    const { model } = answering()
    const { store, stale } = recording(
      [],
      [
        aWalk(),
        { ...aWalk(), walkId: '22222222-2222-4222-8222-222222222222' },
        {
          ...aWalk(),
          walkId: '33333333-3333-4333-8333-333333333333',
          provider: 'other-provider',
        },
      ],
    )

    await walkProseTick({ store, model }, 10)

    expect(stale).toEqual([
      { kind: 'mailbox', provider: aWalk().provider },
      { kind: 'mailbox', provider: 'other-provider' },
    ])
  })

  it('bounds both batches independently and leaves the rest for the next tick', async () => {
    const { model } = answering()
    const walks = [
      aWalk(),
      { ...aWalk(), walkId: '22222222-2222-4222-8222-222222222222' },
      { ...aWalk(), walkId: '33333333-3333-4333-8333-333333333333' },
    ]
    const { store, written, rescrubbed, limits } = recording(walks, walks)

    const outcome = await walkProseTick({ store, model }, 2)

    expect(outcome).toEqual({ judged: 4, scrubbed: 4, refused: 0, failed: 0 })
    expect(written).toHaveLength(2)
    expect(rescrubbed).toHaveLength(2)
    expect(limits).toEqual({ pending: [2], approvedWithoutScrub: [2] })
    expect(written.map(({ walkId }) => walkId)).not.toContain(
      '33333333-3333-4333-8333-333333333333',
    )
    expect(rescrubbed.map(({ walkId }) => walkId)).not.toContain(
      '33333333-3333-4333-8333-333333333333',
    )
  })
})
