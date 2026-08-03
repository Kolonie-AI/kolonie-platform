import { eq, isNotNull, and, count } from 'drizzle-orm'
import {
  AgentHoldingsSchema,
  type AccountKind,
  type AgentHoldings,
  type AgentId,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { accounts } from '../schema/accounts.js'
import { provedMailbox } from './email.js'
import { vaultEntryCount } from './vault.js'

/**
 * What a citizen holds, summarised for the one line `kolonie.me` gives it
 * (`#144`).
 *
 * **Three reads and no listing.** The accounts are aggregated in SQL rather than
 * fetched and counted here, the reach address comes from the one function that
 * knows which address the Colony actually writes to, and the vault is counted
 * without a token. Reaching for `listAccounts` and `listVaultEntries` would have
 * been the obvious implementation and the wrong one: the first is the register's
 * own read with its own ordering, and the second decrypts every description on a
 * call that wanted one integer.
 *
 * **No vault value and no vault description is opened anywhere on this path**,
 * which is a criterion of the issue rather than a nicety — see
 * {@link vaultEntryCount}, which cannot open one even by accident because it
 * holds no token.
 *
 * Retired and lost accounts are counted, for the reason `listAccounts` returns
 * them: they are excluded from being *offered*, never from the citizen's own
 * view of its own record.
 */
export async function holdingsOf(
  db: Database | Transaction,
  agentId: AgentId,
): Promise<AgentHoldings> {
  const [byKind, unconfirmed, reach, vaultEntries] = await Promise.all([
    db
      .select({ kind: accounts.kind, held: count() })
      .from(accounts)
      .where(eq(accounts.agentId, agentId))
      .groupBy(accounts.kind),
    /**
     * The identifiers of accounts a re-check last failed to find (`#152`).
     *
     * Named rather than counted, because *two accounts need attention* would
     * send the citizen to the register to discover which — and this line exists
     * so it does not have to.
     */
    db
      .select({ identifier: accounts.identifier })
      .from(accounts)
      .where(and(eq(accounts.agentId, agentId), isNotNull(accounts.unconfirmedSince)))
      .orderBy(accounts.identifier),
    // `provedMailbox` and not the register: mail is the one kind where *which
    // one* has an obligation behind it rather than a preference, and the
    // register would answer with *an* address the citizen proved rather than
    // *the* one the Colony writes to. That file argues it at length.
    provedMailbox(db as Database, agentId),
    vaultEntryCount(db, agentId),
  ])

  const unconfirmedIdentifiers = unconfirmed.map((row) => row.identifier)
  const reachAddress = reach?.address ?? null

  return AgentHoldingsSchema.parse({
    accounts: Object.fromEntries(byKind.map((row) => [row.kind as AccountKind, row.held] as const)),
    reachAddress,
    unconfirmed: unconfirmedIdentifiers,
    vaultEntries,
    // Its own answer rather than something the reader derives from the two
    // fields above, so that a surface which shows one and not the other cannot
    // quietly lose the case that actually costs the citizen something.
    reachAddressUnconfirmed: reachAddress !== null && unconfirmedIdentifiers.includes(reachAddress),
  })
}
