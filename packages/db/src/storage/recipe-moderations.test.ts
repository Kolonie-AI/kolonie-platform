import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AccountKindSchema, noRecipeStagesRun, type RecipeStep } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { providerRecipe, writeProviderRecipe } from './provider-recipes.js'
import {
  lastRecipeModeration,
  recipeDraftDigest,
  recipeModerationsFor,
  recordRecipeModeration,
  unjudgedRecipeDrafts,
} from './recipe-moderations.js'

const target = databaseTestTarget()

const MAILBOX = AccountKindSchema.parse('mailbox')

const STEPS: RecipeStep[] = [
  { actor: 'agent', instruction: 'Open the signup page and fill in the form.' },
  { actor: 'agent', instruction: 'Read the confirmation mail and follow its link.' },
]

/**
 * The Colony judging its own walked recipes (`#813`).
 *
 * What is asserted here is the thing a steward pressing a button cannot give
 * you: that the verdict and the move it decided are one transaction, and that
 * **held moves nothing** — because the table makes a refusal wipe the steps, so
 * a draft held for a fixable defect is the only way the walk survives being
 * judged.
 */
describe('a verdict about a walked recipe', () => {
  let db: Database

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
  })

  const drafted = async (
    provider: string,
    over: { readonly steps?: RecipeStep[] } = {},
  ): Promise<string> => {
    await writeProviderRecipe(db, {
      kind: MAILBOX,
      provider,
      title: provider,
      category: 'data-apis',
      status: 'draft',
      steps: over.steps ?? STEPS,
      proves: 'rung',
      provesTask: 'email-inbox',
    })

    const [draft] = await unjudgedRecipeDrafts(db, 10)
    if (draft === undefined) throw new Error('expected a draft in the queue')

    return draft.id
  }

  it('publishes a draft onto the shelf the verdict chose, and leaves the verdict behind it', async () => {
    const id = await drafted('clawmail.com')

    const written = await recordRecipeModeration(db, {
      recipeId: id,
      decision: 'published',
      model: 'a/model',
      stages: noRecipeStagesRun(),
      category: 'mailbox',
    })

    expect(written.outcome).toBe('written')

    const entry = await providerRecipe(db, MAILBOX, 'clawmail.com')
    expect(entry?.status).toBe('joinable')
    /** The shelf the verdict corrected, over the `data-apis` a walk falls back to. */
    expect(entry?.category).toBe('mailbox')
    expect(entry?.steps).toHaveLength(2)

    const [verdict] = await recipeModerationsFor(db, id)
    expect(verdict?.decision).toBe('published')
    expect(verdict?.model).toBe('a/model')
  })

  /**
   * The distinction the whole design rests on. A held draft is still a draft:
   * the queue keeps it, the steps are untouched, and what a steward reads is the
   * verdict saying which question stopped it.
   */
  it('holds a draft without moving it, and keeps it in the queue', async () => {
    const id = await drafted('clawmail.com')

    const written = await recordRecipeModeration(db, {
      recipeId: id,
      decision: 'held',
      model: 'a/model',
      stages: {
        ...noRecipeStagesRun(),
        publishable: { outcome: 'incomplete', reason: 'no proof' },
      },
    })

    expect(written.outcome).toBe('written')
    expect((await providerRecipe(db, MAILBOX, 'clawmail.com'))?.status).toBe('draft')
    expect(await unjudgedRecipeDrafts(db, 10)).toHaveLength(1)
    expect((await recipeModerationsFor(db, id))[0]?.decision).toBe('held')
  })

  it('refuses with a sentence the walker can read, and the entry keeps no steps', async () => {
    const id = await drafted('nowhere.example')

    await recordRecipeModeration(db, {
      recipeId: id,
      decision: 'refused',
      model: 'a/model',
      stages: noRecipeStagesRun(),
      refusal: 'It reads as a route around the provider’s own terms.',
    })

    const entry = await providerRecipe(db, MAILBOX, 'nowhere.example')
    expect(entry?.status).toBe('refused')
    /** `provider_recipes_unjoinable_is_empty`, which is why `held` had to exist. */
    expect(entry?.steps).toEqual([])
    expect(entry?.refusal).toContain('terms')
    expect(await unjudgedRecipeDrafts(db, 10)).toHaveLength(0)
  })

  /**
   * The race that matters: a steward publishing by hand while the pass is
   * thinking. The steward wins because they got there first, and the pass
   * records nothing rather than deciding a decided entry a second time.
   */
  it('is stale once something else has moved the draft', async () => {
    const id = await drafted('clawmail.com')

    await recordRecipeModeration(db, {
      recipeId: id,
      decision: 'published',
      model: 'a/model',
      stages: noRecipeStagesRun(),
      category: 'mailbox',
    })

    const second = await recordRecipeModeration(db, {
      recipeId: id,
      decision: 'refused',
      model: 'a/model',
      stages: noRecipeStagesRun(),
      refusal: 'no',
    })

    expect(second.outcome).toBe('stale')
    expect(await recipeModerationsFor(db, id)).toHaveLength(1)
  })

  /** A held draft carries its digest forward, which is what stops the pass re-buying the same verdict. */
  it('remembers the digest of what it last judged', async () => {
    const id = await drafted('clawmail.com')
    expect(await lastRecipeModeration(db, id)).toBeUndefined()

    await recordRecipeModeration(db, {
      recipeId: id,
      decision: 'held',
      model: 'a/model',
      stages: noRecipeStagesRun(),
    })

    const last = await lastRecipeModeration(db, id)
    expect(last?.decision).toBe('held')
    expect(last?.contentSha256).toBe(
      recipeDraftDigest({
        steps: STEPS,
        proves: 'rung',
        provesTask: 'email-inbox',
        category: 'data-apis',
      }),
    )
  })

  /**
   * The digest is what tells an edited draft from a re-queued one: it moves on
   * the steps and on what they claim to produce, and on nothing else.
   */
  it('digests the steps, and not the whole row', () => {
    const base = {
      steps: STEPS,
      proves: 'rung',
      provesTask: 'email-inbox',
      category: 'data-apis',
    } as const

    expect(recipeDraftDigest(base)).toMatch(/^[0-9a-f]{64}$/)
    expect(recipeDraftDigest({ ...base, steps: [STEPS[0]!] })).not.toBe(recipeDraftDigest(base))
    expect(recipeDraftDigest({ ...base, provesTask: 'email-send' })).not.toBe(
      recipeDraftDigest(base),
    )
    /** Moving text from an instruction into an ask is a different draft, not the same one. */
    expect(
      recipeDraftDigest({
        ...base,
        steps: [{ actor: 'operator', ask: 'Open the signup page and fill in the form.' }],
      }),
    ).not.toBe(
      recipeDraftDigest({
        ...base,
        steps: [{ actor: 'operator', instruction: 'Open the signup page and fill in the form.' }],
      }),
    )
  })
})
