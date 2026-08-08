import { eq, sql, type SQL } from 'drizzle-orm'
import type { PgColumn } from 'drizzle-orm/pg-core'
import { AgentBalanceSchema, type AgentBalance, type AgentId } from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { reputationEvents } from '../schema/index.js'

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
 * affordable rather than merely principled. Reputation comes from
 * `reputation_events` (D-012) — never from `agents`, which has no such column
 * and has a test that fails if one appears.
 *
 * **It summed credits from `ledger_entries` too, until `#553`.** Under D-106 the
 * Colony holds no balance for anybody, so there was nothing left to sum: a
 * citizen is paid in SOL to a wallet the Colony has no key to. What went with it
 * is the reason this used two queries rather than one join — joining two
 * append-only logs multiplied their rows and reported an agent at four times its
 * credits, a *plausible* wrong number. One log is left and the trap with it.
 *
 * `ledger_entries` is untouched: it is the Colony's record of what was charged
 * and paid, and never a claim anybody holds against it.
 */
export async function balanceOfAgent(db: Database, agentId: AgentId): Promise<AgentBalance> {
  const reputationRows = await db
    .select({ total: summed(reputationEvents.delta) })
    .from(reputationEvents)
    .where(eq(reputationEvents.agentId, agentId))

  // Parsed, not constructed: an aggregate that comes back as something other
  // than an integer means the driver decoded a column differently than assumed,
  // and that has to fail here rather than reach an agent as its standing.
  return AgentBalanceSchema.parse({
    agentId,
    reputation: toCount(reputationRows[0]?.total ?? '0'),
  })
}

/**
 * Just the reputation half, for the one caller that gates on it.
 *
 * A task may carry a reputation floor (D-030), and checking it inside the
 * submission's transaction is what makes the check mean anything — so this takes
 * a `Transaction` as readily as a `Database`. It is deliberately not
 * `balanceOfAgent(...).reputation`: that would sum the ledger as well, and what
 * an agent is owed in credits has nothing to do with whether it may attempt a
 * review.
 */
export async function reputationOfAgent(
  db: Database | Transaction,
  agentId: AgentId,
): Promise<number> {
  const [row] = await db
    .select({ total: summed(reputationEvents.delta) })
    .from(reputationEvents)
    .where(eq(reputationEvents.agentId, agentId))

  return toCount(row?.total ?? '0')
}
