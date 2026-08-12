import { createHash } from 'node:crypto'
import { and, asc, desc, eq } from 'drizzle-orm'
import type {
  AtlasCategory,
  ProviderRecipe,
  RecipeModerationStages,
  RecipeVerdict,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { providerRecipes } from '../schema/provider-recipes.js'
import { recipeModerations } from '../schema/recipe-moderations.js'
import { publishProviderRecipe, toRecipe } from './provider-recipes.js'

/**
 * A draft awaiting a verdict, with the row identity the entry itself does not
 * carry.
 *
 * `ProviderRecipe` is keyed by `(kind, provider)` everywhere a reader meets it,
 * and that is the right public identity — but a moderation row points at a `uuid`
 * for the reason every other moderation table does: a provider renamed or
 * re-shelved must not orphan its own audit trail.
 */
export interface RecipeDraft {
  readonly id: string
  readonly recipe: ProviderRecipe
}

/**
 * The queue the Colony judges (`#813`).
 *
 * **Drafts only, oldest first**, which is the order the walks closed in. A draft
 * is the state `finishWalk` writes and the only state this pass may move: an
 * `unwritten` entry has nothing to judge, and a `joinable` one was already
 * judged by somebody.
 *
 * **No filter on having a walk.** A draft written by the seed or by a steward is
 * as publishable as one a walk produced, and the questions asked of it are the
 * same ones — whether the steps are sound does not depend on who wrote them.
 */
export async function unjudgedRecipeDrafts(
  db: Database,
  limit: number,
): Promise<readonly RecipeDraft[]> {
  const rows = await db
    .select()
    .from(providerRecipes)
    .where(eq(providerRecipes.status, 'draft'))
    .orderBy(asc(providerRecipes.updatedAt))
    .limit(limit)

  return rows.map((row) => ({ id: row.id, recipe: toRecipe(row) }))
}

/**
 * The digest of the last verdict about this entry, if there is one.
 *
 * **The dedup stage, and it is arithmetic.** A held draft is meant to come back;
 * where it comes back *unchanged* — a steward re-queued it, a second pass reached
 * it before anybody edited it — the verdict would be the same one at the price of
 * three model calls. Comparing digests answers that without asking.
 */
export async function lastRecipeModeration(
  db: Database,
  recipeId: string,
): Promise<{ readonly decision: string; readonly contentSha256: string } | undefined> {
  const [row] = await db
    .select({
      decision: recipeModerations.decision,
      contentSha256: recipeModerations.contentSha256,
    })
    .from(recipeModerations)
    .where(eq(recipeModerations.recipeId, recipeId))
    .orderBy(desc(recipeModerations.createdAt))
    .limit(1)

  return row
}

export type RecordRecipeModerationOutcome =
  | { readonly outcome: 'written' }
  /** Somebody moved the draft between the read and the write. Two verdicts, one row. */
  | { readonly outcome: 'stale' }

/**
 * Write the verdict and act on it, in one transaction (`#813`).
 *
 * **One transaction, on `recordAtlasModeration`'s argument**: a verdict recorded
 * without the move it decided describes a queue that did not move, and a move
 * applied without its verdict is the silence this pass exists to end.
 *
 * **Conditional on the row still being a draft**, twice over — once on the read
 * and once inside `publishProviderRecipe`'s own `where`. The second is what
 * actually holds under concurrency; the first is what makes the common case
 * return `stale` without writing a moderation row for a draft that had already
 * moved.
 *
 * **`held` writes the row and moves nothing**, which is the whole reason it
 * exists: the entry stays a draft, and what a steward reads on `#814`'s screen is
 * the stages saying which question stopped it. Nothing about a held verdict is a
 * failure — the pass decided, and what it decided is *not yet*.
 */
export async function recordRecipeModeration(
  db: Database,
  input: {
    readonly recipeId: string
    readonly decision: RecipeVerdict
    readonly model: string
    readonly stages: RecipeModerationStages
    /** Required on a refusal: the walker is told why, and the table requires it. */
    readonly refusal?: string | undefined
    /** Where publishing confirmed or corrected the shelf (`#807`). */
    readonly category?: AtlasCategory | undefined
  },
): Promise<RecordRecipeModerationOutcome> {
  return await db.transaction(async (tx) => {
    const [draft] = await tx
      .select()
      .from(providerRecipes)
      .where(and(eq(providerRecipes.id, input.recipeId), eq(providerRecipes.status, 'draft')))
      .limit(1)

    if (draft === undefined) return { outcome: 'stale' as const }

    await tx.insert(recipeModerations).values({
      recipeId: input.recipeId,
      decision: input.decision,
      model: input.model,
      stages: input.stages,
      contentSha256: recipeDraftDigest(toRecipe(draft)),
    })

    if (input.decision === 'held') return { outcome: 'written' as const }

    const moved = await publishProviderRecipe(
      tx,
      input.decision === 'published'
        ? {
            kind: draft.kind as ProviderRecipe['kind'],
            provider: draft.provider,
            verdict: 'published',
            category: input.category,
          }
        : {
            kind: draft.kind as ProviderRecipe['kind'],
            provider: draft.provider,
            verdict: 'refused',
            /**
             * The table requires a reason and so does the walker. An empty one is
             * a caller's bug, and it fails here rather than reaching a reader as a
             * refusal with nothing in it.
             */
            refusal: input.refusal ?? '',
          },
    )

    return moved ? ({ outcome: 'written' } as const) : ({ outcome: 'stale' } as const)
  })
}

/**
 * Every verdict about one entry, newest first.
 *
 * The audit read. It is longer here than elsewhere by design: a draft held twice
 * and then published has three rows, and the two held ones are the record of what
 * the Colony asked for before it would stand behind the entry.
 */
export async function recipeModerationsFor(
  db: Database,
  recipeId: string,
): Promise<
  readonly {
    readonly decision: string
    readonly model: string
    readonly stages: unknown
    readonly createdAt: string
  }[]
> {
  return await db
    .select({
      decision: recipeModerations.decision,
      model: recipeModerations.model,
      stages: recipeModerations.stages,
      createdAt: recipeModerations.createdAt,
    })
    .from(recipeModerations)
    .where(eq(recipeModerations.recipeId, recipeId))
    .orderBy(desc(recipeModerations.createdAt))
}

/**
 * The digest of what was judged: the steps, and what the entry claims they
 * produce.
 *
 * **The steps and not the whole row.** A confirmation date moving, a runtime note
 * added, a title corrected — none of those change what an agent would be told to
 * do, and a digest that moved on them would re-judge the same path every time
 * anybody touched the entry. What is in it is what the six stages actually read.
 *
 * Fields are joined by a character none of them can contain, so moving text from
 * an instruction into an ask cannot produce the digest of leaving it where it was
 * — the argument `atlasProposalDigest` makes about two fields, over rather more.
 */
export function recipeDraftDigest(
  entry: Pick<ProviderRecipe, 'steps' | 'proves' | 'provesTask' | 'category'>,
): string {
  const parts = [
    entry.category,
    entry.proves ?? '',
    entry.provesTask ?? '',
    ...entry.steps.flatMap((step) => [
      step.actor,
      step.instruction ?? '',
      step.ask ?? '',
      step.secret === true ? 'secret' : '',
    ]),
  ]

  return createHash('sha256').update(parts.join('\0')).digest('hex')
}
