import { describe, expect, it } from 'vitest'
import { MODERATION_STAGE_NOT_RUN, type ProviderRecipe, type RecipeStep } from '@kolonie-ai/core'
import type { Model } from './llm.js'
import { judgeDraft, recipeTick, type RecipeModerationStore } from './recipes.js'
import { RECIPE_RED_LINE_PROMPT, RECIPE_STEPS_PROMPT } from './recipe-prompts.js'

const aStep = (over: Partial<RecipeStep> = {}): RecipeStep =>
  ({
    actor: 'agent',
    instruction: 'Open the signup page and fill in the form.',
    ...over,
  }) as RecipeStep

const aRecipe = (over: Partial<ProviderRecipe> = {}): ProviderRecipe =>
  ({
    kind: 'mailbox',
    provider: 'clawmail.com',
    title: 'ClawMail',
    category: 'mailbox',
    operatorNeed: 'agent-alone',
    operatorNeedIsGuess: false,
    about: 'A mailbox provider that takes a signup without a phone number.',
    runtimes: [],
    paid: false,
    referral: null,
    contact: null,
    lastConfirmedAt: null,
    status: 'draft',
    refusal: null,
    retiredAt: null,
    retiredReason: null,
    steps: [aStep(), aStep({ instruction: 'Read the confirmation mail and follow its link.' })],
    proves: 'rung',
    provesTask: 'email-inbox',
    reaches: null,
    caution: null,
    walkedRecipe: null,
    agentApi: 'full',
    signupCode: 'none',
    pacePerDay: null,
    updatedAt: '2026-08-12T00:00:00.000Z',
    ...over,
  }) as ProviderRecipe

const aDraft = (over: Partial<ProviderRecipe> = {}) => ({
  id: '11111111-1111-4111-8111-111111111111',
  recipe: aRecipe(over),
})

/**
 * A model that answers each question in that question's own vocabulary.
 *
 * **Keyed on the prompt rather than on call order**, the argument the Atlas
 * pass's fake makes: the order is part of what is under test, and a fake keyed on
 * the call index would pass a pipeline that asked the questions backwards.
 */
const answering = (
  verdicts: {
    readonly redLine?: 'clear' | 'crossed'
    readonly steps?: 'sound' | 'unsound'
    readonly shelf?: string
  } = {},
  reason = 'Step 2 does not say where the link goes.',
) => {
  const asked: { system: string; user: string }[] = []
  const model: Model = {
    name: 'test-model',
    classify: async (request) => {
      asked.push({ system: request.system, user: request.user })

      const decision =
        request.system === RECIPE_RED_LINE_PROMPT
          ? (verdicts.redLine ?? 'clear')
          : request.system === RECIPE_STEPS_PROMPT
            ? (verdicts.steps ?? 'sound')
            : (verdicts.shelf ?? 'mailbox')

      return { decision, reason }
    },
    mark: async () => [],
    compose: async () => [],
    embed: async () => [],
  }

  return { model, asked }
}

/** A store that records what it was told to do rather than doing it. */
const recording = (
  over: {
    readonly last?: { readonly decision: string; readonly contentSha256: string }
    readonly digest?: string
    readonly stale?: boolean
    readonly pending?: readonly { readonly id: string; readonly recipe: ProviderRecipe }[]
  } = {},
) => {
  const written: Parameters<RecipeModerationStore['record']>[0][] = []
  const store: RecipeModerationStore = {
    pending: async () => over.pending ?? [aDraft()],
    lastVerdict: async () => over.last,
    digest: () => over.digest ?? 'a-digest',
    record: async (input) => {
      written.push(input)
      return { outcome: over.stale === true ? 'stale' : 'written' }
    },
  }

  return { store, written }
}

