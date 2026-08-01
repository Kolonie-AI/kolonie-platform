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

/** One entry as the citizen sees it: its name, its description, and when it moved. */
export interface VaultEntryRow {
  readonly key: string
  /**
   * Decrypted for the caller, or null (`#154`).
   *
   * Null means three different things and deliberately does not distinguish
   * them: no description was written, the entry predates the column, or this
   * token cannot open it. The third is the same fact `getVaultEntry` reports as
   * `unreadable`, and it arrives here as an absence because one unopenable row
   * must not fail the listing of the sixty-three that open.
   */
  readonly description: string | null
  readonly createdAt: Timestamp
  readonly updatedAt: Timestamp
}

/**
 * What the description is sealed against, which is not quite what the value is.
 *
 * The envelope binds ciphertext to the citizen and to the entry's name through
 * its associated data. Sealing both fields under the *same* associated data
 * would leave the two interchangeable: a row whose description ciphertext was
 * swapped into its value column would still open, and the citizen would read its
 * own note where it expected a credential. One suffix removes that, at the cost
 * of a string concatenation.
 */
const descriptionScope = (key: string): string => `${key}#description`

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
  /**
   * Absent leaves whatever description is on the row.
   *
   * A write that cleared it whenever a citizen rotated a token would lose the
   * description at the exact moment the entry is being maintained — see
   * {@link setVaultDescription} for the deliberate act of clearing one.
   */
  description?: string | undefined,
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
  const encryptedDescription =
    description === undefined
      ? undefined
      : sealVaultValue(token, String(agentId), descriptionScope(key), description)

  const [row] = await db
    .insert(agentVault)
    .values({ agentId, key, encryptedValue, encryptedDescription: encryptedDescription ?? null })
    .onConflictDoUpdate({
      target: [agentVault.agentId, agentVault.key],
      set: {
        encryptedValue,
        updatedAt: currentTime(),
        // Only when one was supplied: an omitted description leaves the row's
        // alone, which is what makes rotating a token cheap.
        ...(encryptedDescription === undefined ? {} : { encryptedDescription }),
      },
    })
    .returning({
      key: agentVault.key,
      encryptedDescription: agentVault.encryptedDescription,
      createdAt: agentVault.createdAt,
      updatedAt: agentVault.updatedAt,
    })

  if (row === undefined) throw new Error('agent_vault upsert returned no row')

  return {
    outcome: 'stored',
    entry: {
      key: row.key,
      description: readDescription(token, agentId, row.key, row.encryptedDescription),
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
      encryptedDescription: agentVault.encryptedDescription,
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
      description: readDescription(token, agentId, row.key, row.encryptedDescription),
      createdAt: toTimestamp(row.createdAt),
      updatedAt: toTimestamp(row.updatedAt),
    },
    value,
  }
}

/** What {@link setVaultDescription} did. */
export type SetVaultDescriptionOutcome =
  { readonly outcome: 'described'; readonly entry: VaultEntryRow } | { readonly outcome: 'unknown' }

/**
 * Write or clear the description alone, without the value being re-sent.
 *
 * **The value is not touched and is not needed**, which is the whole reason this
 * is its own function. Describing an entry is bookkeeping; requiring the secret
 * alongside it would mean a citizen had to be holding a credential in order to
 * write a note about it, and would push a copy of that credential through a
 * second request for no gain.
 *
 * `updatedAt` deliberately does not move. It means *when the value was last
 * written*, every reader of the vault is told so, and a description edit that
 * advanced it would make a citizen believe its token had been rotated.
 */
export async function setVaultDescription(
  db: Database,
  token: string,
  agentId: AgentId,
  key: string,
  description: string | null,
): Promise<SetVaultDescriptionOutcome> {
  const encryptedDescription =
    description === null
      ? null
      : sealVaultValue(token, String(agentId), descriptionScope(key), description)

  const [row] = await db
    .update(agentVault)
    .set({ encryptedDescription })
    .where(and(eq(agentVault.agentId, agentId), eq(agentVault.key, key)))
    .returning({
      key: agentVault.key,
      encryptedDescription: agentVault.encryptedDescription,
      createdAt: agentVault.createdAt,
      updatedAt: agentVault.updatedAt,
    })

  if (row === undefined) return { outcome: 'unknown' }

  return {
    outcome: 'described',
    entry: {
      key: row.key,
      description: readDescription(token, agentId, row.key, row.encryptedDescription),
      createdAt: toTimestamp(row.createdAt),
      updatedAt: toTimestamp(row.updatedAt),
    },
  }
}

/**
 * Open one description, or answer null.
 *
 * **Never throws and never distinguishes why.** A row sealed with a key the
 * caller no longer holds is unopenable and that is a fact about one entry; a
 * listing that failed because of it would take the other sixty-three with it,
 * which is precisely the citizen — one that has rotated a key — least able to
 * afford losing the list.
 */
function readDescription(
  token: string,
  agentId: AgentId,
  key: string,
  envelope: string | null,
): string | null {
  if (envelope === null) return null
  return openVaultValue(token, String(agentId), descriptionScope(key), envelope)
}

/**
 * Every name this citizen holds, oldest first, with its description (`#154`).
 *
 * **It takes a token now, and decrypts at most `VAULT_MAX_ENTRIES` short
 * strings.** That is a change to the sentence this function used to make about
 * itself — *takes no token, decrypts nothing* — and the trade is deliberate: the
 * names stay in plaintext, so the query, the ordering and the idempotent write
 * are all still free of ciphertext, and what is opened is sixty-four small
 * envelopes on a call that already holds the sealing key because it is already
 * authenticated. The values are still never opened here, which is the property
 * that actually mattered.
 *
 * **A description this token cannot open is null rather than an error**, so an
 * agent that rotated its key still gets its list.
 *
 * Ordered by creation rather than by name so the list reads as a history — the
 * first thing an agent stored is the first thing it sees.
 */
export async function listVaultEntries(
  db: Database,
  token: string,
  agentId: AgentId,
): Promise<readonly VaultEntryRow[]> {
  const rows = await db
    .select({
      key: agentVault.key,
      encryptedDescription: agentVault.encryptedDescription,
      createdAt: agentVault.createdAt,
      updatedAt: agentVault.updatedAt,
    })
    .from(agentVault)
    .where(eq(agentVault.agentId, agentId))
    .orderBy(asc(agentVault.createdAt), asc(agentVault.key))

  return rows.map((row) => ({
    key: row.key,
    description: readDescription(token, agentId, row.key, row.encryptedDescription),
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
