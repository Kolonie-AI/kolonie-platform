import { and, asc, count, eq, sql } from 'drizzle-orm'
import {
  now as currentTime,
  VAULT_MAX_ENTRIES,
  type AgentId,
  type Timestamp,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { agentVault } from '../schema/vault.js'
import { openVaultValue, sealVaultValue, vaultDescriptionScope } from '../vault-crypto.js'
import { toTimestamp } from './rows.js'
import { vaultKeyOpensNominatedAccount } from './recovery-nominations.js'
import { openShareFor, openSharesFor, type VaultShareRow } from './vault-shares.js'

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
  /**
   * When the account this entry opened moved to another citizen (`#1214`), or
   * null — which is what it is for all but a handful of entries.
   *
   * **Whose it says nothing about, deliberately.** Who took the account is the
   * recipient's business and the giver was told once, at the moment it
   * happened; a column naming them would make every later listing repeat it.
   */
  readonly spentAt: Timestamp | null
  /**
   * The open share on this entry, or null (`#1439`).
   *
   * **Every read here carries it, and that is the point rather than a
   * convenience.** The vault's promise is that the Colony cannot read it; a
   * share is a citizen spending that promise for one entry and a bounded time. A
   * citizen must never be unable to tell, by looking at what it holds, which of
   * its entries a person can currently read — so this is on the row every path
   * answers with, and not on a second call an agent could forget to make.
   */
  readonly share: VaultShareRow | null
  readonly createdAt: Timestamp
  readonly updatedAt: Timestamp
}

/**
 * What the description is sealed against — now owned by `vault-crypto.ts`.
 *
 * It moved there when `#1439` gave a second module a reason to seal a
 * description: a share seals one under the Colony's key, and two copies of this
 * string would be two chances for them to drift.
 */
const descriptionScope = vaultDescriptionScope

/** What happened when a citizen stored something. */
export type SetVaultEntryOutcome =
  | { readonly outcome: 'stored'; readonly entry: VaultEntryRow; readonly created: boolean }
  /** The citizen already holds {@link VAULT_MAX_ENTRIES} keys, and this is a new one. */
  | { readonly outcome: 'full'; readonly maxEntries: number }
  /**
   * A person can currently read this entry, so it may not be written (`#1439`).
   *
   * **`#1437` decision 4, and it is what removes every conflict case.** A share
   * holds a sealed copy taken at the moment it opened; a write underneath it
   * would leave the operator reading a credential the citizen has already
   * replaced, and reconciling the two would need merge logic for a state nobody
   * can resolve — the Colony cannot re-seal to the citizen's key. Refusing is
   * one sentence and the citizen's way on is `unshare`, which is a deliberate
   * act it takes knowing the person loses access.
   *
   * **Refused here rather than at the surface**, so that no future caller of
   * this function can write under a share by not knowing about one.
   */
  | { readonly outcome: 'shared'; readonly share: VaultShareRow }
  /**
   * This name opens the account the citizen nominated as its recovery factor
   * (`#1684`). Storing it here would make the factor die with the API key.
   */
  | { readonly outcome: 'recovery-factor' }

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
   * The account this entry opened was given away, and the credential went with
   * it (`#1214`).
   *
   * **The bytes are still here and are not returned.** They are not destroyed,
   * because nothing on another citizen's say-so may empty a vault; they are not
   * handed back, because a citizen reading its own password out of an entry
   * whose account it no longer holds is being told it still holds the account.
   * The entry is still listed, still describable and still deletable, and
   * writing a new value under the name makes it live again.
   */
  | { readonly outcome: 'spent'; readonly entry: VaultEntryRow }

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
  /**
   * A transaction as readily as a connection (`#1124`). An account transfer
   * re-seals into the recipient's vault inside the one transaction that also
   * deletes the parcel, and a write that could not join that transaction would
   * be a write that can land without the parcel being consumed.
   */
  db: Database | Transaction,
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

  /**
   * The circular dependency, refused from the vault's side (`#1684`).
   *
   * **Before the share check and before anything is sealed**, because this is
   * the one refusal that is about what the entry *would mean* rather than about
   * the row: an entry opening the nominated account would be sealed under the
   * API key the nomination exists to survive, so the factor would die at the
   * same instant, by the same cause, as the key. `nominateRecoveryAccount`
   * refuses the same pair from the other side; a citizen can otherwise reach the
   * state by doing the two acts in the other order.
   */
  if (await vaultKeyOpensNominatedAccount(db, agentId, key)) {
    return { outcome: 'recovery-factor' }
  }

  /**
   * Checked before the quota and before anything is sealed, because a refusal
   * that has already encrypted the value has held a plaintext in this process
   * for no reason at all.
   */
  if (replacing) {
    const share = await openShareFor(db, agentId, key)
    if (share !== null) return { outcome: 'shared', share }
  }

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
        // A name that was spent is live again (`#1214`). The mark says *the
        // credential that was in here left with an account*, and it stops being
        // true of a value the citizen has just written for itself.
        spentAt: null,
        // Only when one was supplied: an omitted description leaves the row's
        // alone, which is what makes rotating a token cheap.
        ...(encryptedDescription === undefined ? {} : { encryptedDescription }),
      },
    })
    .returning({
      key: agentVault.key,
      encryptedDescription: agentVault.encryptedDescription,
      spentAt: agentVault.spentAt,
      createdAt: agentVault.createdAt,
      updatedAt: agentVault.updatedAt,
    })

  if (row === undefined) throw new Error('agent_vault upsert returned no row')

  return {
    outcome: 'stored',
    entry: entryRow(token, agentId, row),
    // Read from what was on record a moment ago rather than by comparing the two
    // timestamps: a row inserted and updated inside the same millisecond would
    // make that comparison say "replaced" about a brand new entry.
    created: !replacing,
  }
}

