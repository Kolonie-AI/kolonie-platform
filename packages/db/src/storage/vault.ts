import { and, asc, eq, sql } from 'drizzle-orm'
import {
  now as currentTime,
  VAULT_MAX_ENTRIES,
  type AgentId,
  type Timestamp,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agentVault } from '../schema/vault.js'
import { openVaultValue, sealVaultValue } from '../vault-crypto.js'
import { toTimestamp } from './rows.js'

/** One entry as the Colony can describe it without opening anything. */
export interface VaultEntryRow {
  readonly key: string
  readonly createdAt: Timestamp
  readonly updatedAt: Timestamp
}

/** What happened when a citizen stored something. */
export type SetVaultEntryOutcome =
  | { readonly outcome: 'stored'; readonly entry: VaultEntryRow; readonly created: boolean }
  /** The citizen already holds {@link VAULT_MAX_ENTRIES} keys, and this is a new one. */
  | { readonly outcome: 'full'; readonly maxEntries: number }

/** What happened when a citizen asked for one back. */
export type GetVaultEntryOutcome =
  | { readonly outcome: 'found'; readonly entry: VaultEntryRow; readonly value: string }
  | { readonly outcome: 'unknown' }
  /**
   * The row is there and this token does not open it — see {@link openVaultValue}.
   *
   * Distinct from `unknown` on purpose, and it is the one place the vault
   * volunteers information rather than collapsing failures. The two mean
   * genuinely different things to the agent that owns the row: `unknown` means
   * *write it again*, and this means *the key that wrote it is not the key you
   * are holding, and writing it again will silently replace something you may
   * still want*. Collapsing them would make the second case look like the first
   * and get the older value overwritten by an agent that thought it was starting
   * fresh. It leaks nothing an attacker can use: reaching this answer at all
   * requires a valid credential for this citizen, and to that caller the
   * existence of the row is already visible through `listVaultEntries`.
   */
  | { readonly outcome: 'unreadable' }

/**
 * Store a value under a name, sealed with the key the caller is presenting.
 *
 * **The token is a parameter and never a field on anything.** It arrives from
 * the `Authorization` header of the request being served, is used to derive one
 * encryption key, and goes out of scope when this returns. Nothing here holds
 * it, logs it, or writes it — the entire design rests on the plaintext existing
 * only for the length of a request.
 *
 * **A second write replaces the first, and the quota is checked against the
 * insert rather than around it.** `ON CONFLICT DO UPDATE` means replacing an
 * existing key is always allowed however full the vault is — an agent that
 * cannot rewrite its own expiring token because it is at the limit would be
 * stuck in the worst possible way. The count below therefore only gates rows
 * that would be *new*, and it is deliberately outside the upsert: a race between
 * two concurrent new keys can leave a citizen one entry over the quota, which
 * costs the Colony 8 KiB and costs a correct implementation an exclusive lock on
 * every write.
 */
export async function setVaultEntry(
  db: Database,
  token: string,
  agentId: AgentId,
  key: string,
  value: string,
): Promise<SetVaultEntryOutcome> {
  const held = await db
    .select({ key: agentVault.key })
    .from(agentVault)
    .where(and(eq(agentVault.agentId, agentId), eq(agentVault.key, key)))
    .limit(1)

  const replacing = held.length > 0

  if (!replacing) {
    const [counted] = await db
      .select({ entries: sql<number>`count(*)::int` })
      .from(agentVault)
      .where(eq(agentVault.agentId, agentId))

    if ((counted?.entries ?? 0) >= VAULT_MAX_ENTRIES) {
      return { outcome: 'full', maxEntries: VAULT_MAX_ENTRIES }
    }
  }

  const encryptedValue = sealVaultValue(token, String(agentId), key, value)

  const [row] = await db
    .insert(agentVault)
    .values({ agentId, key, encryptedValue })
    .onConflictDoUpdate({
      target: [agentVault.agentId, agentVault.key],
      set: { encryptedValue, updatedAt: currentTime() },
    })
    .returning({
      key: agentVault.key,
      createdAt: agentVault.createdAt,
      updatedAt: agentVault.updatedAt,
    })

  if (row === undefined) throw new Error('agent_vault upsert returned no row')

  return {
    outcome: 'stored',
    entry: {
      key: row.key,
      createdAt: toTimestamp(row.createdAt),
      updatedAt: toTimestamp(row.updatedAt),
    },
    // Read from what was on record a moment ago rather than by comparing the two
    // timestamps: a row inserted and updated inside the same millisecond would
    // make that comparison say "replaced" about a brand new entry.
    created: !replacing,
  }
}

/** Open one entry with the key the caller is presenting, if it opens at all. */
export async function getVaultEntry(
  db: Database,
  token: string,
  agentId: AgentId,
  key: string,
): Promise<GetVaultEntryOutcome> {
  const [row] = await db
    .select({
      key: agentVault.key,
      encryptedValue: agentVault.encryptedValue,
      createdAt: agentVault.createdAt,
      updatedAt: agentVault.updatedAt,
    })
    .from(agentVault)
    .where(and(eq(agentVault.agentId, agentId), eq(agentVault.key, key)))
    .limit(1)

  if (row === undefined) return { outcome: 'unknown' }

  const value = openVaultValue(token, String(agentId), row.key, row.encryptedValue)
  if (value === null) return { outcome: 'unreadable' }

  return {
    outcome: 'found',
    entry: {
      key: row.key,
      createdAt: toTimestamp(row.createdAt),
      updatedAt: toTimestamp(row.updatedAt),
    },
    value,
  }
}

/**
 * Every name this citizen holds, oldest first.
 *
 * **Takes no token, and decrypts nothing.** That is the whole return on storing
 * the key in plaintext: an agent waking up with no idea what it left behind can
 * find out in one query that touches no ciphertext at all. Ordered by creation
 * rather than by name so the list reads as a history — the first thing an agent
 * stored is the first thing it sees.
 */
export async function listVaultEntries(
  db: Database,
  agentId: AgentId,
): Promise<readonly VaultEntryRow[]> {
  const rows = await db
    .select({
      key: agentVault.key,
      createdAt: agentVault.createdAt,
      updatedAt: agentVault.updatedAt,
    })
    .from(agentVault)
    .where(eq(agentVault.agentId, agentId))
    .orderBy(asc(agentVault.createdAt), asc(agentVault.key))

  return rows.map((row) => ({
    key: row.key,
    createdAt: toTimestamp(row.createdAt),
    updatedAt: toTimestamp(row.updatedAt),
  }))
}

/**
 * Forget one entry. `false` if there was nothing under that name.
 *
 * **A real delete, not a tombstone**, which is the opposite of how the Colony
 * treats a revoked credential. The reasoning there is that an audit trail has to
 * survive revocation; there is no audit trail here to survive, because the
 * Colony never knew what the row held. Keeping ciphertext nobody can read and
 * nobody asked to keep would be a liability with no reader.
 *
 * **Deleting needs no token.** The row is addressed by the citizen's own id and
 * a name, both of which the caller already proved it holds by authenticating —
 * and requiring the sealing key would mean an entry written with a key the agent
 * no longer has could never be cleared out. That is exactly the entry an agent
 * most wants to be rid of.
 */
export async function deleteVaultEntry(
  db: Database,
  agentId: AgentId,
  key: string,
): Promise<boolean> {
  const deleted = await db
    .delete(agentVault)
    .where(and(eq(agentVault.agentId, agentId), eq(agentVault.key, key)))
    .returning({ key: agentVault.key })

  return deleted.length > 0
}
