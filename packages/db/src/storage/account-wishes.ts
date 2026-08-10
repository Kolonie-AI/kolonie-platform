import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import {
  PERMISSION_AGGREGATE_FLOOR,
  RecipeOperatorGuessSchema,
  RecipeStatusSchema,
  RecipeStepSchema,
  atlasEntryOperatorNeed,
  atlasEntryStatus,
  operatorNeed,
  type AgentId,
  type RecipeOperatorNeed,
  type RecipeStatus,
  type RecipeStep,
  type Wish,
  type WishAuthor,
  type WishId,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { accounts, accountWishes, providerRecipes } from '../schema/index.js'

/**
 * The shared account list, in storage (#527).
 *
 * **Every function here is keyed on one agent**, and none of them takes a list
 * of agents. The list is a plan between one citizen and one operator, and a
 * query that could span several would be the first half of a surface that ranks
 * agents by what they are missing — which is the thing `#512` refuses and `#534`
 * is careful to answer only as counts.
 */

/** Put something on the list, or add citizen context to the row already there. */
export type AddWishOutcome =
  | { readonly outcome: 'added'; readonly wish: Wish }
  | { readonly outcome: 'context-added'; readonly wish: Wish }
  /**
   * The same provider is already on this agent's list.
   *
   * **Returned rather than refused**, and the existing row comes back. A citizen
   * and its operator can want the same thing, and the honest answer to *add
   * trello* when trello is already there is *it is on the list* — not an error,
   * and not a second row.
   */
  | { readonly outcome: 'already-listed'; readonly wish: Wish }

export async function addWish(
  db: Database | Transaction,
  input: {
    readonly agentId: AgentId
    readonly provider: string
    readonly author: WishAuthor
    readonly noticedWhile?: string | undefined
  },
): Promise<AddWishOutcome> {
  const [existing] = await db
    .select()
    .from(accountWishes)
    .where(
      and(eq(accountWishes.agentId, input.agentId), eq(accountWishes.provider, input.provider)),
    )
    .limit(1)

  if (existing !== undefined) {
    if (
      input.author === 'citizen' &&
      input.noticedWhile !== undefined &&
      existing.noticedWhile === null
    ) {
      const [updated] = await db
        .update(accountWishes)
        .set({ noticedWhile: input.noticedWhile })
        .where(and(eq(accountWishes.id, existing.id), isNull(accountWishes.noticedWhile)))
        .returning()

      if (updated !== undefined) return { outcome: 'context-added', wish: asWish(updated) }
    }

    return { outcome: 'already-listed', wish: asWish(existing) }
  }

  const [row] = await db
    .insert(accountWishes)
    .values({
      agentId: input.agentId,
      provider: input.provider,
      author: input.author,
      // Only a citizen has something it was doing. The table refuses the other
      // case as well, so this is belt and braces on a rule that matters.
      noticedWhile: input.author === 'citizen' ? (input.noticedWhile ?? null) : null,
    })
    .returning()

  if (row === undefined) throw new Error('account_wishes insert returned no row')

  return { outcome: 'added', wish: asWish(row) }
}

/** The whole list for one agent, oldest first. */
export async function wishesFor(
  db: Database | Transaction,
  agentId: AgentId,
): Promise<readonly Wish[]> {
  const rows = await db
    .select()
    .from(accountWishes)
    .where(eq(accountWishes.agentId, agentId))
    .orderBy(asc(accountWishes.addedAt))

  return rows.map(asWish)
}

/**
 * The operator says yes to one item.
 *
 * **Idempotent, and it never moves the date backwards or forwards.** An operator
 * clicking twice has said the same thing twice; rewriting `wanted_at` on the
 * second click would make the record say the decision was taken later than it
 * was.
 */
export async function markWanted(
  db: Database | Transaction,
  agentId: AgentId,
  provider: string,
): Promise<boolean> {
  const updated = await db
    .update(accountWishes)
    .set({ wantedAt: sql`now()` })
    .where(
      and(
        eq(accountWishes.agentId, agentId),
        eq(accountWishes.provider, provider),
        // Only a row that has not been decided. See above.
        sql`${accountWishes.wantedAt} is null`,
      ),
    )
    .returning({ id: accountWishes.id })

  return updated.length > 0
}

/**
 * Take something off the list.
 *
 * **The only way an operator withdraws a yes**, which is why there is no
 * *unwanted* state beside {@link markWanted}. A third value would be something
 * every reader has to handle for a case a delete already covers, and it would
 * leave a row saying *this was refused* about a provider somebody may simply
 * have changed their mind about.
 */
export async function removeWish(
  db: Database | Transaction,
  agentId: AgentId,
  provider: string,
): Promise<boolean> {
  const removed = await db
    .delete(accountWishes)
    .where(and(eq(accountWishes.agentId, agentId), eq(accountWishes.provider, provider)))
    .returning({ id: accountWishes.id })

  return removed.length > 0
}

/**
 * Whether this agent may spend its operator's attention on this provider.
 *
 * **The gate `#527` asks for, and it is narrow on purpose.** It answers *no*
 * only for a provider that is **on this agent's list and not marked wanted** — a
 * provider nobody has written down is not gated at all, because the list is a
 * plan and not a permission system. Making it one would mean an agent could make
 * its own work harder by recording that it needs something.
 */
export async function wishBlocksHandoff(
  db: Database | Transaction,
  agentId: AgentId,
  provider: string,
): Promise<boolean> {
  const [row] = await db
    .select({ wantedAt: accountWishes.wantedAt })
    .from(accountWishes)
    .where(and(eq(accountWishes.agentId, agentId), eq(accountWishes.provider, provider)))
    .limit(1)

  return row !== undefined && row.wantedAt === null
}

/**
 * What the operator has said yes to and the citizen has not got (`#581`).
 *
 * **This is what `wantedWishesFor` was for and never had a caller for.** That
 * function was exported, tested, and called by nothing in the platform — so an
 * operator pressed *mark as wanted*, a timestamp was written, and the only live
 * effect was that one MCP call stopped refusing. The wake-up digest reads this,
 * which is how the mark reaches the agent at all.
 *
 * **Marked, and not held.** The two filters are the whole of the query and each
 * is a rule: an unmarked entry is one the operator is still considering, and
 * `#527` reserves the mark as the one gesture that means *you may act on this*;
 * a provider the citizen already holds an account at is a mark that has been
 * satisfied, and repeating it every waking would be the digest nagging about
 * finished work.
 *
 * **Left-joined to the catalogue rather than filtered by it.** A provider with
 * no recipe is exactly the signal `#534` is built on, and dropping it here would
 * make the citizen unable to see what its operator asked for — so the row comes
 * back saying *nothing is written for this yet*, which is a true answer it can
 * act on by walking it and filing a report.
 */
export async function wantedAccountsFor(
  db: Database | Transaction,
  agentId: AgentId,
): Promise<
  readonly {
    readonly provider: string
    readonly wantedAt: string
    readonly status: RecipeStatus | null
    readonly operatorNeed: RecipeOperatorNeed | null
    /** Whether that answer rests on a guess rather than a walked step (`#589`). */
    readonly operatorNeedIsGuess: boolean
  }[]
> {
  /**
   * **A left join and `is null`, rather than a `not exists` subquery.**
   * `bare-identifiers.test.ts` caught the first version of this: a subquery
   * naming columns of two tables is `#183`'s defect or one edit away from it,
   * and the guard is right that text cannot tell which. A join expresses the
   * same thing with no raw SQL at all, so there is nothing to render bare.
   *
   * It cannot multiply rows either: only the wishes with no matching account
   * survive the filter, and those matched nothing to multiply by.
   */
  const rows = await db
    .select({ provider: accountWishes.provider, wantedAt: accountWishes.wantedAt })
    .from(accountWishes)
    .leftJoin(
      accounts,
      and(
        eq(accounts.agentId, accountWishes.agentId),
        eq(accounts.provider, accountWishes.provider),
      ),
    )
    .where(
      and(
        eq(accountWishes.agentId, agentId),
        isNotNull(accountWishes.wantedAt),
        /**
         * **Held means an account row naming this provider, whatever its kind.**
         * The wish names a provider and the register names a provider, so that
         * is the comparison both sides can make — a citizen holding a mailbox at
         * a provider it was also asked to get a domain from is an edge this
         * treats as satisfied rather than inventing a kind for a wish to carry.
         */
        isNull(accounts.id),
      ),
    )
    .orderBy(asc(accountWishes.wantedAt))

  if (rows.length === 0) return []

  /**
   * The catalogue's answer for those providers, in one more query and grouped
   * here.
   *
   * **Grouped by the same functions the Atlas pages use** — `atlasEntryStatus`
   * and `atlasEntryOperatorNeed` — because a provider can carry a row per kind
   * and the digest must not answer differently from the page the citizen will
   * open next. Joining the catalogue into the query above would also have
   * multiplied a wish by its provider's kinds, which is the quieter half of why
   * this is two reads.
   */
  const catalogue = await db
    .select({
      provider: providerRecipes.provider,
      status: providerRecipes.status,
      operatorGuess: providerRecipes.operatorGuess,
      steps: providerRecipes.steps,
    })
    .from(providerRecipes)
    .where(
      inArray(
        providerRecipes.provider,
        rows.map((row) => row.provider),
      ),
    )

  const byProvider = new Map<
    string,
    { status: RecipeStatus; operatorNeed: RecipeOperatorNeed; operatorNeedIsGuess: boolean }[]
  >()
  for (const row of catalogue) {
    const held = byProvider.get(row.provider) ?? []
    const need = operatorNeed({
      // Parsed rather than trusted, exactly as `toRecipe` does it: `jsonb`
      // accepts whatever was written, and a hand-inserted row is the case the
      // catalogue exists to allow.
      steps: (row.steps ?? []).map((step: RecipeStep) => RecipeStepSchema.parse(step)),
      operatorGuess:
        row.operatorGuess === null ? null : RecipeOperatorGuessSchema.parse(row.operatorGuess),
    })

    held.push({
      status: RecipeStatusSchema.parse(row.status),
      operatorNeed: need.need,
      operatorNeedIsGuess: need.isGuess,
    })
    byProvider.set(row.provider, held)
  }

  return rows.map((row) => {
    const held = byProvider.get(row.provider)

    return {
      provider: row.provider,
      wantedAt: row.wantedAt as string,
      /**
       * `null` where the catalogue holds nothing at all, which is **not**
       * `unwritten`: the first says the Colony has never heard of this provider
       * and the second that it lists it and nobody has walked it. The free-text
       * field takes anything, so both arrive here.
       */
      status: held === undefined ? null : atlasEntryStatus(held),
      operatorNeed: held === undefined ? null : atlasEntryOperatorNeed(held).need,
      operatorNeedIsGuess: held !== undefined && atlasEntryOperatorNeed(held).isGuess,
    }
  })
}

/** Everything this agent's operator has said yes to. */
export async function wantedWishesFor(
  db: Database | Transaction,
  agentId: AgentId,
): Promise<readonly Wish[]> {
  const rows = await db
    .select()
    .from(accountWishes)
    .where(and(eq(accountWishes.agentId, agentId), isNotNull(accountWishes.wantedAt)))
    .orderBy(asc(accountWishes.addedAt))

  return rows.map(asWish)
}

function asWish(row: typeof accountWishes.$inferSelect): Wish {
  return {
    id: row.id as WishId,
    provider: row.provider,
    author: row.author as WishAuthor,
    noticedWhile: row.noticedWhile,
    wantedAt: row.wantedAt,
    addedAt: row.addedAt,
  }
}

/** One provider and how many citizens have asked for it. */
export interface WantedProviderCount {
  readonly provider: string
  readonly citizens: number
}

/**
 * Which providers agents want, and how many want them (#534).
 *
 * ## Only what a citizen wrote
 *
 * `#534` is about *"what a population of autonomous agents is trying to reach
 * and cannot"*. An operator's entry is a fact about a person's plan for one
 * agent, which is a different claim and a much weaker one — a hundred operators
 * adding the same provider would say something about a conversation somebody had
 * on a forum, not about what agents hit.
 *
 * So the count is `author = 'citizen'`, in SQL, and a caller cannot ask for the
 * other.
 *
 * ## The floor, and there are no combinations to apply it to
 *
 * `PERMISSION_AGGREGATE_FLOOR` suppresses a thin row in a `having` clause rather
 * than in a caller, for the reason `permissionBlockCounts` gives one file over:
 * a filter in TypeScript is one a second caller could skip. Three agents wanting
 * something is not a market signal, it is three identifiable agents.
 *
 * `#534` asks that *"the floor applies, including to any combination"*. **There
 * are no combinations here**, which is the strongest available form of that: one
 * grouping, one dimension, no filters, no time window and no way to narrow. A
 * caller that could ask *who wanted Figma in the last week* would be asking a
 * question whose answer is a smaller group, and small groups identify agents.
 *
 * ## What it is, wherever it is shown
 *
 * **Interest and never availability.** An agent that asked for a Figma account
 * has not agreed to do Figma work — the same line `#524` draws for holdings, for
 * the same reason. Nothing in this function can enforce that; the surfaces that
 * render it say so, and `#534` requires them to.
 */
export async function wantedProviderCounts(db: Database): Promise<readonly WantedProviderCount[]> {
  const floor = sql.raw(String(PERMISSION_AGGREGATE_FLOOR))

  const rows = await db.execute<{ provider: string; citizens: string }>(sql`
    select w.provider as provider, count(distinct w.agent_id)::text as citizens
      from account_wishes w
     where w.author = 'citizen'
     group by w.provider
    having count(distinct w.agent_id) >= ${floor}
     order by count(distinct w.agent_id) desc, w.provider
  `)

  return rows.map((row) => ({ provider: row.provider, citizens: Number(row.citizens) }))
}
