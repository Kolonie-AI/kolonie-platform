import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  AccountKindSchema,
  ConfidentialSpanKindSchema,
  WALK_PROSE_FIELDS,
  WALK_PROSE_QUESTIONS,
  WALK_PROSE_SCRUBBER_VERSION,
  type WalkProse,
} from '@kolonie-ai/core'
import type {
  ApprovedWalkProseWithoutScrub,
  MarkedDuplicateWalk,
  RequeuedWalkProse,
  UnmoderatedWalkProse,
} from '@kolonie-ai/db'
import type { Model } from './llm.js'
import { ANSWER_RED_LINE_PROMPT, REDACTION } from './answers.js'
import { CONFIDENTIALITY_PROMPT } from './confidentiality.js'
import {
  moderateWalkProse,
  walkProseTick,
  WALK_RED_LINE_CHOICES,
  type WalkProseModerationStore,
} from './walk-prose.js'

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

/** A walk the sweep recognised as a repeat of an earlier published one (`#1109`). */
const aRepeat = (): MarkedDuplicateWalk => ({
  walkId: '22222222-2222-4222-8222-222222222222',
  kind: AccountKindSchema.parse('mailbox'),
  provider: 'clawmail.com',
  duplicateOf: '11111111-1111-4111-8111-111111111111',
})

