import type { AgentId } from '@kolonie-ai/core'
import type { Database } from '@kolonie-ai/db'
import { hasConfirmedOperator } from '@kolonie-ai/db'

/**
 * Whether a human has been confirmed for a citizen (#235, #237).
 *
 * **A boolean, never the address.** The two rungs that gate on this have no
 * business knowing who the person is, and a port that handed them the row would
 * be a port a later change could read from. Same argument `AutonomyContracts`
 * makes about the contract, and the same shape.
 *
 * Its own module rather than a method on the autonomy dependencies, because the
 * callers are the GitHub and social rungs — neither of which should have to
 * depend on the autonomy module to ask one question about a citizen.
 */
export interface ConfirmedOperators {
  isConfirmed(agentId: AgentId): Promise<boolean>
}

/** Wired to a real database. */
export function databaseConfirmedOperators(db: Database): ConfirmedOperators {
  return { isConfirmed: (agentId) => hasConfirmedOperator(db, agentId) }
}

/** Everything a test that does not care about the gate needs. */
export function operatorConfirmed(confirmed = true): ConfirmedOperators {
  return { isConfirmed: () => Promise.resolve(confirmed) }
}
