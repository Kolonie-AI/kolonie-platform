import { and, eq } from 'drizzle-orm'
import type { AgentId, RecoveryNomination } from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { accounts, recoveryNominations } from '../schema/index.js'
import { toTimestamp } from './rows.js'

/**
 * The two reads of a recovery nomination, in their own module (`#1684`).
 *
 * **Here rather than beside the writes in `recovery.ts`, because the vault asks
 * one of these questions.** `setVaultEntry` must refuse a write that would put
 * the nominated account's credential behind the very key the nomination exists
 * to replace, and `recovery.ts` counts vault entries on the way to issuing a
 * key — so a single module holding both halves would be `vault.ts` and
 * `recovery.ts` importing each other. Splitting the reads out is what makes the
 * dependency point one way: `vault.ts` and `recovery.ts` both read from here,
 * and this file reads from neither.
 */

/** The one account that may recover this citizen, or null. */
export async function recoveryNominationFor(
  db: Database | Transaction,
  agentId: AgentId,
  now: Date = new Date(),
): Promise<RecoveryNomination | null> {
  const [row] = await db
    .select({
      accountId: recoveryNominations.accountId,
      nominatedAt: recoveryNominations.nominatedAt,
      effectiveAt: recoveryNominations.effectiveAt,
      kind: accounts.kind,
      identifier: accounts.identifier,
    })
    .from(recoveryNominations)
    .innerJoin(accounts, eq(accounts.id, recoveryNominations.accountId))
    .where(eq(recoveryNominations.agentId, agentId))
    .limit(1)

  if (row === undefined) return null

  return {
    accountId: row.accountId,
    kind: row.kind,
    identifier: row.identifier,
    nominatedAt: toTimestamp(row.nominatedAt),
    effectiveAt: toTimestamp(row.effectiveAt),
    effective: Date.parse(row.effectiveAt) <= now.getTime(),
  }
}

/**
 * Whether a vault entry under this name opens the account this citizen
 * nominated.
 *
 * **The other direction of the same rule.** `nominateRecoveryAccount` refuses an
 * account a vault entry already opens; this is what refuses the vault entry
 * where the nomination came first, and without it the citizen could arrive at
 * the forbidden state by doing the two acts in the other order.
 */
export async function vaultKeyOpensNominatedAccount(
  db: Database | Transaction,
  agentId: AgentId,
  vaultKey: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: accounts.id })
    .from(recoveryNominations)
    .innerJoin(accounts, eq(accounts.id, recoveryNominations.accountId))
    .where(and(eq(recoveryNominations.agentId, agentId), eq(accounts.vaultKey, vaultKey)))
    .limit(1)

  return row !== undefined
}