/** A refusal an older scrubber reached, put back in the queue (`#1108`). */
const aStaleRefusal = (): RequeuedWalkProse => ({
  walkId: '33333333-3333-4333-8333-333333333333',
  kind: AccountKindSchema.parse('mailbox'),
  provider: 'clawmail.com',
  /** Refused before the stamp existed, which is what the thirteen on production are. */
  refusedBy: null,
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
  duplicates: readonly MarkedDuplicateWalk[] = [],
  requeued: readonly RequeuedWalkProse[] = [],
  /** Whether the store reports that a refusal took the walker over the threshold. */
  suspends = false,
) => {
  const written: { walkId: string; scrubbed: WalkProse }[] = []
  const refused: string[] = []
  const rescrubbed: {
    walkId: string
    decision: 'approved' | 'rejected'
    scrubbed?: WalkProse
    markProviderStale: boolean
  }[] = []
  const limits = {
    pending: [] as number[],
    approvedWithoutScrub: [] as number[],
    markDuplicates: [] as number[],
    requeueRefused: [] as number[],
  }
  /**
   * Which pass ran when, because `#1109` places the sweep after the other two
   * and `#1108` places the re-queue before all three.
   */
  const order: string[] = []
  const store: WalkProseModerationStore = {
    requeueRefused: async (limit) => {
      limits.requeueRefused.push(limit)
      order.push('requeueRefused')
      return requeued.slice(0, limit)
    },
    pending: async (limit) => {
      limits.pending.push(limit)
      order.push('pending')
      return pending.slice(0, limit)
    },
    approvedWithoutScrub: async (limit) => {
      limits.approvedWithoutScrub.push(limit)
      order.push('approvedWithoutScrub')
      return approvedWithoutScrub.slice(0, limit)
    },
    write: async ({ walk, scrubbed }) => {
      written.push({ walkId: walk.walkId, scrubbed })
    },
    refuse: async ({ walk }) => {
      refused.push(walk.walkId)
      return { suspended: suspends }
    },
    rescrub: async ({ walk, ...decision }) => {
      rescrubbed.push({ walkId: walk.walkId, ...decision })
      return { written: true, suspended: suspends && decision.decision === 'rejected' }
    },
    markDuplicates: async (limit) => {
      limits.markDuplicates.push(limit)
      order.push('markDuplicates')
      return duplicates.slice(0, limit)
    },
  }

  return { store, written, refused, rescrubbed, limits, order }
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

    expect(outcome).toEqual({
      judged: 2,
      scrubbed: 2,
      refused: 0,
      failed: 0,
      repeats: 0,
      requeued: 0,
      suspended: 0,
    })
  })

  it('re-scrubs a finished approval through the same marker and stores only redacted prose', async () => {
    const prose = { note: 'The private handle I used was identifying-handle.' }
    const { model } = answering({ spans: ['identifying-handle'] })
    const { store, rescrubbed } = recording([], [aWalk(prose)])

    const outcome = await walkProseTick({ store, model }, 10)

    expect(outcome).toEqual({
      judged: 1,
      scrubbed: 1,
      refused: 0,
      failed: 0,
      repeats: 0,
      requeued: 0,
      suspended: 0,
    })
    expect(rescrubbed).toEqual([
      {
        walkId: '11111111-1111-4111-8111-111111111111',
        decision: 'approved',
        scrubbed: { ...aWalk().prose, note: `The private handle I used was ${REDACTION}.` },
        markProviderStale: true,
      },
    ])
    expect(JSON.stringify(rescrubbed)).not.toContain('identifying-handle')
  })

  it('reverses an approval when the second reading finds a crossed line', async () => {
    const { model } = answering({ redLine: 'crossed' })
    const { store, rescrubbed } = recording([], [aWalk()])

    const outcome = await walkProseTick({ store, model }, 10)

    expect(outcome).toEqual({
      judged: 1,
      scrubbed: 0,
      refused: 1,
      failed: 0,
      repeats: 0,
      requeued: 0,
      suspended: 0,
    })
    expect(rescrubbed).toEqual([
      {
        walkId: '11111111-1111-4111-8111-111111111111',
        decision: 'rejected',
        markProviderStale: true,
      },
    ])
  })

  /**
   * `#1097`: the store counts the refusals and decides, and the tick only
   * reports what it was told — so a suspension is a number beside the refusals
   * rather than a second query the runner runs.
   */
  it('counts the refusals that took a walker over the threshold', async () => {
    const { model } = answering({ redLine: 'crossed' })
    const { store } = recording([aWalk()], [], [], [], true)

    const outcome = await walkProseTick({ store, model }, 10)

    expect(outcome.refused).toBe(1)
    expect(outcome.suspended).toBe(1)
  })

  /** A reversal is a refusal too, so the walker it belongs to reaches the same threshold. */
  it('counts a suspension a reversed approval reached', async () => {
    const { model } = answering({ redLine: 'crossed' })
    const { store } = recording([], [aWalk()], [], [], true)

    const outcome = await walkProseTick({ store, model }, 10)

    expect(outcome.refused).toBe(1)
    expect(outcome.suspended).toBe(1)
  })

  it('marks each provider in the repair batch stale once, however many walks it repairs', async () => {
    const { model } = answering()
    const { store, rescrubbed } = recording(
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

    expect(rescrubbed.map(({ markProviderStale }) => markProviderStale)).toEqual([
      true,
      false,
      true,
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

    expect(outcome).toEqual({
      judged: 4,
      scrubbed: 4,
      refused: 0,
      failed: 0,
      repeats: 0,
      requeued: 0,
      suspended: 0,
    })
    expect(written).toHaveLength(2)
    expect(rescrubbed).toHaveLength(2)
    expect(limits).toEqual({
      pending: [2],
      approvedWithoutScrub: [2],
      markDuplicates: [2],
      requeueRefused: [2],
    })
    expect(written.map(({ walkId }) => walkId)).not.toContain(
      '33333333-3333-4333-8333-333333333333',
    )
    expect(rescrubbed.map(({ walkId }) => walkId)).not.toContain(
      '33333333-3333-4333-8333-333333333333',
    )
  })

  it('sweeps the published walks for repeats last, after both passes have written', async () => {
    const { model } = answering()
    const { store, order } = recording([aWalk()], [aWalk()], [aRepeat()])

    const outcome = await walkProseTick({ store, model }, 10)

    /**
     * Last on purpose (`#1109`, 1): a scrub written a moment ago is a text this
     * comparison should see on the same tick rather than the next one.
     */
    expect(order).toEqual(['requeueRefused', 'pending', 'approvedWithoutScrub', 'markDuplicates'])
    expect(outcome.repeats).toBe(1)
  })

  it('counts a repeat without counting it as a judgement, because no model read it', async () => {
    const { model, asked } = answering()
    const { store } = recording([], [], [aRepeat()])

    const outcome = await walkProseTick({ store, model }, 10)

    expect(outcome).toEqual({
      judged: 0,
      scrubbed: 0,
      refused: 0,
      failed: 0,
      repeats: 1,
      requeued: 0,
      suspended: 0,
    })
    /** The signal is a trigram comparison in the database, so nothing was asked. */
    expect(asked).toHaveLength(0)
  })

  it('bounds the sweep by the same batch as the passes above it', async () => {
    const { model } = answering()
    const { store, limits } = recording(
      [],
      [],
      [aRepeat(), { ...aRepeat(), walkId: '44444444-4444-4444-8444-444444444444' }],
    )

    const outcome = await walkProseTick({ store, model }, 1)

    expect(limits.markDuplicates).toEqual([1])
    expect(outcome.repeats).toBe(1)
  })

  it('puts the refusals an older scrubber reached back before it reads the queue', async () => {
    const { model } = answering()
    const { store, order } = recording([], [], [], [aStaleRefusal()])

    const outcome = await walkProseTick({ store, model }, 10)

    /**
     * First on purpose (`#1108`, 6): what it writes is `pending`, so a refusal
     * put back a moment ago is read by the queue below on this tick rather than
     * the next. That is what makes a version bump one run and not two.
     */
    expect(order[0]).toBe('requeueRefused')
    expect(outcome.requeued).toBe(1)
  })

  it('counts a re-queued refusal apart from a judgement, because nothing was read', async () => {
    const { model, asked } = answering()
    const { store } = recording([], [], [], [aStaleRefusal()])

    const outcome = await walkProseTick({ store, model }, 10)

    expect(outcome).toEqual({
      judged: 0,
      scrubbed: 0,
      refused: 0,
      failed: 0,
      repeats: 0,
      requeued: 1,
      suspended: 0,
    })
    /** One predicate in the database, so no model call was paid for. */
    expect(asked).toHaveLength(0)
  })

  it('bounds the re-queue by the same batch as every other pass', async () => {
    const { model } = answering()
    const { store, limits } = recording(
      [],
      [],
      [],
      [aStaleRefusal(), { ...aStaleRefusal(), walkId: '55555555-5555-4555-8555-555555555555' }],
    )

    const outcome = await walkProseTick({ store, model }, 1)

    expect(limits.requeueRefused).toEqual([1])
    expect(outcome.requeued).toBe(1)
  })
})

/**
 * The scrubbing path, as the bytes that decide a verdict (`#1108`, 3).
 *
 * Both prompts, the choices the red-line question is answered with, the span
 * kinds the marking may return and the fields judged. Everything a change to
 * would make an earlier refusal a verdict a different scrubber reached — and
 * nothing else, because a digest over the whole file would fail on a comment.
 */
const scrubberInputs = () =>
  createHash('sha256')
    .update(
      JSON.stringify([
        ANSWER_RED_LINE_PROMPT,
        CONFIDENTIALITY_PROMPT,
        WALK_RED_LINE_CHOICES,
        ConfidentialSpanKindSchema.options,
        WALK_PROSE_FIELDS,
      ]),
    )
    .digest('hex')

/**
 * What {@link scrubberInputs} came to when `WALK_PROSE_SCRUBBER_VERSION` was last
 * decided.
 *
 * **Moved by `#1120` without the version moving, deliberately.** The seventh prose
 * field `about` was appended to `WALK_PROSE_FIELDS`, which is one of the inputs
 * digested here, so this had to be recomputed. It cannot change a verdict already
 * reached: every walk judged before that field existed answers nothing in it, so
 * `walkProseText` renders byte-identical prose for all of them and a re-read would
 * arrive at exactly the same page. Bumping the version would have put every
 * refusal the Colony holds back in front of the model to be told the same thing
 * twice, at cost.
 */
const SCRUBBER_INPUTS_DIGEST = 'e1a1426598f42139d191c99a64b4334b0c18b6d7f52cd034bebe6bb06b06df95'

/**
 * **What stops the version being forgotten is this test and not a mechanism**
 * (`#1108`, 3).
 *
 * A runtime hash would re-read every refusal the Colony holds on a whitespace
 * fix, and no reviewer reading that diff could tell whether it was about to.
 * This fails instead, in the pull request that changed the prompt, and says what
 * to do about it — which is a decision made by a person rather than by a
 * checksum.
 */
describe('pinning the scrubber version to the scrubber', () => {
  it('fails when the scrubbing path changes and the version does not', () => {
    expect(
      scrubberInputs(),
      'The scrubbing path changed. If a page could now be judged differently, bump ' +
        'WALK_PROSE_SCRUBBER_VERSION in packages/core/src/account/walk-prose.ts — every ' +
        'refusal stamped below it is put back in front of the scrubber — and record the new ' +
        'digest here. If the change cannot move a verdict, record the digest alone and leave ' +
        'the version where it is.',
    ).toBe(SCRUBBER_INPUTS_DIGEST)
  })

  /** The version the digest above belongs to, so the pair is read together. */
  it('is the version the runner and the storage both stamp with', () => {
    expect(WALK_PROSE_SCRUBBER_VERSION).toBe(1)
  })
})
