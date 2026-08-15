import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import {
  AccountKindSchema,
  RECIPE_DRAFT_EXPIRY_DAYS,
  noRecipeStagesRun,
  type RecipeStep,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { providerRecipes } from '../schema/provider-recipes.js'
import { providerRecipe, writeProviderRecipe } from './provider-recipes.js'
import {
  expireStalledRecipeDrafts,
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

/**
 * The end of the queue that had none (`#941`).
 *
 * A held draft is re-judged every tick and gets the same verdict, forever, and
 * the four that sat that way were the whole reason the wording stage exists.
 * What is asserted here is that running out of time is a *decision* with two
 * facts behind it — a verdict that held it, and a fortnight nothing touched it —
 * rather than a sweep of everything old, and that it is **withdrawn and not
 * refused**, because a refusal empties the steps the walk produced.
 */
describe('a draft the fortnight ran out on', () => {
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

  const drafted = async (provider: string): Promise<string> => {
    await writeProviderRecipe(db, {
      kind: MAILBOX,
      provider,
      title: provider,
      category: 'data-apis',
      status: 'draft',
      steps: STEPS,
      proves: 'rung',
      provesTask: 'email-inbox',
    })

    const queued = await unjudgedRecipeDrafts(db, 50)
    const draft = queued.find((one) => one.recipe.provider === provider)
    if (draft === undefined) throw new Error('expected a draft in the queue')

    return draft.id
  }

  /** Nothing touched the row for longer than the window. */
  const aged = async (provider: string, days: number): Promise<void> => {
    await db
      .update(providerRecipes)
      .set({ updatedAt: sql`now() - (${sql.raw(String(days))} * interval '1 day')` })
      .where(eq(providerRecipes.provider, provider))
  }

  const held = async (recipeId: string, reason: string): Promise<void> => {
    const stages = noRecipeStagesRun()
    stages.publishable = { outcome: 'incomplete', reason }

    await recordRecipeModeration(db, {
      recipeId,
      decision: 'held',
      model: 'a/model',
      stages,
    })
  }

  it('withdraws it, keeps the steps, and says what it was held on', async () => {
    const id = await drafted('clawmail.com')
    await held(id, 'Step 2 has no sentence.')
    await aged('clawmail.com', RECIPE_DRAFT_EXPIRY_DAYS + 1)

    const expired = await expireStalledRecipeDrafts(db)

    expect(expired).toHaveLength(1)
    expect(expired[0]?.provider).toBe('clawmail.com')
    expect(expired[0]?.reason).toContain('Step 2 has no sentence.')

    const entry = await providerRecipe(db, MAILBOX, 'clawmail.com')
    /** `retired` and not `refused`: the constraint on a refusal would empty these. */
    expect(entry?.status).toBe('retired')
    expect(entry?.steps).toHaveLength(2)
    expect(entry?.proves).toBe('rung')
    expect(entry?.retiredReason).toContain('Step 2 has no sentence.')
    expect(entry?.retiredAt).not.toBeNull()
  })

  /** An edit, a re-walk or a fresh verdict buys another fortnight. */
  it('leaves a held draft the window has not run out on', async () => {
    const id = await drafted('clawmail.com')
    await held(id, 'Step 2 has no sentence.')
    await aged('clawmail.com', RECIPE_DRAFT_EXPIRY_DAYS - 1)

    expect(await expireStalledRecipeDrafts(db)).toHaveLength(0)
    expect((await providerRecipe(db, MAILBOX, 'clawmail.com'))?.status).toBe('draft')
  })

  /**
   * The fact that makes this a decision rather than a sweep: a draft nobody has
   * judged has not failed at anything, however long it has been sitting there.
   */
  it('leaves an old draft no verdict ever held', async () => {
    await drafted('clawmail.com')
    await aged('clawmail.com', RECIPE_DRAFT_EXPIRY_DAYS + 30)

    expect(await expireStalledRecipeDrafts(db)).toHaveLength(0)
    expect((await providerRecipe(db, MAILBOX, 'clawmail.com'))?.status).toBe('draft')
  })

  /**
   * It is the *latest* verdict that decides, and the row's status guards it a
   * second time — an entry a later verdict published is not a draft any more,
   * and the hold behind it is history rather than a standing decision.
   */
  it('leaves an entry a later verdict published', async () => {
    const id = await drafted('clawmail.com')
    await held(id, 'Step 2 has no sentence.')
    await recordRecipeModeration(db, {
      recipeId: id,
      decision: 'published',
      model: 'a/model',
      stages: noRecipeStagesRun(),
      category: 'mailbox',
    })
    await aged('clawmail.com', RECIPE_DRAFT_EXPIRY_DAYS + 1)

    expect(await expireStalledRecipeDrafts(db)).toHaveLength(0)
    expect((await providerRecipe(db, MAILBOX, 'clawmail.com'))?.status).toBe('joinable')
  })

  it('says so plainly where the verdict recorded no reason', async () => {
    const id = await drafted('clawmail.com')
    await recordRecipeModeration(db, {
      recipeId: id,
      decision: 'held',
      model: 'a/model',
      stages: noRecipeStagesRun(),
    })
    await aged('clawmail.com', RECIPE_DRAFT_EXPIRY_DAYS + 1)

    const expired = await expireStalledRecipeDrafts(db)

    expect(expired[0]?.reason).toContain('No verdict recorded')
  })
})