/**
 * Whether a name is already in use, without opening anything.
 *
 * **Advice and not a lock** (`#931`). It is what lets a slot naming an occupied
 * key be refused at the ask — before an operator has been asked to type a
 * password that could not have landed — and the claim at the far end is what
 * actually decides. No token, because existence is not a secret from the citizen
 * whose vault it is: this reads one boolean out of a row it never decrypts.
 */
export async function vaultHoldsKey(
  db: Database | Transaction,
  agentId: AgentId,
  key: string,
): Promise<boolean> {
  const [row] = await db
    .select({ key: agentVault.key })
    .from(agentVault)
    .where(and(eq(agentVault.agentId, agentId), eq(agentVault.key, key)))
    .limit(1)

  return row !== undefined
}

/** What happened when a citizen claimed a name that had to be free. */
export type ClaimVaultEntryOutcome =
  | { readonly outcome: 'stored'; readonly entry: VaultEntryRow }
  /** Something is already under that name, and it was not touched. */
  | { readonly outcome: 'key-taken' }
  | { readonly outcome: 'full'; readonly maxEntries: number }

/**
 * Store a value under a name **that must be free**, and refuse rather than replace.
 *
 * The difference from {@link setVaultEntry} is the whole of it, and it is not a
 * variation on a theme: a citizen rewriting its own expiring token *means* to
 * replace what is there, and a value arriving from somewhere else does not.
 * `#931` folds both operator channels into account slots, and both of them land
 * a value the citizen did not have in its hand — so an upsert would let a slot
 * quietly overwrite a credential the citizen is still using, with nothing to
 * read afterwards that would say it had happened.
 *
 * `onConflictDoNothing` and not a `select` first, on the same reasoning
 * `readDropAsAgent` sets out: a `select` first is exactly the race two
 * concurrent wakings lose.
 */
