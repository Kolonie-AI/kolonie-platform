import { and, asc, eq, sql } from 'drizzle-orm'
import {
  AccountKindSchema,
  AccountProviderSchema,
  RecipeRuntimeNoteSchema,
  RecipeStatusSchema,
  RecipeStepSchema,
  ReferralArrangementSchema,
  type AccountKind,
  type ProviderRecipe,
  type RecipeRuntimeNote,
  type RecipeStatus,
  type RecipeStep,
  type ReferralArrangement,
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
    about: row.about,
    /** Parsed on the way out for the reason `steps` is: `jsonb` accepts whatever was written. */
    runtimes: (row.runtimes ?? []).map((note: RecipeRuntimeNote) =>
      RecipeRuntimeNoteSchema.parse(note),
    ),
    paid: row.paid,
    /** Parsed on the way out, like `steps`: `jsonb` accepts whatever was written. */
    referral: row.referral === null ? null : ReferralArrangementSchema.parse(row.referral),
    contact: row.contact,
    lastConfirmedAt: row.lastConfirmedAt === null ? null : toTimestamp(row.lastConfirmedAt),
    status: RecipeStatusSchema.parse(row.status),
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
 * **Joinable first, then unwritten, then refusals; within each, by provider.** A
 * reader scanning the catalogue wants what it can act on at the top; an entry
 * nobody has looked at yet may still work and so sits above one known not to
 * (`#588`). The ordering is stated here rather than left to the caller, so two
 * surfaces cannot present one catalogue differently — and it agrees with
 * `atlasRank`, which orders the entries the same way one level up.
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
      sql`case ${providerRecipes.status}
            when 'joinable' then 0
            when 'unwritten' then 1
            else 2
          end`,
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
    readonly about?: string | null
    readonly runtimes?: readonly RecipeRuntimeNote[]
    readonly paid?: boolean
    readonly referral?: ReferralArrangement | null
    readonly contact?: string | null
    /** Set when a walk confirmed it. Absent on a curation edit, which confirms nothing. */
    readonly confirmedBy?: string | null
    readonly status: RecipeStatus
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
    about: entry.about ?? null,
    runtimes: [...(entry.runtimes ?? [])],
    paid: entry.paid ?? false,
    referral: entry.referral ?? null,
    contact: entry.contact ?? null,
    /**
     * **A curation edit does not confirm anything**, so this is only set when the
     * caller says a walk happened. Somebody fixing a typo must not reset the
     * clock on *has anyone actually done this lately*.
     */
    ...(entry.confirmedBy === undefined
      ? {}
      : { lastConfirmedAt: sql`now()`, lastConfirmedBy: entry.confirmedBy }),
    status: entry.status,
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

/**
 * A citizen walked this entry and it worked (`#525`).
 *
 * Separate from `writeProviderRecipe` because it changes nothing about the
 * recipe — it is the answer to *has anybody actually done this lately*, and
 * folding it into the write would mean every curation edit silently claimed to
 * be a confirmation.
 */
export async function confirmProviderRecipe(
  db: Database,
  kind: AccountKind,
  provider: string,
  agentId: string,
): Promise<void> {
  await db
    .update(providerRecipes)
    .set({ lastConfirmedAt: sql`now()`, lastConfirmedBy: agentId })
    .where(
      and(
        eq(providerRecipes.kind, kind),
        eq(providerRecipes.provider, AccountProviderSchema.parse(provider)),
      ),
    )
}

/**
 * A citizen followed this entry and it did not work, so it is a guess again.
 *
 * **Clearing the date rather than setting a flag**, which is what makes the two
 * halves one mechanism: `isStale` reads null exactly as it reads *long ago*,
 * because a reader can act on neither. `#525` asks that following an entry and
 * failing marks it stale, and this is that — called from the provider-report
 * path, so the report an agent already files is the whole of the reporting.
 */
export async function markProviderRecipeStale(
  db: Database,
  kind: AccountKind,
  provider: string,
): Promise<void> {
  await db
    .update(providerRecipes)
    .set({ lastConfirmedAt: null, lastConfirmedBy: null })
    .where(
      and(
        eq(providerRecipes.kind, kind),
        eq(providerRecipes.provider, AccountProviderSchema.parse(provider)),
      ),
    )
}
