import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import {
  AccountKindSchema,
  AccountProviderSchema,
  AgentApiSchema,
  AtlasCategorySlugSchema,
  atlasCategoryForKind,
  SignupCodeSchema,
  ProviderTermsSchema,
  RecipeNeedsSchema,
  SignupCostSchema,
  RecipeOperatorGuessSchema,
  RecipeRuntimeNoteSchema,
  RecipeCautionSchema,
  RecipeReachSchema,
  RecipeStatusSchema,
  RecipeDirectionSchema,
  RecipeStepSchema,
  PublishedWallSchema,
  type PublishedWall,
  kindHasDirection,
  operatorNeed,
  recipeStatusIsPublic,
  ReferralArrangementSchema,
  type AccountKind,
  type AccountProofMethod,
  type AgentApi,
  type AtlasCategory,
  type AtlasCategorySlug,
  type SignupCode,
  type ProviderTerms,
  type RecipeNeed,
  type SignupCost,
  type ProviderRecipe,
  type RecipeOperatorGuess,
  type RecipeCaution,
  type RecipeReach,
  type RecipeRuntimeNote,
  type RecipeStatus,
  type RecipeDirection,
  type RecipeStep,
  type ReferralArrangement,
  WalkedRecipeSchema,
  type WalkedRecipe,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'

/**
 * **These take a transaction as well as a pool** (`#601`).
 *
 * `finishWalk` reads an entry and writes one inside the transaction that
 * closes the walk, because a walk marked `proved` whose entry was not written
 * is a record claiming a catalogue row that does not exist. Widening the parameter is
 * the whole of what that needed — the queries are unchanged.
 */
type Handle = Database | Transaction
import { providerRecipeCategories } from '../schema/provider-recipe-categories.js'
import { providerRecipes } from '../schema/provider-recipes.js'
import { toTimestamp } from './rows.js'

/**
 * The provider catalogue (`#521`).
 *
 * Read whole, always: nothing queries across steps, so the row is the unit and
 * there is no join here.
 */

export function toRecipe(
  row: typeof providerRecipes.$inferSelect,
  /**
   * Every shelf this entry is on, primary first (`#1102`, decision 4).
   *
   * **Optional, and absent means *the one shelf the column names*.** `toRecipe`
   * is called from a dozen places, several of which have a row in hand and no
   * transaction to run a second query on — a walk closing, a proposal being
   * accepted — and none of them would be improved by a join. The invariant the
   * trigger in `0279` keeps is exactly that the primary row and the column say
   * the same thing, so the fallback is not a guess: it is the same answer, read
   * off the copy that is already here.
   */
  shelves?: readonly string[],
): ProviderRecipe {
  const steps = (row.steps ?? []).map((step: RecipeStep) => RecipeStepSchema.parse(step))

  /** Parsed on the way out, like `steps` and `reaches`: `jsonb` is not a shape. */
  const walkedRecipe = row.walkedRecipe === null ? null : WalkedRecipeSchema.parse(row.walkedRecipe)

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
    /**
     * Read here and written nowhere near here (`#1120`, rendered by `#1121`).
     *
     * The column is filled by `writeProviderDescription` and left alone by
     * `writeProviderRecipe` below, so a curator saving a recipe cannot flatten
     * the sentence the runner wrote. Reading it costs nothing extra: it is on
     * the row the entry is already selected from.
     */
    description: row.description,
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
    /**
     * **A slug and no longer the enum** (`#1102`, decision 6). What makes a
     * category valid is the foreign key into `atlas_categories`; parsing the
     * fifteen here would throw on the sixteenth, which is the whole thing that
     * issue set out to stop being a release.
     */
    category: AtlasCategorySlugSchema.parse(row.category),
    categories: (shelves ?? [row.category]).map((one) => AtlasCategorySlugSchema.parse(one)),
    operatorNeed: need.need,
    operatorNeedIsGuess: need.isGuess,
    refusal: row.refusal,
    /** Parsed on the way out like `status`, and null on every row nobody scoped (`#976`). */
    direction: row.direction === null ? null : RecipeDirectionSchema.parse(row.direction),
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
    /** Parsed on the way out, like `steps` and `reaches` beside it (`#1041`). */
    cautions: RecipeCautionSchema.array().parse(row.cautions),
    walkedRecipe,
    /**
     * **Its own column since `#981`, and lifted out of `walkedRecipe` before that**
     * (`#982`). One walker's walls could be read off the blob; a count across
     * walkers cannot, and neither can the newest answer to *what does it cost* when
     * four walks measured it and only two said. So the aggregate is computed where
     * a walk finishes and stored, and read back here.
     *
     * Here, still, and nowhere else: `toRecipe` is the single place a row becomes a
     * recipe, so no two surfaces can answer this differently — the failure `#982`
     * and `#984` were both about. Parsed on the way out like every other `jsonb`.
     */
    walls: (row.walls ?? []).map((wall: PublishedWall) => PublishedWallSchema.parse(wall)),
    agentApi: AgentApiSchema.parse(row.agentApi),
    signupCode: SignupCodeSchema.parse(row.signupCode),
    /**
     * Parsed on the way out like the two above, and like `steps` (`#815`).
     *
     * **`needs` is parsed for the same reason `steps` is and a stronger one.**
     * The column's check constraint bounds the vocabulary and the length, and
     * it deliberately does not bound uniqueness — a check may not hold a
     * subquery, so `["email", "email"]` is a row the table would accept and
     * `RecipeNeedsSchema` is where it is refused. A row written before that
     * boundary existed is exactly what a parse on the way out is for.
     */
    needs: RecipeNeedsSchema.parse(row.needs),
    terms: ProviderTermsSchema.parse(row.terms),
    cost: SignupCostSchema.parse(row.cost),
    pacePerDay: row.pacePerDay,
    updatedAt: toTimestamp(row.updatedAt),
  }
}