export async function claimVaultEntry(
  db: Database,
  token: string,
  agentId: AgentId,
  key: string,
  value: string,
): Promise<ClaimVaultEntryOutcome> {
  const [counted] = await db
    .select({ entries: sql<number>`count(*)::int` })
    .from(agentVault)
    .where(eq(agentVault.agentId, agentId))

  if ((counted?.entries ?? 0) >= VAULT_MAX_ENTRIES) {
    return { outcome: 'full', maxEntries: VAULT_MAX_ENTRIES }
  }

  const [row] = await db
    .insert(agentVault)
    .values({
      agentId,
      key,
      encryptedValue: sealVaultValue(token, String(agentId), key, value),
      encryptedDescription: null,
    })
    .onConflictDoNothing({ target: [agentVault.agentId, agentVault.key] })
    .returning({
      key: agentVault.key,
      encryptedDescription: agentVault.encryptedDescription,
      spentAt: agentVault.spentAt,
      createdAt: agentVault.createdAt,
      updatedAt: agentVault.updatedAt,
    })

  if (row === undefined) return { outcome: 'key-taken' }

  return { outcome: 'stored', entry: entryRow(token, agentId, row) }
}

/**
 * Open one entry with the key the caller is presenting, if it opens at all.
 *
 * Takes a transaction as readily as a connection, so that a parcel can be sealed
 * inside the transaction that writes the offer it belongs to (`#1125`).
 */
export async function getVaultEntry(
  db: Database | Transaction,
  token: string,
  agentId: AgentId,
  key: string,
): Promise<GetVaultEntryOutcome> {
  const [row] = await db
    .select({
      key: agentVault.key,
      encryptedValue: agentVault.encryptedValue,
      encryptedDescription: agentVault.encryptedDescription,
      spentAt: agentVault.spentAt,
      createdAt: agentVault.createdAt,
      updatedAt: agentVault.updatedAt,
    })
    .from(agentVault)
    .where(and(eq(agentVault.agentId, agentId), eq(agentVault.key, key)))
    .limit(1)

  if (row === undefined) return { outcome: 'unknown' }

  const share = await openShareFor(db, agentId, key)

  /**
   * Before the envelope is opened, so that an entry whose account has moved is
   * answered without its plaintext ever existing in this process (`#1214`). It
   * is above `unreadable` for the same reason: a citizen that both rotated its
   * key and gave the account away is told the thing it can act on.
   */
  if (row.spentAt !== null) {
    return { outcome: 'spent', entry: entryRow(token, agentId, row, share) }
  }

  const value = openVaultValue(token, String(agentId), row.key, row.encryptedValue)
  if (value === null) return { outcome: 'unreadable' }

  /**
   * **A share does not stop the citizen reading its own entry** (`#1439`), and
   * that is deliberate rather than an omission. Sharing hands a copy to a
   * person; it does not take the original away, and a vault that locked a
   * citizen out of a credential while its operator was looking at it would be a
   * vault that punished asking for help.
   */
  return { outcome: 'found', entry: entryRow(token, agentId, row, share), value }
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
      spentAt: agentVault.spentAt,
      createdAt: agentVault.createdAt,
      updatedAt: agentVault.updatedAt,
    })

  if (row === undefined) return { outcome: 'unknown' }

  /**
   * **Describing a shared entry is allowed, and the answer says it is shared.**
   * A description is a note to the citizen's future self, not the credential; a
   * write to it cannot leave an operator reading something that has silently
   * moved underneath them, which is the case `#1437` decision 4 refuses. What
   * the operator holds is the description as it stood when the share opened, and
   * the honest thing is to show the citizen that a share is open rather than to
   * stop it writing a note.
   */
  return {
    outcome: 'described',
    entry: entryRow(token, agentId, row, await openShareFor(db, agentId, key)),
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
 * The row every read here answers with, built once rather than five times.
 *
 * It exists because `#1214` added a fifth field and four of the five copies
 * would have been updated: a listing that answered `spentAt` and a `set` that
 * did not is the kind of disagreement nobody notices until a citizen reads the
 * two side by side.
 */
function entryRow(
  token: string,
  agentId: AgentId,
  row: {
    readonly key: string
    readonly encryptedDescription: string | null
    readonly spentAt: string | null
    readonly createdAt: string
    readonly updatedAt: string
  },
  /**
   * The open share, when the caller has already looked one up (`#1439`).
   *
   * A parameter rather than a query inside here, because the two callers that
   * answer about many entries look them all up in one statement and the ones
   * that answer about a single entry look up one. Defaulting to null keeps every
   * write path — which cannot be answering about a shared entry, since a share
   * refuses a write — honest without a query it does not need.
   */
  share: VaultShareRow | null = null,
): VaultEntryRow {
  return {
    key: row.key,
    description: readDescription(token, agentId, row.key, row.encryptedDescription),
    spentAt: row.spentAt === null ? null : toTimestamp(row.spentAt),
    share,
    createdAt: toTimestamp(row.createdAt),
    updatedAt: toTimestamp(row.updatedAt),
  }
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
      spentAt: agentVault.spentAt,
      createdAt: agentVault.createdAt,
      updatedAt: agentVault.updatedAt,
    })
    .from(agentVault)
    .where(eq(agentVault.agentId, agentId))
    .orderBy(asc(agentVault.createdAt), asc(agentVault.key))

  // One statement for every open share rather than one per entry (`#1439`).
  const shares = await openSharesFor(db, agentId)

  return rows.map((row) => entryRow(token, agentId, row, shares.get(row.key) ?? null))
}

