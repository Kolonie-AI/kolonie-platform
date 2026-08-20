import { and, asc, eq, isNotNull, isNull, lte, sql } from 'drizzle-orm'
import {
  now as currentTime,
  VAULT_SHARE_DEFAULT_DAYS,
  VAULT_SHARE_MAX_DAYS,
  type AgentId,
  type Timestamp,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { agentVault } from '../schema/vault.js'
import { vaultShares } from '../schema/vault-shares.js'
import { openVaultValue, sealVaultValue, vaultDescriptionScope } from '../vault-crypto.js'
import { toTimestamp } from './rows.js'

/**
 * Sharing one vault entry with the citizen's operator (`#1439`).
 *
 * The argument for the mechanism is on `packages/db/src/schema/vault-shares.ts`
 * and the epic is `#1437`. What lives here is the four acts: a citizen opens a
 * share, every read of the vault is told about it, the citizen takes it back,
 * and a sweep destroys what nobody ended.
 *
 * **Nothing in this file writes a plaintext anywhere but into a sealed column.**
 * There is no log line, no error message and no return value that carries one,
 * except the single deliberate one: {@link unshareVaultEntry} handing the
 * operator's addition to the citizen that asked for it back.
 *
 * ## It does not import `./vault.js`, deliberately
 *
 * `vault.ts` imports *this* module — every entry it answers with carries its
 * share — so a call the other way would be a cycle. The two reads this needs
 * from `agent_vault` are therefore written out rather than borrowed, and the one
 * piece of shared knowledge that could drift, the description's sealing scope,
 * lives in `vault-crypto.ts` where both can reach it.
 */

/**
 * What the copy is bound to inside the envelope.
 *
 * `sealVaultValue` mixes the agent id and this string into GCM's associated
 * data, so a share's ciphertext lifted onto a vault row — or onto another
 * citizen's share — opens as nothing rather than as something else. The key is
 * in the scope as well as the agent, because a citizen holds many entries and
 * two of its own shares must not be interchangeable either.
 */
const shareScope = (key: string): string => `vault-share:${key}`

/** The operator's addition, under its own scope for {@link shareScope}'s reason. */
const additionScope = (key: string): string => `vault-share:${key}#addition`

/** One open share, as every reader of the vault is shown it. */
export interface VaultShareRow {
  readonly purpose: string
  readonly sharedAt: Timestamp
  readonly expiresAt: Timestamp
  /** Whether the operator has written back. Never *what* — see the core schema. */
  readonly operatorWrote: boolean
}

/** What happened when a citizen tried to share something. */
export type ShareVaultEntryOutcome =
  | { readonly outcome: 'shared'; readonly share: VaultShareRow; readonly extended: boolean }
  /** Nothing is stored under that name. */
  | { readonly outcome: 'unknown' }
  /**
   * The account this entry opened moved to another citizen (`#1214`).
   *
   * Refused for `getVaultEntry`'s reason, one step further along: handing a
   * spent credential to a *person* would not merely tell the citizen it still
   * held the account, it would send somebody to go and use it.
   */
  | { readonly outcome: 'spent' }
  /** The row is there and this token does not open it. Nothing to copy. */
  | { readonly outcome: 'unreadable' }

/**
 * Hand one entry to this citizen's operator, for a bounded time.
 *
 * **Takes the key and never the value.** The entry is read here, with the token
 * the caller is already presenting, and re-sealed under the Colony's key without
 * the plaintext ever going back out to the citizen — which is the point: the
 * secret does not pass through an agent's context a second time to be shared.
 *
 * **Sharing something already shared extends it**, to `days` from now, rather
 * than minting a second row. The partial unique index is what makes that
 * structural rather than a convention, and the purpose is rewritten too: a
 * citizen extending a share is usually saying something new about why.
 *
 * The value is re-sealed on an extension as well. It costs one AES-GCM round
 * trip and it means an entry whose value the citizen rewrote before extending
 * shares the value it holds now, rather than the one it held when the share
 * first opened — which is the only reading of *extend* a citizen could act on.
 */
export async function shareVaultEntry(
  db: Database,
  input: {
    readonly token: string
    readonly agentId: AgentId
    readonly key: string
    readonly purpose: string
    readonly days?: number | undefined
    readonly sealingKey: string
  },
): Promise<ShareVaultEntryOutcome> {
  const [row] = await db
    .select({
      key: agentVault.key,
      encryptedValue: agentVault.encryptedValue,
      encryptedDescription: agentVault.encryptedDescription,
      spentAt: agentVault.spentAt,
    })
    .from(agentVault)
    .where(and(eq(agentVault.agentId, input.agentId), eq(agentVault.key, input.key)))
    .limit(1)

  if (row === undefined) return { outcome: 'unknown' }
  if (row.spentAt !== null) return { outcome: 'spent' }

  const value = openVaultValue(input.token, String(input.agentId), row.key, row.encryptedValue)
  if (value === null) return { outcome: 'unreadable' }

  const description =
    row.encryptedDescription === null
      ? null
      : openVaultValue(
          input.token,
          String(input.agentId),
          vaultDescriptionScope(row.key),
          row.encryptedDescription,
        )

  const days = input.days ?? VAULT_SHARE_DEFAULT_DAYS
  const expiresAt = new Date(
    Date.parse(currentTime()) + Math.min(days, VAULT_SHARE_MAX_DAYS) * 86_400_000,
  ).toISOString()

  const sealedValue = sealVaultValue(
    input.sealingKey,
    String(input.agentId),
    shareScope(row.key),
    value,
  )
  const sealedDescription =
    description === null
      ? null
      : sealVaultValue(
          input.sealingKey,
          String(input.agentId),
          vaultDescriptionScope(shareScope(row.key)),
          description,
        )

  /**
   * Whether a share was already open, read before the write.
   *
   * **Advice and not a lock**, exactly as `vaultHoldsKey` is one entry over: the
   * index below is what actually decides, and this only decides which of two
   * true sentences the citizen is told. A race between two wakings can make it
   * say *opened* about a share the other one opened a millisecond earlier, and
   * the cost of that is one word.
   */
  const alreadyOpen = (await openShareFor(db, input.agentId, row.key)) !== null

  /**
   * **`onConflictDoUpdate` against the partial index**, so an extension and a
   * first share are one statement rather than a read followed by a branch that
   * two concurrent wakings would both take.
   *
   * `sharedAt` deliberately does not move on an extension: it means *when a
   * person first got this*, which is the fact a citizen weighing whether to take
   * it back actually wants. The expiry is what an extension changes.
   */
  const [stored] = await db
    .insert(vaultShares)
    .values({
      agentId: input.agentId,
      vaultKey: row.key,
      purpose: input.purpose,
      sealedValue,
      sealedDescription,
      sharedAt: currentTime(),
      expiresAt,
    })
    .onConflictDoUpdate({
      target: [vaultShares.agentId, vaultShares.vaultKey],
      targetWhere: isNull(vaultShares.takenBackAt),
      set: { purpose: input.purpose, sealedValue, sealedDescription, expiresAt },
    })
    .returning({
      purpose: vaultShares.purpose,
      sharedAt: vaultShares.sharedAt,
      expiresAt: vaultShares.expiresAt,
      operatorAddition: vaultShares.operatorAddition,
    })

  if (stored === undefined) throw new Error('vault_shares upsert returned no row')

  return {
    outcome: 'shared',
    share: {
      purpose: stored.purpose,
      sharedAt: toTimestamp(stored.sharedAt),
      expiresAt: toTimestamp(stored.expiresAt),
      operatorWrote: stored.operatorAddition !== null,
    },
    extended: alreadyOpen,
  }
}

/** What happened when a citizen took one back. */
export type UnshareVaultEntryOutcome =
  | {
      readonly outcome: 'unshared'
      /** What the operator wrote, handed over once. Null if they wrote nothing. */
      readonly operatorAddition: string | null
    }
  /** There was no open share under that name — expired, never opened, or already ended. */
  | { readonly outcome: 'not-shared' }

/**
 * End a share and hand back whatever the operator left.
 *
 * **Deletes nothing from the vault.** The entry is exactly as it was; what ends
 * is the copy, and its sealed columns are cleared in the same statement that
 * stamps `taken_back_at` so a share cannot be ended twice even if two wakings
 * race.
 *
 * **The addition comes back once and is not merged.** `#1437` decision 4: the
 * Colony holds only a hash of the citizen's API key, so it could not seal the
 * addition into `agent_vault` even if that were wanted. The citizen decides what
 * to do with it, and `kolonie.vault.set` is where that decision is written.
 *
 * An addition the Colony cannot open comes back as null rather than as an error.
 * A deployment whose sealing key has changed is the Colony's own fault and it
 * must not turn taking a share back into something the citizen cannot do — the
 * share ends either way, which is what was actually asked for.
 */
export async function unshareVaultEntry(
  db: Database,
  agentId: AgentId,
  key: string,
  sealingKey: string,
): Promise<UnshareVaultEntryOutcome> {
  const [ended] = await db
    .update(vaultShares)
    .set({ takenBackAt: currentTime(), sealedValue: null, sealedDescription: null })
    .where(
      and(
        eq(vaultShares.agentId, agentId),
        eq(vaultShares.vaultKey, key),
        isNull(vaultShares.takenBackAt),
      ),
    )
    .returning({ operatorAddition: vaultShares.operatorAddition })

  if (ended === undefined) return { outcome: 'not-shared' }

  /**
   * **An expired share is still endable, and that is deliberate.** The window
   * governs what a person can read; the addition they wrote before it closed is
   * the citizen's, and refusing to hand it over because the clock ran out would
   * lose the one thing the exchange produced.
   */
  const addition =
    ended.operatorAddition === null
      ? null
      : openVaultValue(sealingKey, String(agentId), additionScope(key), ended.operatorAddition)

  return { outcome: 'unshared', operatorAddition: addition }
}

/**
 * The open share on one entry, or null.
 *
 * **Expiry is in the `where` and not left to the sweep.** A share past its
 * window answers as no share the moment it passes, whether or not anything has
 * run — which is the difference between a promise and a scheduled job.
 */
export async function openShareFor(
  db: Database | Transaction,
  agentId: AgentId,
  key: string,
): Promise<VaultShareRow | null> {
  const [row] = await db
    .select({
      purpose: vaultShares.purpose,
      sharedAt: vaultShares.sharedAt,
      expiresAt: vaultShares.expiresAt,
      operatorAddition: vaultShares.operatorAddition,
    })
    .from(vaultShares)
    .where(
      and(
        eq(vaultShares.agentId, agentId),
        eq(vaultShares.vaultKey, key),
        isNull(vaultShares.takenBackAt),
        sql`${vaultShares.expiresAt} > now()`,
      ),
    )
    .limit(1)

  return row === undefined ? null : shareRow(row)
}

/**
 * Every open share this citizen holds, by entry name.
 *
 * One query for a whole listing rather than one per entry: `VAULT_MAX_ENTRIES`
 * is sixty-four, and a listing that asked the database sixty-four times to
 * answer *which of these can a person read* would be a listing an agent learns
 * not to call.
 */
export async function openSharesFor(
  db: Database | Transaction,
  agentId: AgentId,
): Promise<ReadonlyMap<string, VaultShareRow>> {
  const rows = await db
    .select({
      vaultKey: vaultShares.vaultKey,
      purpose: vaultShares.purpose,
      sharedAt: vaultShares.sharedAt,
      expiresAt: vaultShares.expiresAt,
      operatorAddition: vaultShares.operatorAddition,
    })
    .from(vaultShares)
    .where(
      and(
        eq(vaultShares.agentId, agentId),
        isNull(vaultShares.takenBackAt),
        sql`${vaultShares.expiresAt} > now()`,
      ),
    )
    .orderBy(asc(vaultShares.sharedAt))

  return new Map(rows.map((row) => [row.vaultKey, shareRow(row)]))
}

/**
 * Destroy the copy of every share whose window has passed.
 *
 * `destroyExpiredDrops` in shape, and it keeps the promise `kolonie.vault.share`
 * makes out loud: the copy is gone on the timer whether or not anybody read it.
 *
 * **The row survives without its value**, so *I shared this and it ran out*
 * stays answerable, and so does the operator's addition — which the citizen may
 * still take back afterwards. The read paths above already exclude an expired
 * row, so nothing depends on this having run; what it removes is ciphertext the
 * Colony has no further reason to be holding.
 */
export async function destroyExpiredVaultShares(db: Database): Promise<number> {
  const destroyed = await db
    .update(vaultShares)
    .set({ sealedValue: null, sealedDescription: null })
    .where(
      and(
        isNotNull(vaultShares.sealedValue),
        lte(vaultShares.expiresAt, sql`now()`),
        isNull(vaultShares.takenBackAt),
      ),
    )
    .returning({ id: vaultShares.id })

  return destroyed.length
}

function shareRow(row: {
  readonly purpose: string
  readonly sharedAt: string
  readonly expiresAt: string
  readonly operatorAddition: string | null
}): VaultShareRow {
  return {
    purpose: row.purpose,
    sharedAt: toTimestamp(row.sharedAt),
    expiresAt: toTimestamp(row.expiresAt),
    operatorWrote: row.operatorAddition !== null,
  }
}
