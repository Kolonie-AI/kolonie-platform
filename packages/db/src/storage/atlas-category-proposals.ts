import { and, asc, eq, sql } from 'drizzle-orm'
import {
  AccountKindSchema,
  AccountProviderSchema,
  AtlasCategoryProposalStatusSchema,
  atlasShelvedKinds,
  type AtlasCategoryProposal,
  type AtlasCategoryProposalDraft,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { atlasCategories } from '../schema/atlas-categories.js'
import { atlasCategoryProposals } from '../schema/atlas-category-proposals.js'
import { providerRecipeCategories } from '../schema/provider-recipe-categories.js'
import { providerRecipes } from '../schema/provider-recipes.js'
import { toTimestamp } from './rows.js'

type Handle = Database | Transaction

/**
 * The queue between a model reading walks and a maintainer agreeing (`#1106`).
 *
 * **Nothing here writes a shelf, and that is the issue's first decision.** The
 * runner puts rows in with {@link openAtlasCategoryProposal} and the console
 * takes them out with {@link decideAtlasCategoryProposal}; the only function that
 * touches the catalogue is the accept half of the second one, and it writes what
 * the row says rather than anything it worked out for itself.
 */

/** One proposal, as the two shapes it can be. */
export function toCategoryProposal(
  row: typeof atlasCategoryProposals.$inferSelect,
): AtlasCategoryProposal {
  const common = {
    id: row.id,
    kind: AccountKindSchema.parse(row.kind),
    provider: AccountProviderSchema.parse(row.provider),
    why: row.why,
    walks: [...row.walks],
    status: AtlasCategoryProposalStatusSchema.parse(row.status),
    decidedReason: row.decidedReason,
    proposedAt: toTimestamp(row.proposedAt),
    decidedAt: row.decidedAt === null ? null : toTimestamp(row.decidedAt),
  }

  if (row.shape === 'new-sub') {
    /**
     * The three columns a `new-sub` row carries are `not null` together — the
     * `shape_is_whole` check is what makes that true — so a row that reached here
     * missing one is a broken table rather than a shape to render around.
     */
    if (row.parentSlug === null || row.title === null || row.standfirst === null) {
      throw new Error(`atlas_category_proposals row ${row.id} is a new-sub missing its shelf`)
    }

    return {
      ...common,
      shape: 'new-sub',
      parent: row.parentSlug,
      category: row.categorySlug,
      title: row.title,
      standfirst: row.standfirst,
    }
  }

  return { ...common, shape: 'existing', category: row.categorySlug }
}

/** One pair the runner may write about, with the shelves it is already on. */
export interface AtlasCategoryProposalPair {
  readonly kind: string
  readonly provider: string
}

/**
 * The pairs a proposal is wanted about (`#1106`, decision 5).
 *
 * **The complement of `atlasCategoryForKind`, and nothing wider.** A pair whose
 * kind names a shelf was classified by a rule somebody wrote, not by a fallback,
 * so it produces no proposal however many walks it has — criterion 10, held by
 * the `not in` rather than by the prompt. What is left is exactly `#1096`'s
 * marked population: the entries whose shelf was defaulted, which are also the
 * pairs `measuredOnlyRecipes` synthesises because they have no catalogue row.
 *
 * **Walks are the predicate and not the entry**, because decision 4 means a pair
 * with no moderated walk cannot produce a proposal at all — the model would have
 * nothing to cite. A pair with an open proposal is left out here, which is
 * decision 6 spending no model call rather than being refused by the index after
 * one.
 */
export async function atlasCategoryProposalQueue(
  db: Database,
  limit = 20,
): Promise<readonly AtlasCategoryProposalPair[]> {
  const shelved = sql.join(
    atlasShelvedKinds().map((kind) => sql`${kind}`),
    sql`, `,
  )

  const rows = await db.execute<{ kind: string; provider: string }>(sql`
    select w.kind as kind, w.provider as provider
      from account_walks w
     where w.finished_at is not null
       and w.scrubbed_prose is not null
       and w.duplicate_of is null
       and w.kind not in (${shelved})
       and not exists (
         select 1 from atlas_category_proposals p
          where p.kind = w.kind and p.provider = w.provider and p.status = 'open'
       )
     group by w.kind, w.provider
     order by max(w.finished_at) desc, w.provider asc
     limit ${limit}
  `)

  return rows.map((row) => ({ kind: row.kind, provider: row.provider }))
}

/**
 * The shelves already proposed for one pair, whatever a maintainer said
 * (`#1106`, decision 7).
 *
 * Handed to `atlasCategoryProposalSections` so a declined pairing is not in the
 * vocabulary the model chooses from. The unique index refuses it a second time
 * regardless; this is what stops the call being spent to be refused.
 */
export async function atlasCategoriesSettled(
  db: Handle,
  pair: AtlasCategoryProposalPair,
): Promise<readonly string[]> {
  const rows = await db
    .select({ slug: atlasCategoryProposals.categorySlug })
    .from(atlasCategoryProposals)
    .where(
      and(
        eq(atlasCategoryProposals.kind, pair.kind),
        eq(atlasCategoryProposals.provider, pair.provider),
      ),
    )

  return rows.map((row) => row.slug)
}

/** The shelves the pair's catalogue entry sits on today, primary among them. Empty if it has none. */
export async function atlasCategoriesHeld(
  db: Handle,
  pair: AtlasCategoryProposalPair,
): Promise<readonly string[]> {
  const rows = await db
    .select({ slug: providerRecipeCategories.categorySlug })
    .from(providerRecipeCategories)
    .innerJoin(providerRecipes, eq(providerRecipes.id, providerRecipeCategories.recipeId))
    .where(and(eq(providerRecipes.kind, pair.kind), eq(providerRecipes.provider, pair.provider)))

  return rows.map((row) => row.slug)
}

export type OpenCategoryProposalOutcome =
  | { readonly outcome: 'raised'; readonly proposal: AtlasCategoryProposal }
  /** This pair already has one waiting (`#1106`, decision 6). Nothing changed. */
  | { readonly outcome: 'already-open'; readonly proposal: AtlasCategoryProposal }
  /** This pairing was put to a maintainer once already (`#1106`, decision 7). */
  | { readonly outcome: 'already-proposed'; readonly proposal: AtlasCategoryProposal }

/**
 * Put one shelf to a maintainer.
 *
 * **The two indexes decide, not a read before the write.** The runner is a loop
 * that may be running twice, so *is there an open one* answered a moment before
 * the insert is a question whose answer expires; both rules are unique indexes
 * and this reads back which one refused it.
 */
export async function openAtlasCategoryProposal(
  db: Handle,
  input: {
    readonly kind: string
    readonly provider: string
    readonly draft: AtlasCategoryProposalDraft
    /** Which model wrote it, as configuration named it (`#207`). */
    readonly model: string
  },
): Promise<OpenCategoryProposalOutcome> {
  const kind = AccountKindSchema.parse(input.kind)
  const provider = AccountProviderSchema.parse(input.provider)
  const draft = input.draft

  const [row] = await db
    .insert(atlasCategoryProposals)
    .values({
      kind,
      provider,
      shape: draft.shape,
      categorySlug: draft.category,
      parentSlug: draft.shape === 'new-sub' ? draft.parent : null,
      title: draft.shape === 'new-sub' ? draft.title : null,
      standfirst: draft.shape === 'new-sub' ? draft.standfirst : null,
      why: draft.why,
      walks: draft.walks,
      model: input.model,
    })
    .onConflictDoNothing()
    .returning()

  if (row !== undefined) return { outcome: 'raised', proposal: toCategoryProposal(row) }

  const [pairing] = await db
    .select()
    .from(atlasCategoryProposals)
    .where(
      and(
        eq(atlasCategoryProposals.kind, kind),
        eq(atlasCategoryProposals.provider, provider),
        eq(atlasCategoryProposals.categorySlug, draft.category),
      ),
    )
    .limit(1)

  if (pairing !== undefined) {
    return { outcome: 'already-proposed', proposal: toCategoryProposal(pairing) }
  }

  const [open] = await db
    .select()
    .from(atlasCategoryProposals)
    .where(
      and(
        eq(atlasCategoryProposals.kind, kind),
        eq(atlasCategoryProposals.provider, provider),
        eq(atlasCategoryProposals.status, 'open'),
      ),
    )
    .limit(1)

  if (open === undefined) throw new Error('atlas_category_proposals conflicted with no row')

  return { outcome: 'already-open', proposal: toCategoryProposal(open) }
}

/** The queue a maintainer works through: open, oldest first. */
export async function openAtlasCategoryProposals(
  db: Database,
): Promise<readonly AtlasCategoryProposal[]> {
  const rows = await db
    .select()
    .from(atlasCategoryProposals)
    .where(eq(atlasCategoryProposals.status, 'open'))
    .orderBy(asc(atlasCategoryProposals.proposedAt))

  return rows.map(toCategoryProposal)
}

export type CategoryProposalDecision =
  { readonly decision: 'accept' } | { readonly decision: 'decline'; readonly reason: string }

export type DecideCategoryProposalOutcome =
  | { readonly outcome: 'decided'; readonly proposal: AtlasCategoryProposal }
  /** No open proposal with that id — including one another console decided a moment ago. */
  | { readonly outcome: 'not-open' }
  /** An `existing` proposal whose shelf is no longer in the taxonomy. */
  | { readonly outcome: 'no-such-category' }
  /** A `new-sub` whose slug is already a shelf. Somebody made it in the meantime. */
  | { readonly outcome: 'category-taken' }
  /** The shelf proposed is the entry's primary one (`#1106`, decision 10). */
  | { readonly outcome: 'would-move-the-primary' }

/**
 * A maintainer decides one (`#1106`, decision 8).
 *
 * **Accepting writes what the row says and nothing it inferred.** The join row,
 * and the category row where the proposal asked for a new shelf — that is the
 * whole of it, and the shape it takes depends only on whether the pair has a
 * catalogue entry:
 *
 * - **It has one.** An additional shelf is a join row with `primary` false. The
 *   entry's own `category` is untouched, which is decision 10 held by there being
 *   no statement here that could change it. A proposal naming the shelf the entry
 *   is already filed under is refused rather than written as a second row that
 *   says nothing.
 * - **It has none**, which is the whole of `#1096`'s population: those pairs are
 *   synthesised at read time and have no `provider_recipes` row, so there is no
 *   `recipe_id` for a join row to reference. The entry is written the way a walk
 *   writes one — `measured`, the provider's own name as its title, no steps and no
 *   proof — carrying the accepted shelf, and `provider_recipes_keep_primary_shelf`
 *   writes the join row from it. Nothing is inferred by that: for a pair with no
 *   row, *this provider is on that shelf* is the row, and there was no primary to
 *   move.
 *
 * **In one transaction**, because a category row written beside a proposal still
 * open is a shelf nobody agreed to that a maintainer would meet as a slug already
 * taken.
 */
export async function decideAtlasCategoryProposal(
  db: Database,
  input: { readonly id: string; readonly decision: CategoryProposalDecision },
): Promise<DecideCategoryProposalOutcome> {
  return await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(atlasCategoryProposals)
      .where(
        and(eq(atlasCategoryProposals.id, input.id), eq(atlasCategoryProposals.status, 'open')),
      )
      .for('update')
      .limit(1)

    if (row === undefined) return { outcome: 'not-open' }

    const proposal = toCategoryProposal(row)

    if (input.decision.decision === 'decline') {
      const [declined] = await tx
        .update(atlasCategoryProposals)
        .set({
          status: 'declined',
          decidedReason: input.decision.reason,
          decidedAt: sql`now()`,
        })
        .where(eq(atlasCategoryProposals.id, row.id))
        .returning()

      if (declined === undefined) throw new Error('atlas_category_proposals lost a locked row')

      return { outcome: 'decided', proposal: toCategoryProposal(declined) }
    }

    const [shelf] = await tx
      .select({ slug: atlasCategories.slug })
      .from(atlasCategories)
      .where(eq(atlasCategories.slug, proposal.category))
      .limit(1)

    if (proposal.shape === 'new-sub') {
      if (shelf !== undefined) return { outcome: 'category-taken' }

      /**
       * The parent is a foreign key and `atlas_categories`' own composite key
       * refuses a parent that is itself a sub category, so decision 3 needs no
       * check here: a proposal that would make a third level cannot be inserted.
       */
      await tx.insert(atlasCategories).values({
        slug: proposal.category,
        title: proposal.title,
        standfirst: proposal.standfirst,
        parentSlug: proposal.parent,
      })
    } else if (shelf === undefined) {
      return { outcome: 'no-such-category' }
    }

    const [entry] = await tx
      .select({ id: providerRecipes.id, category: providerRecipes.category })
      .from(providerRecipes)
      .where(
        and(
          eq(providerRecipes.kind, proposal.kind),
          eq(providerRecipes.provider, proposal.provider),
        ),
      )
      .limit(1)

    if (entry === undefined) {
      await tx.insert(providerRecipes).values({
        kind: proposal.kind,
        provider: proposal.provider,
        title: proposal.provider,
        category: proposal.category,
        status: 'measured',
        steps: [],
        proves: null,
        refusal: null,
        cautions: [],
      })
    } else {
      if (entry.category === proposal.category) return { outcome: 'would-move-the-primary' }

      await tx
        .insert(providerRecipeCategories)
        .values({ recipeId: entry.id, categorySlug: proposal.category, primary: false })
        .onConflictDoNothing()
    }

    const [accepted] = await tx
      .update(atlasCategoryProposals)
      .set({ status: 'accepted', decidedAt: sql`now()` })
      .where(eq(atlasCategoryProposals.id, row.id))
      .returning()

    if (accepted === undefined) throw new Error('atlas_category_proposals lost a locked row')

    return { outcome: 'decided', proposal: toCategoryProposal(accepted) }
  })
}
