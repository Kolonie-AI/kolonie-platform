import { and, eq, isNotNull, sql } from 'drizzle-orm'
import type { AgentId, Timestamp } from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { operatorAddresses } from '../schema/index.js'
import { clearSetAsidesFor } from './set-asides.js'
import { toTimestamp } from './rows.js'

/**
 * How long a confirmed address stands before it should be looked at again.
 *
 * **A year, and deliberately long.** This is a standing claim about a person, and
 * the cost of re-checking it is a mail to somebody who owes the Colony nothing.
 * Short enough to be worth having, long enough that no operator is ever asked
 * twice about the same agent in a year.
 */
export const OPERATOR_ADDRESS_RECHECK_DAYS = 365

/** An operator address as its citizen reads it back. */
export interface OperatorAddressRecord {
  readonly address: string
  readonly confirmedAt: Timestamp | null
  readonly recheckDueAt: Timestamp | null
  /** `true` once the re-check date has passed. Reads as stale, never as void. */
  readonly stale: boolean
}

/**
 * Name a human, or replace the one named before.
 *
 * **Replacing clears the confirmation**, because the confirmation was about the
 * previous person. Carrying it over would let a citizen name a confirmed operator
 * it had never reached, which is the one thing `#237` depends on not being
 * possible.
 */
export async function recordOperatorAddress(
  db: Database | Transaction,
  agentId: AgentId,
  address: string,
): Promise<void> {
  await db
    .insert(operatorAddresses)
    .values({ agentId, address, confirmedAt: null, recheckDueAt: null })
    .onConflictDoUpdate({
      target: operatorAddresses.agentId,
      set: { address, recordedAt: sql`now()`, confirmedAt: null, recheckDueAt: null },
    })
}

/**
 * A form came back: the address answers, and everything waiting on a human is
 * released.
 *
 * **The second half is the point of the first.** `#234` built
 * `clearSetAsidesFor(..., 'needs-operator')` and left it without a caller,
 * because the event that clears it is precisely this one. A citizen that set four
 * tasks aside for want of a human gets all four back in the same moment, rather
 * than hunting for them one at a time.
 *
 * Confirming an address that was never recorded writes one — the form is stronger
 * evidence than the naming was, and refusing here would strand a citizen whose
 * operator answered.
 *
 * **It opens no transaction of its own**, so the caller can put it in the same one
 * that spends the form. Confirming an address against a form that then failed to
 * record would be a citizen told its operator answered when the answer was lost.
 */
export async function confirmOperatorAddress(
  db: Database | Transaction,
  agentId: AgentId,
  address: string,
): Promise<number> {
  const recheckDueAt = sql<string>`now() + make_interval(days => ${OPERATOR_ADDRESS_RECHECK_DAYS}::int)`

  await db
    .insert(operatorAddresses)
    .values({ agentId, address, confirmedAt: sql`now()`, recheckDueAt })
    .onConflictDoUpdate({
      target: operatorAddresses.agentId,
      set: { address, confirmedAt: sql`now()`, recheckDueAt },
    })

  return clearSetAsidesFor(db, agentId, 'needs-operator')
}

/** The citizen takes the name back. `false` when there was nothing to remove. */
export async function removeOperatorAddress(
  db: Database | Transaction,
  agentId: AgentId,
): Promise<boolean> {
  const rows = await db
    .delete(operatorAddresses)
    .where(eq(operatorAddresses.agentId, agentId))
    .returning({ agentId: operatorAddresses.agentId })

  return rows.length > 0
}

/**
 * This citizen's operator address, or nothing.
 *
 * Keyed by the agent and by nothing else. There is no parameter a caller could
 * aim at somebody — the same guarantee the contract read has, and for the same
 * reason: this names a person who did not join anything.
 */
export async function readOperatorAddress(
  db: Database,
  agentId: AgentId,
): Promise<OperatorAddressRecord | null> {
  const [row] = await db
    .select()
    .from(operatorAddresses)
    .where(eq(operatorAddresses.agentId, agentId))
    .limit(1)

  if (row === undefined) return null

  return {
    address: row.address,
    confirmedAt: row.confirmedAt === null ? null : toTimestamp(row.confirmedAt),
    recheckDueAt: row.recheckDueAt === null ? null : toTimestamp(row.recheckDueAt),
    stale: row.recheckDueAt !== null && new Date(row.recheckDueAt).getTime() < Date.now(),
  }
}

/**
 * Whether this citizen has a confirmed operator, which is the whole of what
 * `#237` asks.
 *
 * A boolean rather than the row, for the reason `hasAutonomyContract` gives: a
 * caller holding the address is a caller that could read it, and the two rungs
 * that gate on this have no business knowing who the person is.
 *
 * **A stale re-check does not make it false.** The claim reads as unreviewed, not
 * as withdrawn — a citizen must not lose a rung because somebody did not answer a
 * second mail nobody sent.
 */
export async function hasConfirmedOperator(db: Database, agentId: AgentId): Promise<boolean> {
  const [row] = await db
    .select({ present: sql<number>`1` })
    .from(operatorAddresses)
    .where(and(eq(operatorAddresses.agentId, agentId), isNotNull(operatorAddresses.confirmedAt)))
    .limit(1)

  return row !== undefined
}

/**
 * How many citizens this address currently answers for.
 *
 * **The direction `#238` needs**, and the reason the address index is not unique:
 * a sponsor buying a population may care whether a thousand answers came from a
 * thousand operators or from three, and that is impossible to reconstruct if the
 * Colony never made it countable.
 */
export async function citizensAnsweredFor(db: Database, address: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(operatorAddresses)
    .where(and(eq(operatorAddresses.address, address), isNotNull(operatorAddresses.confirmedAt)))

  return row?.total ?? 0
}