/**
 * Every entry, or every entry for one kind.
 *
 * **Joinable first, then measured, then unwritten, then refusals and
 * withdrawals; within each, by provider.** A reader scanning the catalogue
 * wants what it can act on at the top; an entry nobody has looked at yet may
 * still work and so sits above one known not to (`#588`). The ordering is stated
 * here rather than left to the caller, so two surfaces cannot present one
 * catalogue differently — and it agrees with `atlasRank`, which orders the
 * entries the same way one level up.
 *
 * **`measured` above `unwritten` is the one placement with an argument behind
 * it** (`#903`, `kolonie-docs#352`): a provider a citizen actually proved is
 * better evidence than one somebody shelved, which is D-109 rule 2 — *ordering
 * comes from measured outcomes* — applied to a shelf where until now nothing
 * measured could appear at all.
 *
 * **`includeInternal` is the parameter `#604` added, and it currently excludes
 * nothing.** It existed for the two states that never reached a stranger — a
 * `proposed` entry nobody had read, a `draft` the Colony had not dressed — and
 * `#1032` retired both. It is kept for `recipeStatusIsPublic`'s reason: the
 * question *may a reader see this* has one answer in one place, ready for the
 * first status that answers no, rather than scattered back across five surfaces
 * the day one arrives.
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
            when 'measured' then 1
            when 'unwritten' then 2
            when 'refused' then 3
            when 'retired' then 4
            else 5
          end`,
      asc(providerRecipes.kind),
      asc(providerRecipes.provider),
    )

  const shelves = await shelvesByRecipe(
    db,
    rows.map((row) => row.id),
  )

  return rows.map((row) => toRecipe(row, shelves.get(row.id)))
}

/**
 * Which shelves each of these entries is on, primary first (`#1102`).
 *
 * **One query for the whole page rather than one per entry.** The Atlas index
 * renders four hundred entries, and a shelf lookup per row would be the n+1 that
 * `atlasEntries` exists to keep out of SQL, arriving from the other side.
 *
 * **An entry with no rows is absent rather than empty**, so `toRecipe` falls
 * back to its column. That is the state every entry written before `0279`'s
 * trigger was in, and a page that rendered *no shelves* for one would be worse
 * than a page that renders the one the column has always named.
 */