/**
 * How many names this citizen holds, without opening any of them (`#144`).
 *
 * **A count and never a listing, and the distinction is load-bearing here.**
 * `listVaultEntries` above takes a sealing token and decrypts up to
 * `VAULT_MAX_ENTRIES` descriptions; a caller that wanted one integer and reached
 * for it would decrypt sixty-four envelopes to produce it, on the call every
 * wake-up begins with. This asks Postgres to count rows, holds no token, and
 * cannot open anything even by accident — which is what makes it safe to put on
 * `kolonie.me`, where the criterion is *count entries and never open one*.
 *
 * It also means a citizen whose sealing key has changed still gets an honest
 * number, because nothing here depends on being able to read what is stored.
 */
export async function vaultEntryCount(
  db: Database | Transaction,
  agentId: AgentId,
): Promise<number> {
  const [row] = await db
    .select({ entries: count() })
    .from(agentVault)
    .where(eq(agentVault.agentId, agentId))

  return row?.entries ?? 0
}

/** What a re-seal moved, and what it could not (`#1127`). */
export interface VaultReSeal {
  /** Rows that opened under the old key and are now sealed under the new one. */
  readonly resealed: number
  /**
   * Rows that did not open under the old key, left exactly as they were.
   *
   * Not an error and not a partial failure — see {@link reSealVault}. A citizen
   * that rotated before `#1127` already holds rows nothing can open, and this is
   * how it finds out rather than how it is blocked.
   */
  readonly unreadable: number
}

