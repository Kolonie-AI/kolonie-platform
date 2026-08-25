import { and, eq, lte, sql } from 'drizzle-orm'
import {
  now as currentTime,
  TRANSFER_MAX_READS,
  TRANSFER_TTL_DAYS,
  keyMaterialFinding,
  type AgentId,
  type CredentialFinding,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { accountTransferReceipts, accountTransfers } from '../schema/account-transfers.js'
import { openVaultValue, sealVaultValue } from '../vault-crypto.js'
import { getVaultEntry, setVaultEntry, vaultHoldsKey } from './vault.js'

/**
 * A credential moving from one citizen's vault to another's (`#1124`).
 *
 * Two acts and no more: one seals a parcel out of the giver's vault, one opens
 * it into the recipient's. There is no tool here — `#1125` offers, `#1126`
 * accepts, and neither contains a line of crypto because all of it is in this
 * file. Opening comes in two shapes for one reason: acceptance is a transaction
 * of five writes and this is two of them, so {@link openAccountTransferIn} runs
 * inside the caller's transaction and {@link openAccountTransfer} is that same
 * call with one of its own around it.
 *
 * **The Colony transports and does not hold.** The parcel is sealed under the
 * deployment key, so neither citizen's key opens what is in flight; the
 * cleartext exists inside {@link openAccountTransfer}'s transaction and nowhere
 * else. Nothing here writes a value unsealed, and nothing here logs one.
 */

/**
 * The label the parcel is bound to inside the envelope.
 *
 * Its own scope, like the handover's, so a ciphertext lifted from a vault row or
 * an operator drop onto a parcel fails to open rather than opening as something
 * else — and the row id makes the label unique per row, so a parcel cannot be
 * moved between parcels either.
 */
const TRANSFER_SCOPE = 'account-transfer'

const scopeFor = (id: string): string => `${TRANSFER_SCOPE}:${id}`

/** The description travels sealed too, under its own suffix for the same reason. */
const descriptionScopeFor = (id: string): string => `${scopeFor(id)}#description`

const TRANSFER_TTL_MS = TRANSFER_TTL_DAYS * 24 * 60 * 60 * 1000

export type SealAccountTransferOutcome =
  | { readonly outcome: 'sealed'; readonly id: string; readonly expiresAt: string }
  /** The deployment has no sealing key, so nothing can be sealed. */
  | { readonly outcome: 'unsealable' }
  /**
   * The giver does not hold that name, or holds it under a key it is no longer
   * presenting.
   *
   * **One answer for both**, following `openVaultValue`'s own rule. They are the
   * same fact to a giver about to hand something over — *what you asked me to
   * send is not something I can read* — and the vault already tells the citizen
   * which of the two it is, through `kolonie.vault.get`, on a call that is not
   * about anybody else.
   */
  | { readonly outcome: 'nothing-to-give' }

/**
 * Take one vault entry of the giver's and seal it for the recipient.
 *
 * **Sealed before it is stored and never after**, so no row ever holds the
 * plaintext. The row id is the label, which means the parcel has to be inserted
 * and then updated with its own ciphertext — the same two-step
 * {@link openHandover} performs, for the same reason: a label that is not unique
 * per row lets a ciphertext be moved between rows.
 *
 * **The giver's entry is not deleted here.** Handing an account over is `#1126`'s
 * act and it is settled at the far end; a giver whose credential vanished the
 * moment it offered it would have lost the account to an offer nobody accepted.
 */
export async function sealAccountTransfer(
  /**
   * A transaction as readily as a connection, so `#1125` can seal the parcel
   * inside the transaction that writes the offer pointing at it. Either both
   * land or neither does; an offer with no parcel means something else here.
   */
  db: Database | Transaction,
  command: {
    readonly fromAgentId: AgentId
    readonly toAgentId: AgentId
    /** The name in the giver's own vault. It is read, and it is not stored. */
    readonly vaultKey: string
  },
  /** The giver's presented API key. Opens its vault entry and nothing else. */
  giverToken: string,
  sealingKey: string | undefined,
): Promise<SealAccountTransferOutcome> {
  if (sealingKey === undefined) return { outcome: 'unsealable' }

  const held = await getVaultEntry(db, giverToken, command.fromAgentId, command.vaultKey)
  if (held.outcome !== 'found') return { outcome: 'nothing-to-give' }

  const expiresAt = new Date(Date.now() + TRANSFER_TTL_MS).toISOString()

  const [row] = await db
    .insert(accountTransfers)
    .values({
      fromAgentId: command.fromAgentId,
      toAgentId: command.toAgentId,
      // A placeholder replaced below, once the row has an id to be labelled
      // with. It is never openable and never returned.
      sealedValue: 'pending',
      expiresAt,
    })
    .returning({ id: accountTransfers.id })

  if (row === undefined) throw new Error('inserting an account transfer returned no row')

  /**
   * **The recipient is the associated data, not the giver.** A parcel sealed for
   * B and presented under C's credential fails authentication rather than
   * yielding a secret, and it fails in the cipher rather than in a `where`
   * clause somebody has to remember to write.
   */
  const recipient = String(command.toAgentId)

  await db
    .update(accountTransfers)
    .set({
      sealedValue: sealVaultValue(sealingKey, recipient, scopeFor(row.id), held.value),
      sealedDescription:
        held.entry.description === null
          ? null
          : sealVaultValue(
              sealingKey,
              recipient,
              descriptionScopeFor(row.id),
              held.entry.description,
            ),
    })
    .where(eq(accountTransfers.id, row.id))

  return { outcome: 'sealed', id: row.id, expiresAt }
}

export type OpenAccountTransferOutcome =
  | {
      readonly outcome: 'settled'
      readonly receiptId: string
      /**
       * Present when the plaintext that landed was a PEM private-key block
       * (`#1685`). **The call still settled.** Accept is a move; refusing it
       * here would consume the parcel and leave the credential nowhere.
       */
      readonly noticed?: CredentialFinding
    }
  /**
   * Expired, already opened, never existed, or not sealed for this citizen.
   *
   * **One answer for all of them**, following the handover's rule: a citizen
   * that guessed an id learns nothing about whether it ever existed, and neither
   * does one holding a parcel meant for somebody else.
   */
  | { readonly outcome: 'closed' }
  /**
   * The recipient already holds that name, and its entry was not touched.
   *
   * Checked before anything is opened, and it is the one refusal that is not
   * folded into `closed` — the recipient is the caller here, the name is one it
   * chose itself a moment ago, and *pick another name* is a repair only it can
   * make. Nothing a giver does may destroy a credential the recipient is relying
   * on; `kolonie.operator.drop.open` states the same rule for its own vault key.
   */
  | { readonly outcome: 'key-taken' }

/**
 * Open the parcel into the recipient's vault, and settle it. **One transaction.**
 *
 * The vault write, the receipt and the deletion of the parcel are one act. A
 * failure at any point leaves the parcel present and unread, so the recipient
 * retries rather than losing a credential to a half-finished move — and the
 * alternative, a parcel consumed by a transaction that then failed to land it,
 * is the one outcome from which there is no recovery at all.
 *
 * **The re-seal goes through {@link setVaultEntry}**, so there is exactly one
 * place in the codebase that constructs a vault envelope.
 */
export async function openAccountTransfer(
  db: Database,
  command: OpenAccountTransferCommand,
  /** The recipient's presented API key. Seals its new vault entry. */
  recipientToken: string,
  sealingKey: string | undefined,
): Promise<OpenAccountTransferOutcome> {
  if (sealingKey === undefined) return { outcome: 'closed' }

  return await db.transaction(
    async (tx) => await openAccountTransferIn(tx, command, recipientToken, sealingKey),
  )
}

export interface OpenAccountTransferCommand {
  readonly transferId: string
  readonly toAgentId: AgentId
  /** The name the **recipient** chooses. It need not be the giver's. */
  readonly vaultKey: string
  /** What moved, copied onto the receipt. Neither is a secret. */
  readonly accountKind: string
  readonly accountIdentifier: string
}

/**
 * The same act, inside a transaction somebody else opened.
 *
 * `#1126` accepts an offer, and accepting is one transaction across five writes
 * of which this is two — so the parcel cannot be opened in a transaction of its
 * own and then be joined to the rest by hope. The whole of {@link
 * openAccountTransfer} is here, and that function is the same call with a
 * transaction around it, so there is still exactly one implementation.
 *
 * **The caller owns the rollback.** A caller that returns a refusal after this
 * has settled must roll its own transaction back, or a parcel is consumed by an
 * act that did not happen.
 */
export async function openAccountTransferIn(
  tx: Transaction,
  command: OpenAccountTransferCommand,
  recipientToken: string,
  /** Not optional here: the absent key is `closed`, and that is the caller's. */
  sealingKey: string,
): Promise<OpenAccountTransferOutcome> {
  const [row] = await tx
    .select({
      id: accountTransfers.id,
      fromAgentId: accountTransfers.fromAgentId,
      toAgentId: accountTransfers.toAgentId,
      sealedValue: accountTransfers.sealedValue,
      sealedDescription: accountTransfers.sealedDescription,
      reads: accountTransfers.reads,
    })
    .from(accountTransfers)
    .where(
      and(
        eq(accountTransfers.id, command.transferId),
        eq(accountTransfers.toAgentId, command.toAgentId),
        sql`${accountTransfers.expiresAt} > now()`,
      ),
    )
    .for('update')
    .limit(1)

  if (row === undefined) return { outcome: 'closed' }
  if (row.reads >= TRANSFER_MAX_READS) return { outcome: 'closed' }

  // Before anything is opened, so a refused name costs the parcel nothing.
  if (await vaultHoldsKey(tx, command.toAgentId, command.vaultKey)) {
    return { outcome: 'key-taken' }
  }

  const recipient = String(row.toAgentId)
  const value = openVaultValue(sealingKey, recipient, scopeFor(row.id), row.sealedValue)
  /**
   * A parcel that will not open is `closed` like every other dead state. It
   * means the deployment's key changed under a live transfer, and telling the
   * recipient *the key rotated* would be telling it about the deployment.
   */
  if (value === null) return { outcome: 'closed' }

  const description =
    row.sealedDescription === null
      ? undefined
      : (openVaultValue(
          sealingKey,
          recipient,
          descriptionScopeFor(row.id),
          row.sealedDescription,
        ) ?? undefined)

  const stored = await setVaultEntry(
    tx,
    recipientToken,
    command.toAgentId,
    command.vaultKey,
    value,
    description,
  )
  /**
   * A full vault is `closed` rather than its own answer, and it is the one
   * place that costs the recipient information. The alternative is worse: a
   * distinct outcome here would have to be produced *after* the parcel has
   * been opened, and every path out of this transaction after that point has
   * to be a rollback.
   */
  if (stored.outcome !== 'stored') throw new Error('the recipient vault would not take it')

  const [receipt] = await tx
    .insert(accountTransferReceipts)
    .values({
      fromAgentId: row.fromAgentId,
      toAgentId: row.toAgentId,
      accountKind: command.accountKind,
      accountIdentifier: command.accountIdentifier,
    })
    .returning({ id: accountTransferReceipts.id })

  if (receipt === undefined) throw new Error('inserting a transfer receipt returned no row')

  /**
   * Marked settled and then deleted in the same statement pair. The mark is
   * not read back in practice — it is there so that a delete which somehow
   * did not happen leaves a row that says what it was, rather than one that
   * looks untouched and would be handed over a second time.
   */
  await tx
    .update(accountTransfers)
    .set({ reads: row.reads + 1, settledAt: currentTime() })
    .where(eq(accountTransfers.id, row.id))

  await tx.delete(accountTransfers).where(eq(accountTransfers.id, row.id))

  const noticed = keyMaterialFinding(value)
  return {
    outcome: 'settled',
    receiptId: receipt.id,
    ...(noticed === null ? {} : { noticed }),
  }
}

/**
 * Delete every parcel whose window has passed.
 *
 * **Deleted and not marked**, which is where this parts company with the
 * handover. A handover keeps its row so that *my operator never read it* stays
 * answerable to the person it concerns. A parcel has a receipt for the case
 * worth remembering, and one that expired unopened is a thing that did not
 * happen — keeping ciphertext nobody can open, to record an absence, would be
 * keeping a liability with no reader.
 */
export async function deleteExpiredAccountTransfers(db: Database): Promise<number> {
  const swept = await db
    .delete(accountTransfers)
    .where(lte(accountTransfers.expiresAt, sql`now()`))
    .returning({ id: accountTransfers.id })

  return swept.length
}