async function shelvesByRecipe(
  db: Handle,
  ids: readonly string[],
): Promise<ReadonlyMap<string, readonly string[]>> {
  if (ids.length === 0) return new Map()

  const rows = await db
    .select({
      recipeId: providerRecipeCategories.recipeId,
      categorySlug: providerRecipeCategories.categorySlug,
    })
    .from(providerRecipeCategories)
    .where(inArray(providerRecipeCategories.recipeId, [...ids]))
    /** Primary first, then alphabetically, so two reads of one entry agree. */
    .orderBy(desc(providerRecipeCategories.primary), asc(providerRecipeCategories.categorySlug))

  const byRecipe = new Map<string, string[]>()
  for (const row of rows) {
    const held = byRecipe.get(row.recipeId)
    if (held === undefined) byRecipe.set(row.recipeId, [row.categorySlug])
    else held.push(row.categorySlug)
  }

  return byRecipe
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

  if (row === undefined) return undefined

  const shelves = await shelvesByRecipe(db, [row.id])
  return toRecipe(row, shelves.get(row.id))
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
    readonly category: AtlasCategorySlug
    /** A guess, and only where there are no steps to derive the answer from. */
    readonly operatorGuess?: RecipeOperatorGuess | null
    readonly refusal?: string | null
    /**
     * Which direction the status is a verdict about, on a kind with an axis
     * (`#976`).
     *
     * **Absent resets to null, with the rest of this group**, because this is an
     * upsert: an edit that does not mention the direction is not re-asserting
     * it. The null is readable — `directionAnswers` treats it as covering both —
     * so the reset is a widening rather than a silent loss of a warning.
     */
    readonly direction?: RecipeDirection | null
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
    /**
     * The walls this entry warns about, one per capability (`#1041`).
     *
     * **The whole set, with the rest of this group**, because this is an upsert:
     * an edit that names the outbound caution and omits the inbound one is
     * saying the inbound warning is gone. Merging by direction would leave no
     * way to withdraw a caution at all.
     */
    readonly cautions?: readonly RecipeCaution[]
    /**
     * The walker's own account of the path (`#769`).
     *
     * **Omitted means *say nothing about it*, and `null` means *clear it*.** A
     * curation edit that does not mention the walker's account must not delete
     * it — the same distinction `agentApi` makes one field down, reached the
     * other way because there is no honest word here for *nobody looked*.
     */
    readonly walkedRecipe?: WalkedRecipe | null
    /** The answer to admission question two (`#680`). Absent means nobody looked. */
    readonly agentApi?: AgentApi
    /** Where the signup code arrives (`#597`). Absent means nobody looked. */
    readonly signupCode?: SignupCode
    /**
     * What an agent must already hold before the first step (`#815`).
     *
     * **Absent is *nobody was asked* and `[]` is *asked, and nothing*.** The two
     * are opposite answers, and they land on the same column value — which is
     * why the entry is read beside `terms` and `cost`, whose `unknown` is what
     * says which of the two a row is in. An edit that omits all three is saying
     * nothing about any of them.
     */
    readonly needs?: readonly RecipeNeed[]
    /** What the terms say about an agent holding this (`#815`). Absent means nobody looked. */
    readonly terms?: ProviderTerms
    /** Where money is required (`#815`). Not `paid`, which is paid placement. */
    readonly cost?: SignupCost
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
     * **Cleared on a kind with no axis**, for the reason `provesTask` is cleared
     * off a non-rung proof: the constraint refuses a direction on a mailbox, and
     * a caller that supplied one by mistake should get the write it asked for
     * minus the meaningless field rather than a failed insert (`#976`).
     */
    direction: kindHasDirection(entry.kind) ? (entry.direction ?? null) : null,
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
    cautions: entry.cautions ?? [],
    /** Left alone unless the caller said something — see the field's own note. */
    ...(entry.walkedRecipe === undefined ? {} : { walkedRecipe: entry.walkedRecipe }),
    /**
     * **`unknown` and not the row's previous value**, because this is an upsert
     * and a curation edit that omits the field is saying nothing about it rather
     * than confirming it. Carrying the old value forward here would make an edit
     * to `about` silently re-assert an API answer nobody re-checked.
     */
    agentApi: entry.agentApi ?? 'unknown',
    signupCode: entry.signupCode ?? 'unknown',
    /**
     * The same rule as `agentApi` above: an omitted answer resets rather than
     * carries forward, because this is an upsert and an edit that does not
     * mention the conditions is not re-confirming them (`#815`).
     *
     * **The empty array is what an unanswered `needs` resets to**, which is the
     * one place in this group where the reset value is also a real answer. It is
     * the same ambiguity the column carries and it is resolved the same way: an
     * edit that omits `needs` omits `terms` and `cost` too, and those two go
     * back to `unknown`, which is what marks the row as unexamined.
     */
    needs: [...(entry.needs ?? [])],
    terms: entry.terms ?? 'unknown',
    cost: entry.cost ?? 'unknown',
    pacePerDay: entry.pacePerDay ?? null,
    /**
     * **`walls` is absent from this object on purpose** (`#981`), and it is one of
     * two columns that must be. Every field here resets when the caller omits it,
     * which is right for an answer a curator gives; the walls are not an answer
     * anybody gives, they are counted from the walks. Listing them would mean a
     * typo fixed in `about` deletes what nine walkers reported. `republishWalls`
     * owns the column, and this upsert leaves it exactly as it found it.
     *
     * **`description` is the other, for the same reason** (`#1120`). It is the one
     * sentence saying what the provider is, written by the moderation runner from
     * the walks and never by a curator — `writeProviderDescription` owns it. It is
     * not `about`, which is the curator's own paragraph and is listed above like
     * every other answer they give.
     */
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
  /** A transaction where a verdict lists a provider inside the one that records it (`#812`). */
  db: Handle,
  entry: {
    readonly kind: AccountKind
    readonly provider: string
    readonly title: string
    readonly category: AtlasCategorySlug
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
     *
     * **A set here too, and not because a listing is usually walked** (`#1041`).
     * Almost every shelf caution is one unscoped sentence, and the plural shape
     * buys nothing for those. It buys `twilio.com`: the one listed provider the
     * Colony actually runs, whose findings point in two directions at once, and
     * which is on the one shelf where a direction means anything. A single
     * string here would have made the seed the place the second finding could
     * not be written — which is the defect this issue exists for, one layer up.
     */
    readonly cautions?: readonly RecipeCaution[]
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
      cautions: entry.cautions ?? [],
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
 * A provider gets a row because a citizen proved an account there (`#903`).
 *
 * **The row is written on the proof and not on the walk**, which is the whole
 * decision (`kolonie-docs#352`). A proof is a transaction the Colony already
 * runs and already trusts; a walk is a favour a stateless citizen may not live
 * long enough to do. Hanging the catalogue off the second is what produced a
 * `telephony` shelf of three unwalked entries while the one phone provider
 * anybody proved — `agentmessage.io`, measured 2026-08-14 — was not on it.
 *
 * **It writes a row and no prose.** No steps, no `proves`, no caution, no
 * `refusal`. Those are the four claims that say *somebody investigated this*,
 * and a proof says only *a citizen got in here*. The counts are not written
 * either: `atlasFigures` computes them live from `accounts` and
 * `provider_reports`, so a stored copy would be a second answer that goes stale.
 *
 * **`onConflictDoNothing` is what protects a curated entry**, in the same shape
 * `listAtlasProvider` uses one function up and for a sharper reason: a proof at
 * a provider a steward has written up must update figures and touch nothing
 * else. Since the figures are computed rather than stored, *touch nothing else*
 * is the whole of it — so doing nothing is not a shortcut here, it is the
 * specified behaviour.
 *
 * **A kind with no shelf gets no row**, on the argument `measuredOnlyRecipes`
 * already makes: `atlasCategoryForKind` throws rather than guessing, and a
 * provider filed on a wrong shelf is worse than one reachable only by its kind.
 * The proof itself must never fail for this, so the throw is caught here rather
 * than left to the transaction that is recording it.
 *
 * Returns whether a row was created, so a backfill can report what it changed.
 */
export async function recordMeasuredProvider(
  /** A transaction, so the row lands with the proof that caused it or not at all. */
  db: Handle,
  entry: { readonly kind: AccountKind; readonly provider: string },
): Promise<boolean> {
  let category: AtlasCategory
  try {
    category = atlasCategoryForKind(entry.kind)
  } catch {
    return false
  }

  const provider = AccountProviderSchema.safeParse(entry.provider)
  if (!provider.success) return false

  const written = await db
    .insert(providerRecipes)
    .values({
      kind: entry.kind,
      provider: provider.data,
      /**
       * The provider's own name, because it is the only thing anybody has
       * written down. A title the Colony invented would be prose, and prose is
       * the one thing this row may not carry.
       */
      title: provider.data,
      category,
      status: 'measured',
      steps: [],
      proves: null,
      refusal: null,
      cautions: [],
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
 * Say which capability an existing verdict was measured against (`#976`).
 *
 * **The one write that changes nothing about what a provider is judged to be.**
 * Status, refusal, steps and figures are all left exactly as they were; what is
 * added is the scope they were always true of and nobody had a field to record.
 * `agentphone.ai` is still refused after this runs — it is refused *for sending*,
 * which is what its refusal always said and what no reader could act on.
 *
 * **Guarded on `direction is null`, for the reason `curateListedProvider` states
 * one function up.** A scope somebody recorded deliberately — through a report,
 * through a walk — outranks a judgement made here about rows written before the
 * axis existed. That guard is also what makes the pass idempotent: a second run
 * finds every row scoped and writes nothing.
 *
 * Returns whether a row moved, so the seed can report what it scoped rather than
 * printing the same line on every deploy.
 */
export async function scopeProviderDirection(
  db: Database,
  entry: {
    readonly kind: AccountKind
    readonly provider: string
    readonly direction: RecipeDirection
  },
): Promise<boolean> {
  /**
   * The kind is checked here rather than left to the column's constraint,
   * because a caller that names a kind with no axis has made a mistake worth
   * reading in a stack trace rather than as a database error four frames down.
   */
  if (!kindHasDirection(entry.kind)) {
    throw new Error(`scopeProviderDirection: ${entry.kind} has no direction to scope`)
  }

  const changed = await db
    .update(providerRecipes)
    .set({
      direction: entry.direction,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(providerRecipes.kind, entry.kind),
        eq(providerRecipes.provider, AccountProviderSchema.parse(entry.provider)),
        /** The guard, and not a caller's responsibility: see above. */
        sql`${providerRecipes.direction} is null`,
      ),
    )
    .returning({ id: providerRecipes.id })

  return changed.length > 0
}

/**
 * Refuse a measured entry, and nothing else (`#808`, narrowed by `#1032`).
 *
 * **Refusal is all that is left here.** This used to carry a `published` verdict
 * too, for the pass that judged a steward's drafts. `#1032` retired that pass:
 * the only way an entry becomes `joinable` is somebody writing the route onto it,
 * which is {@link dressProviderRecipe}, and a status move with no steps behind it
 * would fail `provider_recipes_joinable_has_steps` anyway. What was two verdicts
 * about one row is now one act that publishes and one that refuses.
 *
 * **Not `writeProviderRecipe`**, which replaces a row from the top. That is right
 * for *this provider changed its form* and wrong for *this entry was refused*: a
 * refusal that went through it would have to restate every field it did not mean
 * to change, and restating a field is how a verdict quietly reverts an edit
 * somebody made in between.
 *
 * **Guarded on `measured` in the `where`, not by the caller.** The refusal was
 * decided about a measured entry; if it was published or refused in the meantime,
 * it is not that entry any more and this must do nothing. That makes the ordinary
 * race resolve to whoever got there first, exactly as `recordAtlasModeration`
 * resolves it.
 *
 * **Refusing empties the entry, because the table requires it.**
 * `provider_recipes_unjoinable_is_empty` will not hold a refused row with steps
 * or a proof, so refusing is not a label over a walk — it discards it, and
 * `reaches` and `provesTask` go with it since neither survives a null `proves`.
 * Refuse only for a red line: everything fixable stays measured, where the
 * provider's briefing still carries what citizens found. What is kept is
 * `walked_recipe`, a separate column and unaffected — so the walk that produced a
 * refused entry is still readable.
 *
 * Returns whether a row moved, so a caller can tell a refusal that landed from one
 * that arrived late.
 */
export async function publishProviderRecipe(
  db: Handle,
  entry: {
    readonly kind: AccountKind
    readonly provider: string
    readonly verdict: 'refused'
    readonly refusal: string
  },
): Promise<boolean> {
  const moved = await db
    .update(providerRecipes)
    .set({
      status: 'refused',
      refusal: entry.refusal,
      /** The four the constraints require of an entry that is not joinable. */
      steps: [],
      proves: null,
      provesTask: null,
      reaches: null,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(providerRecipes.kind, entry.kind),
        eq(providerRecipes.provider, AccountProviderSchema.parse(entry.provider)),
        eq(providerRecipes.status, 'measured'),
      ),
    )
    .returning({ id: providerRecipes.id })

  return moved.length > 0
}

/**
 * Write the wording onto a measured entry, so it can be published at all
 * (`#857`).
 *
 * **The write that was missing.** A walk records the shape of what happened and
 * `#517` reserves the sentence a recipe publishes to the Colony, so every entry a
 * walk produced arrived wordless and `whyNotPublishable` held it — correctly, and
 * forever, because nothing anywhere could supply the missing sentence. The screen
 * offered a Publish button that would not fire and a Refuse button that empties
 * the row. This is the third thing to do with such an entry.
 *
 * **A measured entry carries no route at all since `#1032`**, so this is now the
 * only way steps ever reach the catalogue: what a citizen walked is published in
 * that provider's briefing under its own author, and what the Colony recommends
 * is written here, by the Colony, or not at all.
 *
 * **Guarded on `measured` in the `where`, for the reason `publishProviderRecipe`
 * is.** Dressing an entry that has since been published would overwrite a
 * live recipe from a form somebody opened an hour ago.
 *
 * **It moves the status, and since `#1032` that is the point.** Dressing used to
 * write words and leave the deciding to a pass that judged drafts; that pass is
 * gone, and there is nothing behind this act to decide anything afterwards. A
 * `measured` row may hold no steps at all — `provider_recipes_unjoinable_is_empty`
 * refuses them — so writing a route onto one and leaving it measured is not a
 * state the table has. Writing the route *is* publishing it, by whoever wrote it,
 * under their own name.
 *
 * Steps arrive already checked by `routeFromWording` — this writes them.
 */
export async function dressProviderRecipe(
  db: Handle,
  entry: {
    readonly kind: AccountKind
    readonly provider: string
    readonly steps: readonly RecipeStep[]
    readonly proves: AccountProofMethod
    /** Only ever set beside `proves: 'rung'`; the write schema refines that. */
    readonly provesTask?: string | undefined
  },
): Promise<boolean> {
  const dressed = await db
    .update(providerRecipes)
    .set({
      status: 'joinable',
      steps: [...entry.steps],
      proves: entry.proves,
      provesTask: entry.proves === 'rung' ? (entry.provesTask ?? null) : null,
      refusal: null,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(providerRecipes.kind, entry.kind),
        eq(providerRecipes.provider, AccountProviderSchema.parse(entry.provider)),
        eq(providerRecipes.status, 'measured'),
      ),
    )
    .returning({ id: providerRecipes.id })

  return dressed.length > 0
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