describe('the Colony judging a walked recipe', () => {
  it('publishes a draft that clears every question, on the shelf it chose', async () => {
    const { model, asked } = answering({ shelf: 'mailbox' })
    const { store, written } = recording()

    const judgement = await judgeDraft(aDraft(), { store, model })

    expect(judgement).toEqual({ kind: 'published', category: 'mailbox' })
    /** Three questions, and the two arithmetic stages cost nothing. */
    expect(asked).toHaveLength(3)
    expect(written[0]).toMatchObject({ decision: 'published', category: 'mailbox' })
    expect(written[0]?.model).toBe('test-model')
  })

  it('refuses a red line without paying for the questions behind it', async () => {
    const { model, asked } = answering({ redLine: 'crossed' })
    const { store, written } = recording()

    const judgement = await judgeDraft(aDraft(), { store, model })

    expect(judgement.kind).toBe('refused')
    expect(asked).toHaveLength(1)
    /** Named to nobody, `#694`'s second register: the refusal points at the rules, not at one. */
    expect(judgement.kind === 'refused' && judgement.refusal).not.toContain('captcha')
    expect(written[0]?.decision).toBe('refused')
    expect(written[0]?.refusal).toBeTruthy()
    expect(written[0]?.stages.steps.outcome).toBe(MODERATION_STAGE_NOT_RUN)
    /** The model's sentence is kept on the row even though nobody is shown it. */
    expect(written[0]?.stages.redLine.reason).toBeTruthy()
  })

  /**
   * The distinction the whole table is arranged around: a fixable defect is
   * *held*, because `provider_recipes_unjoinable_is_empty` makes a refusal wipe
   * the steps — refusing a draft for a missing sentence would destroy the walk
   * that produced it.
   */
  it('holds a draft whose step names a credential, and asks the model nothing more', async () => {
    const { model, asked } = answering()
    const { store, written } = recording()

    const judgement = await judgeDraft(
      aDraft({
        steps: [aStep(), aStep({ instruction: 'The password is Tr0ub4dor-3' })],
      }),
      { store, model },
    )

    expect(judgement.kind).toBe('held')
    expect(judgement.kind === 'held' && judgement.reason).toContain('Step 2')
    /** The red line was paid for, the steps question was not. */
    expect(asked).toHaveLength(1)
    expect(written[0]?.decision).toBe('held')
    expect(written[0]?.stages.credentials.outcome).toBe('named')
  })

  it('holds a draft a constraint would reject, before asking about its prose', async () => {
    const { model, asked } = answering()
    const { store, written } = recording()

    const judgement = await judgeDraft(aDraft({ steps: [] }), { store, model })

    expect(judgement.kind).toBe('held')
    expect(asked).toHaveLength(1)
    expect(written[0]?.stages.publishable.outcome).toBe('incomplete')
    expect(written[0]?.stages.steps.outcome).toBe(MODERATION_STAGE_NOT_RUN)
  })

  it('holds an unsound draft with the model’s own sentence, so it can be fixed', async () => {
    const { model } = answering({ steps: 'unsound' }, 'Step 2 does not say where the link goes.')
    const { store, written } = recording()

    const judgement = await judgeDraft(aDraft(), { store, model })

    expect(judgement).toEqual({
      kind: 'held',
      reason: 'Step 2 does not say where the link goes.',
    })
    expect(written[0]?.stages.shelf.outcome).toBe(MODERATION_STAGE_NOT_RUN)
  })

  /** A held draft that comes back unedited gets the same verdict, so nothing is asked. */
  it('asks nothing about a draft it has already judged unchanged', async () => {
    const { model, asked } = answering()
    const { store, written } = recording({
      digest: 'the-same',
      last: { decision: 'held', contentSha256: 'the-same' },
    })

    expect(await judgeDraft(aDraft(), { store, model })).toEqual({ kind: 'unchanged' })
    expect(asked).toHaveLength(0)
    expect(written).toHaveLength(0)
  })

  it('judges a draft again once its steps have changed', async () => {
    const { model, asked } = answering()
    const { store } = recording({
      digest: 'the-new-one',
      last: { decision: 'held', contentSha256: 'the-old-one' },
    })

    expect((await judgeDraft(aDraft(), { store, model })).kind).toBe('published')
    expect(asked).toHaveLength(3)
  })

  /**
   * The clause the design rests on: an unreachable model leaves the draft a
   * draft. Not published, not refused, retried on the next tick — and it costs
   * less here than anywhere, because a draft is already where a draft belongs.
   */
  it('records nothing when a stage throws', async () => {
    const model: Model = {
      name: 'test-model',
      classify: async () => {
        throw new Error('the gateway did not answer')
      },
      mark: async () => [],
      compose: async () => [],
      embed: async () => [],
    }
    const { store, written } = recording()

    expect((await judgeDraft(aDraft(), { store, model })).kind).toBe('failed')
    expect(written).toHaveLength(0)
  })

  /** Somebody published it while the model was thinking. One row, one decision. */
  it('reports a draft moved under it as stale', async () => {
    const { model } = answering()
    const { store } = recording({ stale: true })

    expect((await judgeDraft(aDraft(), { store, model })).kind).toBe('stale')
  })

  it('counts a pass over the queue', async () => {
    const { model } = answering()
    const { store } = recording()

    expect(await recipeTick({ store, model }, 10)).toEqual({
      judged: 1,
      published: 1,
      refused: 0,
      held: 0,
      failed: 0,
    })
  })

  /** An unchanged draft is the steady state of a queue that is working, and is counted as nothing. */
  it('counts nothing for a draft it had already judged', async () => {
    const { model } = answering()
    const { store } = recording({
      digest: 'the-same',
      last: { decision: 'published', contentSha256: 'the-same' },
    })

    expect(await recipeTick({ store, model }, 10)).toEqual({
      judged: 0,
      published: 0,
      refused: 0,
      held: 0,
      failed: 0,
    })
  })
})
