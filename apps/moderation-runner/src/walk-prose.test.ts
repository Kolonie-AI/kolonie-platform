import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  AccountKindSchema,
  ConfidentialSpanKindSchema,
  GatewayUnavailable,
  WALK_PROSE_CLEAR,
  WALK_PROSE_FIELDS,
  WALK_PROSE_QUESTIONS,
  WALK_PROSE_SCRUBBER_VERSION,
  WALK_REFUSAL_LINES,
  walkProseText,
  type WalkProse,
} from '@kolonie-ai/core'
import type {
  ApprovedWalkProseWithoutScrub,
  MarkedDuplicateWalk,
  RequeuedWalkProse,
  UnmoderatedWalkProse,
} from '@kolonie-ai/db'
import type { Model } from './llm.js'
import { ProviderUnreachable } from './llm.js'
import { REDACTION } from './answers.js'
import {
  WALK_CONFIDENTIALITY_CASES,
  WALK_RED_LINE_CASES,
  WALK_RED_LINE_CLEAR,
  WALK_RED_LINE_CROSSED,
} from './__fixtures__/walk-prose.js'
import {
  moderateWalkProse,
  walkProseTick,
  WALK_CONFIDENTIAL_SPAN_KINDS,
  WALK_CONFIDENTIALITY_PROMPT,
  WALK_RED_LINE_CHOICES,
  WALK_RED_LINE_PROMPT,
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
    readonly redLine?: string
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
  /** The reason travels with the refusal (`#1340`), so the fake records both. */
  const refused: { walkId: string; reason: string }[] = []
  const rescrubbed: {
    walkId: string
    decision: 'approved' | 'rejected'
    scrubbed?: WalkProse
    reason?: string
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
    refuse: async ({ walk, reason }) => {
      refused.push({ walkId: walk.walkId, reason })
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
    expect(asked[0]?.system).toBe(WALK_RED_LINE_PROMPT)
    expect(asked[1]?.system).toBe(WALK_CONFIDENTIALITY_PROMPT)
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
    const { model, asked } = answering({ redLine: 'runnable-instruction' })
    const { store, written, refused } = recording()

    const judgement = await moderateWalkProse(aWalk(), { store, model })

    expect(judgement.kind).toBe('refused')
    expect(asked).toHaveLength(1)
    /** The judge's sentence reaches the store with the refusal (`#1340`). */
    expect(refused).toEqual([
      { walkId: '11111111-1111-4111-8111-111111111111', reason: 'It names a person.' },
    ])
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
        throw new Error('the model answered malformed content')
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

  it('aborts a batch after one typed provider outage and leaves both walks pending', async () => {
    const first = aWalk()
    const second = { ...aWalk(), walkId: '22222222-2222-4222-8222-222222222222' }
    let calls = 0
    const outage = new ProviderUnreachable(
      '/chat/completions',
      new GatewayUnavailable('status', '503'),
    )
    const model: Model = {
      name: 'test-model',
      classify: async () => {
        calls++
        throw outage
      },
      mark: async () => [],
      compose: async () => [],
      embed: async () => [],
    }
    const { store, written, refused } = recording([first, second])

    await expect(walkProseTick({ store, model }, 10)).rejects.toBe(outage)

    expect(calls).toBe(1)
    expect(written).toEqual([])
    expect(refused).toEqual([])
  })

  it('does not give a bare provider error outage semantics', async () => {
    const first = aWalk()
    const second = { ...aWalk(), walkId: '22222222-2222-4222-8222-222222222222' }
    let calls = 0
    const model: Model = {
      name: 'test-model',
      classify: async () => {
        calls++
        if (calls === 1) {
          throw new ProviderUnreachable('/chat/completions', new Error('the socket closed'))
        }
        return { decision: 'clear', reason: 'Nothing crossed.' }
      },
      mark: async () => [],
      compose: async () => [],
      embed: async () => [],
    }
    const { store, written } = recording([first, second])

    const outcome = await walkProseTick({ store, model }, 10)

    expect(outcome.failed).toBe(1)
    expect(outcome.scrubbed).toBe(1)
    expect(written.map(({ walkId }) => walkId)).toEqual([second.walkId])
  })

  it('keeps arbitrary row-local failures isolated and moderates the next walk', async () => {
    const first = aWalk()
    const second = { ...aWalk(), walkId: '22222222-2222-4222-8222-222222222222' }
    let calls = 0
    const model: Model = {
      name: 'test-model',
      classify: async () => {
        calls++
        if (calls === 1) throw new Error('the model answered malformed content')
        return { decision: 'clear', reason: 'Nothing crossed.' }
      },
      mark: async () => [],
      compose: async () => [],
      embed: async () => [],
    }
    const { store, written } = recording([first, second])

    const outcome = await walkProseTick({ store, model }, 10)

    expect(outcome.failed).toBe(1)
    expect(outcome.scrubbed).toBe(1)
    expect(written.map(({ walkId }) => walkId)).toEqual([second.walkId])
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
    const { model } = answering({ redLine: 'runnable-instruction' })
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
        /** A second reading refuses with a reason like the first (`#1340`). */
        reason: 'It names a person.',
        /** And names the line like the first (`#1467`). */
        line: 'runnable-instruction',
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
    const { model } = answering({ redLine: 'runnable-instruction' })
    const { store } = recording([aWalk()], [], [], [], true)

    const outcome = await walkProseTick({ store, model }, 10)

    expect(outcome.refused).toBe(1)
    expect(outcome.suspended).toBe(1)
  })

  /** A reversal is a refusal too, so the walker it belongs to reaches the same threshold. */
  it('counts a suspension a reversed approval reached', async () => {
    const { model } = answering({ redLine: 'runnable-instruction' })
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
 * The red line this stage asks about, against the shapes it has to sort
 * (`#1337`).
 *
 * **What is asserted here is the path and the prompt's own text, never a
 * generation.** No test in this app calls a model, and the one place that would
 * be worst to start is a red line: the assertion would sample a generation and a
 * flake in it would read as *the Colony's red line is broken*. So the table in
 * `__fixtures__/walk-prose.ts` carries the specification — seven shapes that must
 * be `clear`, three that must be `crossed` — and these tests hold the two things
 * a table cannot: that every one of those pages reaches the model whole under
 * this prompt and no other, and that each verdict is acted on. The clauses the
 * issue turns on are pinned by name below, so a rewrite that quietly drops one
 * fails here rather than in production against a citizen's standing.
 */
describe('the red line the walk stage asks about', () => {
  it('names the Colony’s own account routes as clear rather than leaving them to inference', () => {
    /** The clause that suspended two walkers: `handoff` read as a shared account. */
    expect(WALK_RED_LINE_PROMPT).toContain('kolonie.accounts.give')
    expect(WALK_RED_LINE_PROMPT).toContain('kolonie.accounts.handoff')
    expect(WALK_RED_LINE_PROMPT).toContain('an operator created and gave')
    /** And what a transfer is still not: the two words that stay violations. */
    expect(WALK_RED_LINE_PROMPT).toContain('bought or stolen')
  })

  it('does not refuse a page for naming a person', () => {
    /** `#1338` moves this to the scrub. A refusal loses the finding with the name. */
    expect(WALK_RED_LINE_PROMPT).toContain('Personal data is removed by a later pass')
    expect(WALK_RED_LINE_PROMPT).not.toContain('personal data about an identifiable third party')
  })

  it('keeps the lines that were never the problem', () => {
    expect(WALK_RED_LINE_PROMPT).toContain('run code, install a package')
    expect(WALK_RED_LINE_PROMPT).toContain('reveal, send or paste')
    expect(WALK_RED_LINE_PROMPT).toContain('contains a credential in the words')
    expect(WALK_RED_LINE_PROMPT).toContain('instructions about how to treat')
  })

  /**
   * `#1467`: each line now carries the name the model answers with, and the
   * names are `WALK_REFUSAL_LINES`. A prompt that described a line without
   * naming it would be a line the model could never select, and the column would
   * quietly never hold that value.
   */
  it('names every line the column can hold, beside the line itself', () => {
    for (const line of WALK_REFUSAL_LINES) {
      expect(WALK_RED_LINE_PROMPT).toContain(`"${line}"`)
    }
    expect(WALK_RED_LINE_CHOICES).toEqual([WALK_PROSE_CLEAR, ...WALK_REFUSAL_LINES])
  })

  it('asks for exactly the answers the choices allow', () => {
    for (const choice of WALK_RED_LINE_CHOICES) {
      expect(WALK_RED_LINE_PROMPT).toContain(`"${choice}"`)
    }
  })

  it.each(WALK_RED_LINE_CASES)('shows the model all of $name', async ({ prose }) => {
    const { model, asked } = answering()
    const { store } = recording()

    await moderateWalkProse(aWalk(prose), { store, model })

    /** The walk prompt and not the quest report's, which is what `#1337` changed. */
    expect(asked[0]?.system).toBe(WALK_RED_LINE_PROMPT)
    /** The whole rendered page, so no fixture is judged on a fragment of itself. */
    expect(asked[0]?.user).toBe(walkProseText(aWalk(prose).prose))
  })

  it.each(WALK_RED_LINE_CLEAR)(
    'publishes $name once the red line answers clear',
    async ({ prose }) => {
      const { model } = answering({ redLine: 'clear' })
      const { store, written, refused } = recording()

      const judgement = await moderateWalkProse(aWalk(prose), { store, model })

      expect(judgement.kind).toBe('scrubbed')
      expect(refused).toEqual([])
      expect(written[0]?.scrubbed).toEqual(aWalk(prose).prose)
    },
  )

  it.each(WALK_RED_LINE_CROSSED)('refuses $name and writes nothing', async ({ prose }) => {
    const { model } = answering({ redLine: 'runnable-instruction' })
    const { store, written, refused } = recording()

    const judgement = await moderateWalkProse(aWalk(prose), { store, model })

    expect(judgement.kind).toBe('refused')
    expect(refused).toHaveLength(1)
    /** A refused page is not half-published: the scrub never runs. */
    expect(written).toEqual([])
  })
})

/**
 * What the marking arm is asked, and what it may do about the answer (`#1338`).
 *
 * The red-line block above asserts the same two things about the other arm. The
 * pair is the design: one arm can refuse and asks about conduct, the other can
 * only redact and asks about people. A test that let the second refuse would be
 * asserting the bug this issue was filed over.
 */
describe('the confidentiality question the walk stage asks', () => {
  it('asks about anybody identifiable, not only about the author', () => {
    expect(WALK_CONFIDENTIALITY_PROMPT).toContain('A PARTICULAR PERSON')
    expect(WALK_CONFIDENTIALITY_PROMPT).toContain('a third party')
    expect(WALK_CONFIDENTIALITY_PROMPT).toContain('other Colony citizens')
  })

  /**
   * Acceptance criterion 4, as the prompt rather than as a case: the page is
   * *about* the provider, so its published contact detail is the finding.
   */
  it('tells the marker to leave what the provider publishes about itself', () => {
    expect(WALK_CONFIDENTIALITY_PROMPT).toContain('DO NOT MARK')
    expect(WALK_CONFIDENTIALITY_PROMPT).toContain('a contact detail the provider itself publishes')
    expect(WALK_CONFIDENTIALITY_PROMPT).toContain('the provider the page is about')
  })

  /** It marks and it cannot reject, which is the sentence `confidentiality.ts` opens with. */
  it('says outright that marking cannot cost the walker the page', () => {
    expect(WALK_CONFIDENTIALITY_PROMPT).toContain('You cannot reject it')
    expect(WALK_CONFIDENTIALITY_PROMPT).toContain('the rest of the\npage is published')
  })

  /**
   * The author's eight are all a particular person's too, so widening the
   * question cannot narrow the vocabulary — it may only add to it.
   */
  it('offers the author-owned kinds and the two a third party needs', () => {
    for (const kind of ConfidentialSpanKindSchema.options) {
      expect(WALK_CONFIDENTIAL_SPAN_KINDS).toContain(kind)
    }
    expect(WALK_CONFIDENTIAL_SPAN_KINDS).toContain('phone')
    expect(WALK_CONFIDENTIAL_SPAN_KINDS).toContain('person')
  })

  it('offers those kinds to the model rather than the author-owned set', async () => {
    const offered: (readonly string[])[] = []
    const { model } = answering()
    const marking = model.mark
    const watched: Model = {
      ...model,
      mark: async (request) => {
        offered.push(request.kinds)
        return marking(request)
      },
    }
    const { store } = recording()

    await moderateWalkProse(aWalk(), { store, model: watched })

    expect(offered).toEqual([WALK_CONFIDENTIAL_SPAN_KINDS])
  })

  it.each(WALK_CONFIDENTIALITY_CASES.map((one) => [one.name, one] as const))(
    'publishes %s rather than refusing it',
    async (_name, one) => {
      const { model } = answering({ spans: one.marked })
      const { store, written, refused } = recording([aWalk(one.prose)])

      const judgement = await moderateWalkProse(aWalk(one.prose), { store, model })

      expect(judgement).toEqual({ kind: 'scrubbed', redacted: one.marked.length })
      expect(refused).toEqual([])
      expect(written).toHaveLength(1)
    },
  )

  it.each(WALK_CONFIDENTIALITY_CASES.map((one) => [one.name, one] as const))(
    'keeps the finding and drops the person in %s',
    async (_name, one) => {
      const { model } = answering({ spans: one.marked })
      const { store, written } = recording([aWalk(one.prose)])

      await moderateWalkProse(aWalk(one.prose), { store, model })

      const published = walkProseText(written[0]?.scrubbed ?? {})
      for (const gone of one.marked) expect(published).not.toContain(gone)
      for (const kept of one.survives) expect(published).toContain(kept)
    },
  )
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
        WALK_RED_LINE_PROMPT,
        WALK_CONFIDENTIALITY_PROMPT,
        WALK_RED_LINE_CHOICES,
        WALK_CONFIDENTIAL_SPAN_KINDS,
        WALK_PROSE_FIELDS,
      ]),
    )
    .digest('hex')

/**
 * What {@link scrubberInputs} came to when `WALK_PROSE_SCRUBBER_VERSION` was last
 * decided.
 *
 * **Moved by `#1338` without the version moving, and the arm is the reason.** The
 * marking prompt and the kind vocabulary both changed here — `CONFIDENTIALITY_PROMPT`
 * gave way to {@link WALK_CONFIDENTIALITY_PROMPT}, which asks about anybody
 * identifiable rather than only about the author, and the kinds gained `phone` and
 * `person`. Both are inputs digested here, so this had to be recomputed. Neither
 * can move a verdict: the marking arm cannot refuse, so widening what it marks can
 * only change which spans a `scrubbed` page loses, never whether the page is
 * scrubbed or refused. And the refusals the widening was filed to repair are
 * already coming back — `#1337` moved the version to 2 in the same day, so every
 * refusal stamped 1 is re-read in front of *both* new prompts. A second bump would
 * re-read the same rows twice, at cost, to reach the same answer.
 *
 * **Moved to 2 by `#1337`, and the version moved with it — this is the case the
 * mechanism was built for.** `ANSWER_RED_LINE_PROMPT` was replaced here by
 * `WALK_RED_LINE_PROMPT`, which stops treating the Colony's own
 * `kolonie.accounts.give` and `kolonie.accounts.handoff` routes as *using a
 * shared account* and takes third-party personal data out of the refusal arm
 * altogether (`#1338`). Both of those changes move verdicts in one direction:
 * pages the old prompt refused are clear under this one. Thirty-one refusals
 * across two walkers are measured false positives, so leaving the version at 1
 * would leave them refused for no reason anyone can now defend. Bumping it puts
 * every refusal stamped 1 back in front of the scrubber, which is the whole
 * repair.
 *
 * **Only refusals are re-read.** An approval is never re-opened by this, so the
 * bump cannot un-publish anything a citizen already relies on.
 *
 * **Moved to 3 by `#1398`, and the version moved with it.** The last line of
 * `WALK_RED_LINE_PROMPT` told the model its sentence was *never shown to the
 * walker* — false since `#1340` made it exactly that — so it had been writing
 * for the wrong audience. It now writes for the walker and names the field
 * rather than the subject matter. No criterion moved, and the bump is the point
 * rather than a consequence: nineteen abusive verdicts stand with `reason:
 * null`, and a re-read is the only thing that gives them one.
 *
 * **Moved by `#1120` without the version moving, deliberately.** The seventh prose
 * field `about` was appended to `WALK_PROSE_FIELDS`, which is one of the inputs
 * digested here, so this had to be recomputed. It cannot change a verdict already
 * reached: every walk judged before that field existed answers nothing in it, so
 * `walkProseText` renders byte-identical prose for all of them and a re-read would
 * arrive at exactly the same page. Bumping the version would have put every
 * refusal the Colony holds back in front of the model to be told the same thing
 * twice, at cost.
 *
 * **Moved by `#1467` without the version moving, on the same reasoning.** The
 * red-line prompt and its `choices` both changed: `crossed` became the name of
 * the line crossed, so the answer is finer. **The clear/crossed boundary is
 * untouched** — the same five bullets, the same clauses about the Colony's own
 * account routes and about personal data, and nothing added to or removed from
 * what makes a page crossed. A page judged clear is still clear and a page
 * judged crossed is still crossed; only the label on the second is now recorded.
 * So no verdict already reached could move, and re-reading every refusal the
 * Colony holds would buy a `prose_refusal_line` on rows nobody is counting — the
 * backstop reads a twenty-walk window, which fills with classified rows within
 * days of the deploy.
 *
 * **Moved by `#1469`, and the version moved with it.** The prompt now says that a
 * page describing a provider whose product *is* a program the account holder
 * installs is describing the product rather than instructing the reader. That is
 * a criterion and not a label: pages refused under the old wording are clear
 * under this one, which is exactly what the twelve bandwidth-shelf refusals of
 * 2026-08-20 were. So `WALK_PROSE_SCRUBBER_VERSION` goes to 4 and those refusals
 * are read again — the bump is the repair rather than a consequence of it.
 */
const SCRUBBER_INPUTS_DIGEST = 'cddc81b4af31348477683245c88e31fe7ea837425b72cca0b1acac922a98c9b9'

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
    expect(WALK_PROSE_SCRUBBER_VERSION).toBe(4)
  })
})
