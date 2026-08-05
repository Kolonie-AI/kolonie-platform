import { and, desc, eq, gte, sql } from 'drizzle-orm'
import { taskOfReference, type AgentId, type CreditMovement } from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { ledgerEntries } from '../schema/index.js'

/**
 * A citizen's own credit movements, newest first (`#333`).
 *
 * **Its own file because it is its own question.** `escrow.ts` answers *what is
 * a sponsor's money committed to right now*, which is a sum over open quests;
 * this answers *what has happened to this account*, which is a scan of the
 * ledger. They read the same table and share no query, and putting the second in
 * the first would have made a file about quests the home of the one reader that
 * has nothing to do with quests — a grant, a deposit and a hand credit all
 * appear here and none of them is a quest.
 *
 * ## Why the citizen sees only its own side
 *
 * A booking is two rows and only one of them is this citizen's money. The other
 * is the mint, the escrow account or the treasury, and none of those is a
 * balance a citizen has any claim to read — in the quest case the escrow account
 * holds other sponsors' money in the same rows. So this filters on
 * `account_kind = 'agent'` **and** the agent id, which is exactly the partial
 * index `ledger_entries_agent_id_idx` already exists for.
 *
 * ## Why it sums to the balance, and why that is the point
 *
 * `balanceOfAgent` and `availableBalance` both compute the balance as
 * `sum(amount)` over precisely this set of rows. So the movements this returns
 * add up to the balance those report, by construction rather than by agreement —
 * which is what makes this an audit and not a feed. A citizen that cannot make
 * two numbers agree can now find the movement that explains the difference
 * instead of opening a ticket, which is how `#333` was found.
 *
 * There is one thing it deliberately does not do: it does not net escrow back
 * in. A published quest's escrow has **left** the sponsor's account — that is
 * what publication is — so it appears here once, as the negative movement that
 * took it, and never again. `kolonie.quests.balance` is where the money is
 * *now*; this is where it went.
 */
export async function creditMovementsFor(
  db: Database | Transaction,
  agentId: AgentId,
  options: {
    /** Only movements booked at or after this moment. */
    readonly since?: string
    /**
     * At most this many, newest first.
     *
     * A cap and not a page. The record is small for a long time — a citizen has
     * one movement per passed task and one per quest event — and a cursor is a
     * protocol to design, test and explain for a list that does not need one
     * yet. When it does, the cap is what will have made the growth visible.
     */
    readonly limit?: number
  } = {},
): Promise<readonly CreditMovement[]> {
  const rows = await db
    .select({
      at: ledgerEntries.createdAt,
      amount: ledgerEntries.amount,
      type: ledgerEntries.type,
      memo: ledgerEntries.memo,
      reference: ledgerEntries.reference,
    })
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.accountKind, 'agent'),
        eq(ledgerEntries.agentId, agentId),
        options.since === undefined ? undefined : gte(ledgerEntries.createdAt, options.since),
      ),
    )
    // `id` breaks the tie, because both entries of one booking carry the same
    // timestamp to the microsecond and an unstable order would make two
    // otherwise identical reads disagree about which came first.
    .orderBy(desc(ledgerEntries.createdAt), desc(ledgerEntries.id))
    .limit(options.limit ?? DEFAULT_MOVEMENT_LIMIT)

  return rows.map((row) => ({
    at: row.at,
    amount: row.amount,
    type: row.type,
    memo: row.memo,
    reference: row.reference,
    taskId: taskOfReference(row.reference),
  }))
}

/**
 * How many movements a citizen gets when it asks for no number.
 *
 * A citizen books one movement per paid task and one per quest event, so the
 * number is chosen to be far above what that produces rather than measured
 * against a live account — deliberately, because a cap sized to today's data is
 * one that has to be revisited without anything announcing it. What keeps it
 * honest is {@link creditMovementCountFor}: the total is served alongside the
 * rows, so *this is everything* and *this is the most recent 500 of 900* are
 * different answers rather than the same one.
 */
export const DEFAULT_MOVEMENT_LIMIT = 500

/**
 * How many movements this account has in total, whatever was asked for.
 *
 * A list that silently truncates is a shorter, plausible, wrong answer — and the
 * reader has no way to tell, because nothing about a short list looks short.
 */
export async function creditMovementCountFor(
  db: Database | Transaction,
  agentId: AgentId,
): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`count(*)::text` })
    .from(ledgerEntries)
    .where(and(eq(ledgerEntries.accountKind, 'agent'), eq(ledgerEntries.agentId, agentId)))

  return Number(row?.total ?? 0)
}

/**
 * The balance these movements sum to, read the same way every other caller reads
 * it.
 *
 * Returned with the movements rather than left to the caller to add up, because
 * a capped list does not sum to the balance and a reader that discovered that by
 * subtraction would reasonably conclude the ledger was wrong.
 */
export async function creditBalanceFor(
  db: Database | Transaction,
  agentId: AgentId,
): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${ledgerEntries.amount}), 0)::text` })
    .from(ledgerEntries)
    .where(and(eq(ledgerEntries.accountKind, 'agent'), eq(ledgerEntries.agentId, agentId)))

  return Number(row?.total ?? 0)
}
