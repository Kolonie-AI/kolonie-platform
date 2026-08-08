import { and, asc, eq, isNotNull, sql } from 'drizzle-orm'
import type { AgentId, Wish, WishAuthor } from '@kolonie-ai/core'
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
