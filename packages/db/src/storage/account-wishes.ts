import { and, asc, eq, isNotNull, sql } from 'drizzle-orm'
import {
  PERMISSION_AGGREGATE_FLOOR,
  type AgentId,
  type Wish,
  type WishAuthor,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { accountWishes } from '../schema/index.js'

/**
 * The shared account list, in storage (#527).
 *
 * **Every function here is keyed on one agent**, and none of them takes a list
 * of agents. The list is a plan between one citizen and one operator, and a
 * query that could span several would be the first half of a surface that ranks
 * agents by what they are missing — which is the thing `#512` refuses and `#534`
 * is careful to answer only as counts.
 */

/** Put something on the list, or leave the row that is already there. */
export type AddWishOutcome =
  | { readonly outcome: 'added'; readonly wish: Wish }
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

  if (existing !== undefined) return { outcome: 'already-listed', wish: asWish(existing) }

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
    id: row.id,
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
