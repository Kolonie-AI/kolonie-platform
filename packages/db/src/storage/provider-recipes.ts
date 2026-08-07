import { and, asc, eq, sql } from 'drizzle-orm'
import {
  AccountKindSchema,
  AccountProviderSchema,
  RecipeStepSchema,
  type AccountKind,
  type ProviderRecipe,
  type RecipeStep,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { providerRecipes } from '../schema/provider-recipes.js'
import { toTimestamp } from './rows.js'

/**
 * The provider catalogue (`#521`).
 *
 * Read whole, always: nothing queries across steps, so the row is the unit and
 * there is no join here.
 */

function toRecipe(row: typeof providerRecipes.$inferSelect): ProviderRecipe {
  return {
    kind: AccountKindSchema.parse(row.kind),
    provider: AccountProviderSchema.parse(row.provider),
    title: row.title,
    joinable: row.joinable,
    refusal: row.refusal,
    /**
     * **Parsed on the way out, not trusted.** `jsonb` accepts whatever was written,
     * and a row inserted by hand is exactly the case this catalogue is built to
     * allow — so the shape is checked where it is read rather than assumed from
     * where it came from. A malformed step throws here, loudly, instead of reaching
     * an agent as an instruction with a missing ask.
     */
    steps: (row.steps ?? []).map((step: RecipeStep) => RecipeStepSchema.parse(step)),
    proves: row.proves as ProviderRecipe['proves'],
    caution: row.caution,
    pacePerDay: row.pacePerDay,
    updatedAt: toTimestamp(row.updatedAt),
  }
}

/**
 * Every entry, or every entry for one kind.
 *
 * **Joinable ones first, then by provider.** A reader scanning the catalogue wants
 * what it can act on at the top; the refusals are what it reads when the one it
 * wanted is not there. The ordering is stated here rather than left to the caller,
 * so two surfaces cannot present one catalogue differently.
 */
export async function providerRecipeList(
  db: Database,
  kind?: AccountKind,
): Promise<readonly ProviderRecipe[]> {
  const rows = await db
    .select()
    .from(providerRecipes)
    .where(kind === undefined ? undefined : eq(providerRecipes.kind, kind))
    .orderBy(
      sql`${providerRecipes.joinable} desc`,
      asc(providerRecipes.kind),
      asc(providerRecipes.provider),
    )

  return rows.map(toRecipe)
}

/** One entry, by the pair that identifies it. */
export async function providerRecipe(
  db: Database,
  kind: AccountKind,
  provider: string,
): Promise<ProviderRecipe | undefined> {
  const [row] = await db
    .select()
    .from(providerRecipes)
    .where(
      // `AccountProviderSchema` lowercases as it parses, so both sides are already
      // normalised and a `lower()` here would only defeat the index.
      and(
        eq(providerRecipes.kind, kind),
        eq(providerRecipes.provider, AccountProviderSchema.parse(provider)),
      ),
    )
    .limit(1)

  return row === undefined ? undefined : toRecipe(row)
}

/**
 * Write an entry, replacing whatever stood there.
 *
 * **Replace and not merge.** A recipe is a set of steps in an order; merging two
 * versions of one would produce a walk nobody wrote. A provider that changed its
 * form is described again from the top, which is also how somebody correcting an
 * entry expects it to behave.
 */
export async function writeProviderRecipe(
  db: Database,
  entry: {
    readonly kind: AccountKind
    readonly provider: string
    readonly title: string
    readonly joinable: boolean
    readonly refusal?: string | null
    readonly steps: readonly RecipeStep[]
    readonly proves?: ProviderRecipe['proves']
    readonly caution?: string | null
    readonly pacePerDay?: number | null
  },
): Promise<ProviderRecipe> {
  const values = {
    kind: entry.kind,
    provider: entry.provider,
    title: entry.title,
    joinable: entry.joinable,
    refusal: entry.refusal ?? null,
    steps: [...entry.steps],
    proves: entry.proves ?? null,
    caution: entry.caution ?? null,
    pacePerDay: entry.pacePerDay ?? null,
  }

  const [row] = await db
    .insert(providerRecipes)
    .values(values)
    .onConflictDoUpdate({
      target: [providerRecipes.kind, providerRecipes.provider],
      set: { ...values, updatedAt: sql`now()` },
    })
    .returning()

  if (row === undefined) throw new Error('provider_recipes upsert returned no row')

  return toRecipe(row)
}
