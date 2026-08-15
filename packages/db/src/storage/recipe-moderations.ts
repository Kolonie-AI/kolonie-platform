import { createHash } from 'node:crypto'
import { and, asc, desc, eq, isNotNull, sql } from 'drizzle-orm'
import {
  RECIPE_DRAFT_EXPIRY_DAYS,
  RecipeModerationStagesSchema,
  recipeDraftExpired,
  whyRecipeHeld,
  type AtlasCategory,
  type ProviderRecipe,
  type RecipeModerationStages,
  type RecipeVerdict,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { accountWalks } from '../schema/account-walks.js'
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
 * What the walk that proposed this draft wrote about the path (`#941`).
 *
 * **Read through `proposed_at` and not through kind and provider.** The walk that
 * proposed the entry is the one whose material describes these steps; the latest
 * walk at the same provider may be somebody else's, months later, against a
 * different form. Getting that wrong would attach one agent's narrative to
 * another agent's steps, which is the precise failure the citation guard in the
 * wording stage exists to make impossible.
 *
 * Absent where the entry did not come from a walk — a seeded listing, a curated
 * row — which is the ordinary answer for most of the catalogue.
 */
export async function proposingWalkNarrative(
  db: Database,
  recipeId: string,
): Promise<
  | {
      readonly did: string | null
      readonly broke: string | null
      readonly changed: string | null
    }
  | undefined
> {
  const [entry] = await db
    .select({ kind: providerRecipes.kind, provider: providerRecipes.provider })
    .from(providerRecipes)
    .where(eq(providerRecipes.id, recipeId))
    .limit(1)

  if (entry === undefined) return undefined

  const [walk] = await db
    .select({
      did: accountWalks.did,
      broke: accountWalks.broke,
      changed: accountWalks.changed,
    })
    .from(accountWalks)
    .where(
      and(
        eq(accountWalks.kind, entry.kind),
        eq(accountWalks.provider, entry.provider),
        isNotNull(accountWalks.proposedAt),
      ),
    )
    /** The most recent proposal, which is the one whose steps are on the row. */
    .orderBy(desc(accountWalks.proposedAt))
    .limit(1)

  return walk
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

/** One draft the window ran out on, with what it was last held on. */
export interface ExpiredRecipeDraft {
  readonly kind: string
  readonly provider: string
  readonly reason: string
}

/**
 * Withdraw the drafts nobody could complete, and say why (`#941`).
 *
 * ## What it selects, and what it deliberately does not
 *
 * A draft qualifies on two facts together: **the pass has judged it and held it**,
 * and **nothing has touched the row for {@link RECIPE_DRAFT_EXPIRY_DAYS} days**.
 * The first is what makes this a decision rather than a sweep — a draft written an
 * hour ago and never judged has not failed at anything, and one no verdict exists
 * for is one the runner has not reached. The second is measured on `updated_at`,
 * so a steward's edit, a re-walk or a fresh verdict each buy another fortnight.
 *
 * **`retired` and not `refused`.** Refusing empties the row — `steps`, `proves`,
 * `reaches` and `provesTask` all go, by the table's own constraint — and says the
 * provider has no honest route. Neither is true here: what ran out is the
 * Colony's patience with one draft, and the steps are what a later walk starts
 * from. `retired` keeps them and reads through `kolonie.accounts.walk-status` as
 * `withdrawn`, with the reason beside it.
 *
 * **One statement per row rather than one for all of them**, because each carries
 * its own reason. The batch is small by construction: it is the drafts that went
 * a fortnight without anybody, and if it is ever large that is the finding.
 */
export async function expireStalledRecipeDrafts(
  db: Database,
  options: { readonly limit?: number } = {},
): Promise<readonly ExpiredRecipeDraft[]> {
  const held = db
    .select({
      recipeId: recipeModerations.recipeId,
      stages: recipeModerations.stages,
      rank: sql<number>`row_number() over (
        partition by ${recipeModerations.recipeId}
        order by ${recipeModerations.createdAt} desc
      )`.as('rank'),
      decision: recipeModerations.decision,
    })
    .from(recipeModerations)
    .as('held')

  const candidates = await db
    .select({
      id: providerRecipes.id,
      kind: providerRecipes.kind,
      provider: providerRecipes.provider,
      stages: held.stages,
    })
    .from(providerRecipes)
    .innerJoin(held, eq(held.recipeId, providerRecipes.id))
    .where(
      and(
        eq(providerRecipes.status, 'draft'),
        eq(held.rank, 1),
        eq(held.decision, 'held'),
        sql`${providerRecipes.updatedAt} < now() - ${sql.raw(`interval '${String(RECIPE_DRAFT_EXPIRY_DAYS)} days'`)}`,
      ),
    )
    .limit(options.limit ?? 50)

  const expired: ExpiredRecipeDraft[] = []

  for (const candidate of candidates) {
    const parsed = RecipeModerationStagesSchema.safeParse(candidate.stages)
    const reason = recipeDraftExpired(parsed.success ? whyRecipeHeld(parsed.data) : undefined)

    const moved = await db
      .update(providerRecipes)
      .set({
        status: 'retired',
        retiredAt: sql`now()`,
        retiredReason: reason,
        updatedAt: sql`now()`,
      })
      /** Still a draft, for the reason every other verdict here guards on it. */
      .where(and(eq(providerRecipes.id, candidate.id), eq(providerRecipes.status, 'draft')))
      .returning({ id: providerRecipes.id })

    if (moved.length > 0) {
      expired.push({ kind: candidate.kind, provider: candidate.provider, reason })
    }
  }

  return expired
}

/**
 * What has been withdrawn unpublished lately, and what each one was held on
 * (`#946`).
 *
 * ## Why this is the thing worth watching, and the steward queue was not
 *
 * The alarm this feeds used to count **drafts waiting for a steward**. Once
 * `#813` gave the pass the decision and `#941` gave it a fortnight, a draft does
 * not wait: it publishes, or the window runs out and it is withdrawn with the
 * reason it was last held on. A watcher on the old condition would fire on a
 * queue that no longer exists, and the issue it filed would name nobody who could
 * act.
 *
 * **What replaces it is a rate rather than a backlog.** One withdrawal is an
 * ordinary outcome — a walk that recorded nothing usable, a provider that turned
 * out to have no honest route. Several in a week is the Colony refusing its own
 * incoming material, and the two causes worth telling apart are both readable in
 * {@link WithdrawnDraftQueue.drafts}: a rewrite rule too tight to clear anything,
 * or walkers recording steps with nothing in them.
 *
 * ## What identifies one, without a column for it
 *
 * `retired` **and** a latest verdict of `held`. Expiry writes no moderation row,
 * so the hold it gave up on is still the last thing said about the entry — while
 * anything a steward retired by hand was either published first or never judged
 * at all. That is a fingerprint rather than a flag, and it costs no migration.
 *
 * `withinDays` is what makes it close itself: a withdrawal is an event, and an
 * alarm counting every one ever recorded would never fall silent again.
 */
export interface WithdrawnDraftQueue {
  /** How many were withdrawn inside the window. Zero means there is no condition. */
  readonly count: number
  /**
   * The withdrawals themselves, oldest first, capped at a readable number for the
   * reason the alarm renders them into a table a person reads. `count` is the
   * honest total either way.
   */
  readonly drafts: readonly {
    readonly kind: string
    readonly provider: string
    readonly category: string
    /** When the window ran out on it. */
    readonly since: string
    /**
     * What the last verdict held it on, or `null` where none recorded a reason.
     *
     * **This is the diagnostic and not decoration.** Four withdrawals reading
     * *the sentence is still the Colony's to write* is a rewrite rule that clears
     * nothing; four reading *step 3 recorded no instruction* is a walker problem,
     * and the fix for one is no help against the other.
     */
    readonly heldOn: string | null
  }[]
  /** The earliest withdrawal still inside the window, or `null` when there were none. */
  readonly oldestSince: string | null
}

/** How many rows the alarm prints. The count is what says how many there are. */
const WITHDRAWN_DRAFT_ROWS = 20

export async function withdrawnRecipeDrafts(
  db: Database,
  withinDays: number,
): Promise<WithdrawnDraftQueue> {
  const held = db
    .select({
      recipeId: recipeModerations.recipeId,
      stages: recipeModerations.stages,
      rank: sql<number>`row_number() over (
        partition by ${recipeModerations.recipeId}
        order by ${recipeModerations.createdAt} desc
      )`.as('rank'),
      decision: recipeModerations.decision,
    })
    .from(recipeModerations)
    .as('held')

  const withdrawn = and(
    eq(providerRecipes.status, 'retired'),
    eq(held.rank, 1),
    eq(held.decision, 'held'),
    sql`${providerRecipes.retiredAt} >= now() - make_interval(days => ${withinDays})`,
  )

  const [totals] = await db
    .select({
      count: sql<number>`count(*)::int`,
      oldest: sql<string>`min(${providerRecipes.retiredAt})`,
    })
    .from(providerRecipes)
    .innerJoin(held, eq(held.recipeId, providerRecipes.id))
    .where(withdrawn)

  const rows = await db
    .select({
      kind: providerRecipes.kind,
      provider: providerRecipes.provider,
      category: providerRecipes.category,
      since: providerRecipes.retiredAt,
      stages: held.stages,
    })
    .from(providerRecipes)
    .innerJoin(held, eq(held.recipeId, providerRecipes.id))
    .where(withdrawn)
    .orderBy(asc(providerRecipes.retiredAt))
    .limit(WITHDRAWN_DRAFT_ROWS)

  return {
    count: totals?.count ?? 0,
    drafts: rows.map((row) => {
      const parsed = RecipeModerationStagesSchema.safeParse(row.stages)

      return {
        kind: row.kind,
        provider: row.provider,
        category: row.category,
        since: String(row.since),
        heldOn: (parsed.success ? whyRecipeHeld(parsed.data) : undefined) ?? null,
      }
    }),
    /** `min()` over an empty set is null, which is the no-condition answer rather than a gap. */
    oldestSince: totals?.oldest == null ? null : String(totals.oldest),
  }
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
