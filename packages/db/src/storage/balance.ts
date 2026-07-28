import { and, eq, sql, type SQL } from 'drizzle-orm'
import type { PgColumn } from 'drizzle-orm/pg-core'
import { AgentBalanceSchema, type AgentBalance, type AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { ledgerEntries, reputationEvents } from '../schema/index.js'

/**
 * `sum()` of the column, as text, never null.
 *
 * Two conversions, each load-bearing. **`coalesce`**, because `sum()` over an
 * empty set is `NULL` and an agent that has earned nothing is the common case —
 * every agent is in it for its first minutes in the Colony. **`::text`**,
 * because Postgres sums `bigint` into `numeric`, and going through the string
 * form means a value too large for a JavaScript number fails loudly below
 * instead of arriving at an agent quietly rounded.
 */
const summed = (column: PgColumn): SQL<string> => sql<string>`coalesce(sum(${column}), 0)::text`

/** Turn the aggregate back into a number, or refuse. */
function toCount(raw: string): number {
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${raw} is outside the range a JavaScript number represents exactly`)
  }
  return value
}

/**
 * An agent's economy, summed from the two append-only logs that own it.
 *
 * D-002: there is no balance column, and this function is what makes that
 * affordable rather than merely principled. Coins come from `ledger_entries`,
 * reputation from `reputation_events` (D-012) — never from `agents`, which has
 * neither column and has a test that fails if either appears.
 *
 * Two queries rather than one join. Joining two independent append-only logs
 * multiplies their rows before summing them: an agent with 3 ledger entries and
 * 4 reputation events would produce 12 rows and be reported at four times its
 * coins. That bug returns a *plausible* number, which is why the shape that
 * cannot express it is worth a second round trip.
 */
export async function balanceOfAgent(db: Database, agentId: AgentId): Promise<AgentBalance> {
  const [coinRows, reputationRows] = await Promise.all([
    db
      .select({ total: summed(ledgerEntries.amount) })
      .from(ledgerEntries)
      // `account_kind = 'agent'` is implied by a non-null `agent_id` under
      // `ledger_entries_account_exclusive`, and stated anyway: this query decides
      // what the Colony believes it owes, and it should be readable without
      // holding a check constraint in mind.
      .where(and(eq(ledgerEntries.accountKind, 'agent'), eq(ledgerEntries.agentId, agentId))),
    db
      .select({ total: summed(reputationEvents.delta) })
      .from(reputationEvents)
      .where(eq(reputationEvents.agentId, agentId)),
  ])

  // Parsed, not constructed: an aggregate that comes back as something other
  // than an integer means the driver decoded a column differently than assumed,
  // and that has to fail here rather than reach an agent as a balance.
  return AgentBalanceSchema.parse({
    agentId,
    coins: toCount(coinRows[0]?.total ?? '0'),
    reputation: toCount(reputationRows[0]?.total ?? '0'),
  })
}
