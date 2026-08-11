import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import {
  AccountKindSchema,
  AccountProviderSchema,
  AgentApiSchema,
  AtlasCategorySchema,
  SignupCodeSchema,
  RecipeOperatorGuessSchema,
  RecipeRuntimeNoteSchema,
  RecipeReachSchema,
  RecipeStatusSchema,
  RecipeStepSchema,
  operatorNeed,
  recipeStatusIsPublic,
  ReferralArrangementSchema,
  type AccountKind,
  type AgentApi,
  type AtlasCategory,
  type SignupCode,
  type ProviderRecipe,
  type RecipeOperatorGuess,
  type RecipeReach,
  type RecipeRuntimeNote,
  type RecipeStatus,
  type RecipeStep,
  type ReferralArrangement,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'

/**
 * **These take a transaction as well as a pool** (`#601`).
 *
 * `finishWalk` reads an entry and writes a draft inside the transaction that
 * closes the walk, because a walk marked `proved` whose draft was not written
 * is a record claiming a recipe that does not exist. Widening the parameter is
 * the whole of what that needed — the queries are unchanged.
 */
type Handle = Database | Transaction
import { providerRecipes } from '../schema/provider-recipes.js'
import { toTimestamp } from './rows.js'

/**
 * The provider catalogue (`#521`).
 *
 * Read whole, always: nothing queries across steps, so the row is the unit and
 * there is no join here.
 */

function toRecipe(row: typeof providerRecipes.$inferSelect): ProviderRecipe {
  const steps = (row.steps ?? []).map((step: RecipeStep) => RecipeStepSchema.parse(step))

  /**
   * **Derived here and stored nowhere** (`#589`). One implementation, called on
   * the way out of the only place rows come from, so no surface can answer this
   * question differently from another — and none of them can answer it from a
   * column that went stale when step three was edited.
   */
  const need = operatorNeed({
    steps,
    operatorGuess:
      row.operatorGuess === null ? null : RecipeOperatorGuessSchema.parse(row.operatorGuess),
  })

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
    category: AtlasCategorySchema.parse(row.category),
    operatorNeed: need.need,
    operatorNeedIsGuess: need.isGuess,
    refusal: row.refusal,
    retiredAt: row.retiredAt === null ? null : toTimestamp(row.retiredAt),
    retiredReason: row.retiredReason,
    /**
     * **Parsed on the way out, not trusted.** `jsonb` accepts whatever was written,
     * and a row inserted by hand is exactly the case this catalogue is built to
     * allow — so the shape is checked where it is read rather than assumed from
     * where it came from. A malformed step throws here, loudly, instead of reaching
     * an agent as an instruction with a missing ask.
     */
    steps,
    proves: row.proves as ProviderRecipe['proves'],
    provesTask: row.provesTask,
    /** Parsed on the way out, like `steps`: `jsonb` accepts whatever was written. */
    reaches: row.reaches === null ? null : RecipeReachSchema.parse(row.reaches),
    caution: row.caution,
    agentApi: AgentApiSchema.parse(row.agentApi),
    signupCode: SignupCodeSchema.parse(row.signupCode),
    pacePerDay: row.pacePerDay,
    updatedAt: toTimestamp(row.updatedAt),
  }
}

/**
 * Every entry, or every entry for one kind.
 *
 * **Joinable first, then drafts, then unwritten, then refusals and withdrawals;
 * within each, by provider.** A reader scanning the catalogue wants what it can
 * act on at the top; an entry nobody has looked at yet may still work and so
 * sits above one known not to (`#588`). The ordering is stated here rather than
 * left to the caller, so two surfaces cannot present one catalogue differently —
 * and it agrees with `atlasRank`, which orders the entries the same way one
 * level up.
 *
 * **`includeInternal` is the parameter `#604` added, and the default is the safe
 * direction.** Two of the six states never reach a stranger: a `proposed` entry
 * is somebody else's suggestion, unread; a `draft` is the Colony's own work in
 * progress. Every existing caller keeps the reading it had, and a caller that
 * wants the curation queue has to ask for it by name — which is the only shape
 * where forgetting produces *too little* rather than an unreviewed claim about
 * somebody's product on a public page.
 */