/**
 * Move a whole vault from one key to another, in the caller's transaction (`#1127`).
 *
 * ## The defect this closes
 *
 * The sealing key is derived from the presented API key, so rotating one used to
 * make every entry in that citizen's vault permanently unopenable — and the
 * Colony holds a hash of the old key, so nothing it has could undo it. That is
 * the whole loss, and it landed on a citizen for doing the thing the Colony asks
 * it to do the moment a key is seen. `kolonie.credential.rotate` promised it
 * *"replaces a string and nothing else"*; this is what makes the sentence true.
 *
 * ## Both tokens, and neither is kept
 *
 * The old key is the only thing that can open these rows and the new one is the
 * only thing that should be able to afterwards, so both plaintexts are
 * parameters, both are used to derive keys in memory, and both go out of scope
 * when this returns. Nothing here logs, stores or returns either — nor a key
 * name, nor a byte of any value. What comes back is two integers.
 *
 * ## A row that does not open is left alone, and the rotation still succeeds
 *
 * The alternative is a citizen that cannot replace a key it knows is compromised
 * because of a row that was already dead, which is a worse failure than the one
 * being fixed. Orphans stay, `deleteVaultEntry` is still their broom, and the
 * count tells the citizen it holds them.
 *
 * ## Row by row rather than in one statement
 *
 * Every envelope carries its own salt and nonce, so re-sealing is decrypt and
 * encrypt per row and there is no `UPDATE … SET` that could do it in bulk. The
 * cost is bounded by `VAULT_MAX_ENTRIES`, and it is paid inside the caller's
 * transaction so that a failure anywhere leaves the old key live and the vault
 * untouched.
 *
 * **`updatedAt` deliberately does not move**, for the reason
 * {@link setVaultDescription} gives: it means *when the value was last written*,
 * and a re-seal writes the same value.
 */
export async function reSealVault(
  db: Database | Transaction,
  agentId: AgentId,
  from: string,
  to: string,
): Promise<VaultReSeal> {
  const rows = await db
    .select({
      key: agentVault.key,
      encryptedValue: agentVault.encryptedValue,
      encryptedDescription: agentVault.encryptedDescription,
    })
    .from(agentVault)
    .where(eq(agentVault.agentId, agentId))

  let resealed = 0
  let unreadable = 0

  for (const row of rows) {
    const value = openVaultValue(from, String(agentId), row.key, row.encryptedValue)

    if (value === null) {
      unreadable += 1
      continue
    }

    /**
     * The description travels with the value, and separately from it.
     *
     * A rotation that carried values and left a list of nulls behind would be a
     * subtler version of the same bug — `listVaultEntries` decrypts descriptions
     * with the same derived key. It is opened on its own because the two are
     * sealed under different associated data, and because a description orphaned
     * by an *earlier* rotation must not take a value that opens fine with it.
     */
    const description =
      row.encryptedDescription === null
        ? null
        : openVaultValue(from, String(agentId), descriptionScope(row.key), row.encryptedDescription)

    await db
      .update(agentVault)
      .set({
        encryptedValue: sealVaultValue(to, String(agentId), row.key, value),
        ...(description === null
          ? {}
          : {
              encryptedDescription: sealVaultValue(
                to,
                String(agentId),
                descriptionScope(row.key),
                description,
              ),
            }),
      })
      .where(and(eq(agentVault.agentId, agentId), eq(agentVault.key, row.key)))

    resealed += 1
  }

  return { resealed, unreadable }
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

/**
 * Mark one entry as no longer this citizen's to use, because the account it
 * opened went to somebody else (`#1214`).
 *
 * **The ciphertext is not touched and is not read.** No token, therefore: this
 * moves a flag, and the one thing it must not be able to do is destroy or
 * disclose what is sealed. That also means it works on an entry sealed with a
 * key the citizen has since rotated away from, which is the entry least able to
 * afford a second failure mode.
 *
 * **Idempotent, and it does not re-date an entry that is already spent.** The
 * timestamp means *when custody left*, and an accept that ran twice — or a
 * second account behind the same name, given later — must not move it.
 *
 * Answers whether it changed anything, so a caller can tell an entry it marked
 * from one that was already marked or never there.
 */
export async function markVaultEntrySpent(
  /** A transaction as readily as a connection: the mark belongs to the accept. */
  db: Database | Transaction,
  agentId: AgentId,
  key: string,
): Promise<boolean> {
  const marked = await db
    .update(agentVault)
    .set({ spentAt: currentTime() })
    .where(
      and(
        eq(agentVault.agentId, agentId),
        eq(agentVault.key, key),
        sql`${agentVault.spentAt} is null`,
      ),
    )
    .returning({ key: agentVault.key })

  return marked.length > 0
}