export async function providerRecipeList(
  db: Handle,
  kind?: AccountKind,
  options?: { readonly includeInternal?: boolean },
): Promise<readonly ProviderRecipe[]> {
  const publicOnly = options?.includeInternal !== true
  const filters = [
    kind === undefined ? undefined : eq(providerRecipes.kind, kind),
    /**
     * **The list is `core`'s and not typed here**, so a seventh state added there
     * cannot be silently published by a filter nobody updated. `recipeStatusIsPublic`
     * is the one answer to *may a stranger see this*.
     */
    publicOnly
      ? inArray(providerRecipes.status, RecipeStatusSchema.options.filter(recipeStatusIsPublic))
      : undefined,
  ].filter((one) => one !== undefined)

  const rows = await db
    .select()
    .from(providerRecipes)
    .where(filters.length === 0 ? undefined : and(...filters))
    .orderBy(
      sql`case ${providerRecipes.status}
            when 'joinable' then 0
            when 'draft' then 1
            when 'unwritten' then 2
            when 'refused' then 3
            when 'retired' then 4
            else 5
          end`,
      asc(providerRecipes.kind),
      asc(providerRecipes.provider),
    )

  return rows.map(toRecipe)
}

/** One entry, by the pair that identifies it. */
export async function providerRecipe(
  db: Handle,
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
  db: Handle,
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
    readonly category: AtlasCategory
    /** A guess, and only where there are no steps to derive the answer from. */
    readonly operatorGuess?: RecipeOperatorGuess | null
    readonly refusal?: string | null
    /**
     * Why the Colony withdrew this entry (`#604`).
     *
     * **The reason is the caller's and the date is not** — `retiredAt` is
     * stamped below from the clock, the way `lastConfirmedAt` is. A
     * caller-supplied date could be backdated, and being read against *when did
     * I last look at this* is the date's only job.
     */
    readonly retiredReason?: string | null
    readonly steps: readonly RecipeStep[]
    readonly proves?: ProviderRecipe['proves']
    /** The rung that proves it, where the method is `rung` (`#622`). */
    readonly provesTask?: string | null
    /** What the account is then good for, and how to reach it (`#637`). */
    readonly reaches?: RecipeReach | null
    readonly caution?: string | null
    /** The answer to admission question two (`#680`). Absent means nobody looked. */
    readonly agentApi?: AgentApi
    /** Where the signup code arrives (`#597`). Absent means nobody looked. */
    readonly signupCode?: SignupCode
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
    category: entry.category,
    operatorGuess: entry.operatorGuess ?? null,
    refusal: entry.refusal ?? null,
    /**
     * **Stamped here, and cleared here** (`#604`). An entry moved out of
     * `retired` — a provider that came back — must lose both columns together,
     * or the constraint refuses the write and the reason reads as a bug in the
     * un-retiring rather than as the leftover it is.
     */
    retiredAt: entry.status === 'retired' ? sql`now()` : null,
    retiredReason: entry.status === 'retired' ? (entry.retiredReason ?? null) : null,
    steps: [...entry.steps],
    proves: entry.proves ?? null,
    /**
     * **Cleared when the method is not `rung`**, rather than carried (`#622`).
     * An entry moved off the rung proof would otherwise keep pointing at a task
     * that no longer proves it, and the check constraint would refuse the write
     * — which reads as a bug in the edit rather than as the leftover it is. The
     * same rule `retiredAt` follows four lines up.
     */
    provesTask: entry.proves === 'rung' ? (entry.provesTask ?? null) : null,
    /**
     * **Cleared when nothing is proved**, for the reason `provesTask` is: a reach
     * starts from the account this recipe produces, and an entry that stopped
     * proving one would otherwise keep a sequence that begins nowhere.
     */
    reaches: entry.proves === undefined || entry.proves === null ? null : (entry.reaches ?? null),
    caution: entry.caution ?? null,
    /**
     * **`unknown` and not the row's previous value**, because this is an upsert
     * and a curation edit that omits the field is saying nothing about it rather
     * than confirming it. Carrying the old value forward here would make an edit
     * to `about` silently re-assert an API answer nobody re-checked.
     */
    agentApi: entry.agentApi ?? 'unknown',
    signupCode: entry.signupCode ?? 'unknown',
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
 * List a provider nobody has walked, if the catalogue does not have it (`#590`).
 *
 * **`onConflictDoNothing` and never the upsert `writeProviderRecipe` uses**, and
 * the difference is the whole reason this is a second function rather than a
 * flag. What is written here is a name on a shelf; what may already be there is
 * a recipe somebody walked. An upsert would replace the second with the first,
 * which does not merely lose the steps — it replaces *this is how you join* with
 * *nobody has looked*, erasing the fact that anybody ever did.
 *
 * Returns whether a row was created, so the seed can report what it changed
 * rather than printing the same line on every deploy.
 */
export async function listAtlasProvider(
  db: Database,
  entry: {
    readonly kind: AccountKind
    readonly provider: string
    readonly title: string
    readonly category: AtlasCategory
    readonly operatorGuess?: RecipeOperatorGuess
    /**
     * The answer to admission question two, where somebody has looked (`#680`).
     *
     * **Not one of the three things a listing must not carry**, and the
     * distinction is worth stating because it looks like one. Steps, a proof and
     * a refusal each claim the signup was investigated. This claims only that
     * somebody read the provider's documentation and found out whether an API
     * exists — which is a fact about the product rather than about the walk, and
     * is the fact `#680` says the catalogue was built without.
     */
    readonly agentApi?: AgentApi
    /**
     * What makes this entry unlike its shelfmates, where that is known (`#680`).
     *
     * A caution on a listing says *nobody has walked this and here is why it is
     * worth knowing that*. It must say so in its own words — see the ones in
     * `atlas-providers.ts`, each of which names that nothing has been walked.
     */
    readonly caution?: string
  },
): Promise<boolean> {
  const written = await db
    .insert(providerRecipes)
    .values({
      kind: entry.kind,
      provider: AccountProviderSchema.parse(entry.provider),
      title: entry.title,
      category: entry.category,
      operatorGuess: entry.operatorGuess ?? null,
      agentApi: entry.agentApi ?? 'unknown',
      caution: entry.caution ?? null,
      /**
       * The three things a listing must not carry, written explicitly rather
       * than left to the column defaults: steps, a proof and a refusal are each
       * a claim that somebody looked.
       */
      status: 'unwritten',
      steps: [],
      proves: null,
      refusal: null,
    })
    .onConflictDoNothing({ target: [providerRecipes.kind, providerRecipes.provider] })
    .returning({ id: providerRecipes.id })

  return written.length > 0
}

/**
 * Answer a listing that nobody can walk (`#679`).
 *
 * A listing says *nobody has looked*. Eighteen of them were entries where
 * looking was never going to help: an account whose holder must be a natural
 * person cannot be held by an agent, and an entry that cannot be walked by
 * anybody is not a hard recipe but a wrong answer to the question the catalogue
 * exists to ask.
 *
 * **It only ever touches a row still in `unwritten`, and that is the whole
 * design.** This is the same argument `listAtlasProvider` makes one function up,
 * from the other direction: there, a listing must not overwrite a walk; here, a
 * curator's judgement about a provider nobody examined must not overwrite a walk
 * either. If somebody has since walked `stripe.com` and got through, their
 * finding outranks this list and the update passes over it — a refusal written
 * over evidence is worse than a stale refusal, because it also erases the
 * evidence.
 *
 * Returns whether a row changed, so the seed can report what it curated rather
 * than printing the same line on every deploy.
 */
export async function curateListedProvider(
  db: Database,
  entry: {
    readonly kind: AccountKind
    readonly provider: string
  } & (
    | { readonly status: 'refused'; readonly refusal: string }
    | { readonly status: 'retired'; readonly retiredReason: string }
  ),
): Promise<boolean> {
  const changed = await db
    .update(providerRecipes)
    .set({
      status: entry.status,
      refusal: entry.status === 'refused' ? entry.refusal : null,
      /** Stamped from the clock here, for the reason `writeProviderRecipe` states. */
      retiredAt: entry.status === 'retired' ? sql`now()` : null,
      retiredReason: entry.status === 'retired' ? entry.retiredReason : null,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(providerRecipes.kind, entry.kind),
        eq(providerRecipes.provider, AccountProviderSchema.parse(entry.provider)),
        /** The guard, and not a caller's responsibility: see above. */
        eq(providerRecipes.status, 'unwritten'),
      ),
    )
    .returning({ id: providerRecipes.id })

  return changed.length > 0
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
