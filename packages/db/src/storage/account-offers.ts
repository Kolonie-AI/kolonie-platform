import { and, eq, inArray, lte, ne, sql } from 'drizzle-orm'
import { randomBytes } from 'node:crypto'
import {
  OFFER_CONFIRMATION_TTL_SECONDS,
  TRANSFER_TTL_DAYS,
  type AgentId,
  type ConfirmationVerdict,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { accountOfferConfirmations, accountOffers } from '../schema/account-offers.js'
import { accountTransfers } from '../schema/account-transfers.js'
import { accounts } from '../schema/accounts.js'
import { agents } from '../schema/agents.js'
import { sealAccountTransfer } from './account-transfers.js'
import { provedMailbox, provedMailboxes } from './email.js'
import { getVaultEntry } from './vault.js'

/**
 * Offering a spare account to another citizen (`#1125`).
 *
 * Two acts and a sweep: {@link giveAccount} writes the offer and seals the
 * parcel, {@link withdrawAccountOffer} takes both away, and
 * {@link deleteExpiredAccountOffers} removes what nobody came for. Accepting is
 * `#1126` and is not here.
 *
 * **Nothing in this file deletes or alters anything in the giver's vault**, and
 * nothing changes the account being offered. Giving is a thing a citizen says,
 * and only acceptance is a thing that moves.
 */

const TRANSFER_TTL_MS = TRANSFER_TTL_DAYS * 24 * 60 * 60 * 1000

/** Sized like every other single-use value here; see `registration-confirmation.ts`. */
const TOKEN_BYTES = 32

/**
 * Fold a handle to what the confirmation table compares.
 *
 * The rule `agents` compares names with, so a giver that fixed its
 * capitalisation between the two calls named the same citizen both times.
 */
export function offerHandleKey(handle: string): string {
  return handle.trim().toLowerCase()
}

/** One kept account that names the same vault entry. Neither field is a secret. */
export type SharedVaultKeyAccount = {
  readonly kind: string
  readonly identifier: string
}

export type GiveAccountOutcome =
  | {
      readonly outcome: 'offered'
      readonly offerId: string
      /** Echoed **as the giver typed it**, never as the recipient spells it. */
      readonly toHandle: string
      readonly expiresAt: string
      readonly accountKind: string
      readonly accountIdentifier: string
      readonly accountProvider: string | null
    }
  /** The deployment has no sealing key, so no credential can travel. */
  | { readonly outcome: 'unsealable' }
  /** No such account, or not this citizen's. One answer for both, as everywhere. */
  | { readonly outcome: 'unknown-account' }
  /** Decision 3: a declared row is a note to self and there is nothing to hand over. */
  | { readonly outcome: 'not-proved' }
  /** Decision 4: no `vaultKey`, and the fix is two calls. */
  | { readonly outcome: 'no-vault-key' }
  /** The named entry is not one the giver holds, or not one its key opens. */
  | { readonly outcome: 'nothing-to-give' }
  /** Decision 6. Exempt from decision 5: the caller already knows its own handle. */
  | { readonly outcome: 'self' }
  /** Decision 9, naming the open offer so the giver can withdraw it. */
  | {
      readonly outcome: 'already-offered'
      readonly offerId: string
      readonly toHandle: string
      readonly expiresAt: string
    }
  /** Decision 7: the address the Colony writes to, with nowhere else to write. */
  | { readonly outcome: 'reach-mailbox' }
  /** Decision 8: the pause, with the token the second call presents. */
  | {
      readonly outcome: 'confirm'
      readonly token: string
      readonly expiresAt: string
      readonly sharedWith: readonly SharedVaultKeyAccount[]
    }

export type GiveAccountCommand = {
  readonly fromAgentId: AgentId
  readonly accountId: string
  /** A handle, as typed. Resolved case-insensitively, stored and echoed verbatim. */
  readonly toHandle: string
  /** The token from a refused first call, when there is one. */
  readonly confirm?: string | undefined
}

/**
 * Offer one proved account to a handle.
 *
 * ## The order the checks run in is the feature
 *
 * Every refusal above the handle resolution concerns **only the caller's own
 * state** — its account, its vault, its mailboxes, its open offers. That is what
 * makes decision 5 hold: by the time this function looks up whether anybody
 * answers to the handle, there is no refusal left that could depend on the
 * answer. A `nothing-to-give` returned after resolution would tell a caller
 * *this handle exists* every time its own vault was in order, which is exactly
 * the scanner the decision forbids.
 *
 * A handle nobody holds therefore writes a real offer with no parcel: it can be
 * listed, it can be withdrawn, and it expires like any other. From the giver's
 * side the two cases are one case, asserted field by field in the tests.
 */
export async function giveAccount(
  db: Database,
  command: GiveAccountCommand,
  /** The giver's presented API key. Opens its vault entry and nothing else. */
  giverToken: string,
  sealingKey: string | undefined,
): Promise<GiveAccountOutcome> {
  if (sealingKey === undefined) return { outcome: 'unsealable' }

  const [account] = await db
    .select({
      id: accounts.id,
      kind: accounts.kind,
      identifier: accounts.identifier,
      provider: accounts.provider,
      proved: accounts.proved,
      vaultKey: accounts.vaultKey,
    })
    .from(accounts)
    .where(and(eq(accounts.id, command.accountId), eq(accounts.agentId, command.fromAgentId)))
    .limit(1)

  if (account === undefined) return { outcome: 'unknown-account' }
  if (!account.proved) return { outcome: 'not-proved' }

  const vaultKey = account.vaultKey
  if (vaultKey === null || vaultKey.trim() === '') return { outcome: 'no-vault-key' }

  /**
   * Read before anything else is decided, so that a giver whose entry is missing
   * learns it here rather than after the handle has been resolved. The parcel is
   * sealed from a second read inside the transaction below — one place
   * constructs a parcel, and it is `sealAccountTransfer`.
   */
  const held = await getVaultEntry(db, giverToken, command.fromAgentId, vaultKey)
  if (held.outcome !== 'found') return { outcome: 'nothing-to-give' }

  const handleKey = offerHandleKey(command.toHandle)

  const [self] = await db
    .select({ name: agents.name })
    .from(agents)
    .where(eq(agents.id, command.fromAgentId))
    .limit(1)

  if (self !== undefined && offerHandleKey(self.name) === handleKey) return { outcome: 'self' }

  const [open] = await db
    .select({
      id: accountOffers.id,
      toHandle: accountOffers.toHandle,
      expiresAt: accountOffers.expiresAt,
    })
    .from(accountOffers)
    .where(and(eq(accountOffers.accountId, account.id), sql`${accountOffers.expiresAt} > now()`))
    .limit(1)

  if (open !== undefined) {
    return {
      outcome: 'already-offered',
      offerId: open.id,
      toHandle: open.toHandle,
      expiresAt: open.expiresAt,
    }
  }

  if (await givingAwayTheOnlyReachAddress(db, command.fromAgentId, account)) {
    return { outcome: 'reach-mailbox' }
  }

  const sharedWith = await accountsSharingVaultKey(db, command.fromAgentId, account.id, vaultKey)

  if (sharedWith.length > 0) {
    const confirmed =
      command.confirm === undefined
        ? false
        : (await spendOfferConfirmation(db, {
            agentId: command.fromAgentId,
            accountId: account.id,
            toHandleKey: handleKey,
            token: command.confirm,
          })) === 'confirmed'

    if (!confirmed) {
      /**
       * A token that did not confirm is treated exactly as no token: the caller
       * is refused and handed a fresh one. A separate *that token was no good*
       * branch would be a second thing to get right for no gain — the repair is
       * the same either way, and the acceptance criterion that a token from a
       * different call does not work is this line.
       */
      const minted = await mintOfferConfirmation(db, {
        agentId: command.fromAgentId,
        accountId: account.id,
        toHandleKey: handleKey,
      })
      return { outcome: 'confirm', ...minted, sharedWith }
    }
  }

  /**
   * Resolved last, and never refused on. Everything above has already decided
   * that this call is allowed to write an offer; what the handle resolves to
   * decides only whether there is a parcel to attach.
   */
  const [recipient] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(sql`lower(${agents.name}) = ${handleKey}`)
    .limit(1)

  return await db.transaction(async (tx) => {
    /**
     * Expired offers for this account go first, in the same transaction. That is
     * what lets `account_offers_one_per_account` be a plain unique index: a
     * partial one cannot be predicated on `now()`, so the row that survives here
     * has to be one that is genuinely still open.
     */
    await sweepExpiredOffersFor(tx, account.id)

    let transferId: string | null = null
    let expiresAt = new Date(Date.now() + TRANSFER_TTL_MS).toISOString()

    if (recipient !== undefined) {
      const sealed = await sealAccountTransfer(
        tx,
        { fromAgentId: command.fromAgentId, toAgentId: recipient.id as AgentId, vaultKey },
        giverToken,
        sealingKey,
      )
      /**
       * The vault was read at the top of this function, so the entry is there
       * and it opens. A parcel that will not seal now is a fault rather than an
       * answer, and rolling back is the only correct response to it: an offer
       * pointing at nothing would be indistinguishable from decision 5's offer
       * to nobody, and it would be handed to a citizen that cannot open it.
       */
      if (sealed.outcome !== 'sealed')
        throw new Error(`the parcel would not seal: ${sealed.outcome}`)

      transferId = sealed.id
      // Decision 12: the offer takes the parcel's expiry rather than a second one.
      expiresAt = sealed.expiresAt
    }

    const [offer] = await tx
      .insert(accountOffers)
      .values({
        fromAgentId: command.fromAgentId,
        accountId: account.id,
        toHandle: command.toHandle,
        toAgentId: recipient?.id ?? null,
        transferId,
        accountKind: account.kind,
        accountIdentifier: account.identifier,
        accountProvider: account.provider,
        expiresAt,
      })
      .returning({ id: accountOffers.id, expiresAt: accountOffers.expiresAt })

    if (offer === undefined) throw new Error('inserting an account offer returned no row')

    return {
      outcome: 'offered',
      offerId: offer.id,
      toHandle: command.toHandle,
      expiresAt: offer.expiresAt,
      accountKind: account.kind,
      accountIdentifier: account.identifier,
      accountProvider: account.provider,
    }
  })
}

/**
 * Decision 7: is this the address the Colony writes to, with no second one?
 *
 * The reach address is `email_challenges.primary_at` and not
 * `accounts.preferred` — D-047 put the obligation there and the account
 * register's own check constraint refuses a second answer. Comparison is folded,
 * because an address is not case-sensitive in the half that matters and a giver
 * that recorded `Handle@example` for the mailbox it proved as `handle@example`
 * would otherwise slip past a rule about reachability on a capital letter.
 */
async function givingAwayTheOnlyReachAddress(
  db: Database,
  agentId: AgentId,
  account: { readonly kind: string; readonly identifier: string },
): Promise<boolean> {
  if (account.kind !== 'mailbox') return false

  const reach = await provedMailbox(db, agentId)
  if (reach === undefined) return false
  if (reach.address.trim().toLowerCase() !== account.identifier.trim().toLowerCase()) return false

  const proved = await provedMailboxes(db, agentId)
  return proved.length < 2
}

/** Decision 8: which other accounts of the giver's name the same vault entry. */
async function accountsSharingVaultKey(
  db: Database,
  agentId: AgentId,
  accountId: string,
  vaultKey: string,
): Promise<readonly SharedVaultKeyAccount[]> {
  return await db
    .select({ kind: accounts.kind, identifier: accounts.identifier })
    .from(accounts)
    .where(
      and(
        eq(accounts.agentId, agentId),
        eq(accounts.vaultKey, vaultKey),
        ne(accounts.id, accountId),
      ),
    )
}

async function mintOfferConfirmation(
  db: Database,
  of: { readonly agentId: AgentId; readonly accountId: string; readonly toHandleKey: string },
): Promise<{ token: string; expiresAt: string }> {
  const token = randomBytes(TOKEN_BYTES).toString('base64url')
  const expiresAt = new Date(Date.now() + OFFER_CONFIRMATION_TTL_SECONDS * 1000).toISOString()

  await db.insert(accountOfferConfirmations).values({
    agentId: of.agentId,
    accountId: of.accountId,
    toHandleKey: of.toHandleKey,
    token,
    expiresAt,
  })

  return { token, expiresAt }
}

/**
 * Spend a token against the call it was minted for.
 *
 * The row is locked before it is read, so two calls racing one token see
 * `confirmed` and `spent` rather than both seeing `confirmed`. A token presented
 * for a different account or a different handle is **not** consumed, on
 * `registration-confirmation.ts`'s reasoning: the call it was minted for has not
 * happened yet, and destroying it would cost a giver that pasted the wrong token
 * a pause it did not earn.
 */
async function spendOfferConfirmation(
  db: Database,
  presented: {
    readonly agentId: AgentId
    readonly accountId: string
    readonly toHandleKey: string
    readonly token: string
  },
): Promise<ConfirmationVerdict> {
  return await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(accountOfferConfirmations)
      .where(eq(accountOfferConfirmations.token, presented.token))
      .for('update')
      .limit(1)

    if (row === undefined) return 'unknown'
    if (
      row.agentId !== presented.agentId ||
      row.accountId !== presented.accountId ||
      row.toHandleKey !== presented.toHandleKey
    ) {
      return 'other-name'
    }
    if (row.consumedAt !== null) return 'spent'

    await tx
      .update(accountOfferConfirmations)
      .set({ consumedAt: sql`now()` })
      .where(eq(accountOfferConfirmations.id, row.id))

    return new Date(row.expiresAt).getTime() <= Date.now() ? 'expired' : 'confirmed'
  })
}

export type WithdrawAccountOfferOutcome =
  | { readonly outcome: 'withdrawn' }
  /** No such offer, or not this citizen's. One answer for both. */
  | { readonly outcome: 'unknown' }

/**
 * Take an offer back, parcel and all (decision 11).
 *
 * **Costs nothing and is recorded nowhere.** Changing your mind about a gift is
 * not something the Colony has any business pricing, so there is no receipt, no
 * counter and no mark — the row simply stops existing.
 *
 * The offer is deleted before the parcel, though the cascade would take it
 * either way. Written in the order that reads as what it is: the offer is the
 * thing being withdrawn, and the parcel is what it was carrying.
 */
export async function withdrawAccountOffer(
  db: Database,
  command: { readonly offerId: string; readonly fromAgentId: AgentId },
): Promise<WithdrawAccountOfferOutcome> {
  return await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: accountOffers.id, transferId: accountOffers.transferId })
      .from(accountOffers)
      .where(
        and(
          eq(accountOffers.id, command.offerId),
          eq(accountOffers.fromAgentId, command.fromAgentId),
        ),
      )
      .for('update')
      .limit(1)

    if (row === undefined) return { outcome: 'unknown' }

    await tx.delete(accountOffers).where(eq(accountOffers.id, row.id))

    if (row.transferId !== null) {
      await tx.delete(accountTransfers).where(eq(accountTransfers.id, row.transferId))
    }

    return { outcome: 'withdrawn' }
  })
}

/**
 * Delete every offer whose window has passed, and the parcels they carried.
 *
 * Both halves here rather than relying on `deleteExpiredAccountTransfers` to
 * catch the parcels: the two share a clock today, and a sweep that only works
 * because a second sweep runs on the same schedule is one that breaks quietly
 * the day either schedule moves.
 */
export async function deleteExpiredAccountOffers(db: Database): Promise<number> {
  return await db.transaction(async (tx) => {
    const swept = await tx
      .delete(accountOffers)
      .where(lte(accountOffers.expiresAt, sql`now()`))
      .returning({ id: accountOffers.id, transferId: accountOffers.transferId })

    const parcels = swept.flatMap((row) => (row.transferId === null ? [] : [row.transferId]))
    if (parcels.length > 0) {
      await tx.delete(accountTransfers).where(inArray(accountTransfers.id, parcels))
    }

    return swept.length
  })
}

/** The same sweep, narrowed to one account, run inside `give`'s own transaction. */
async function sweepExpiredOffersFor(tx: Transaction, accountId: string): Promise<void> {
  const swept = await tx
    .delete(accountOffers)
    .where(and(eq(accountOffers.accountId, accountId), lte(accountOffers.expiresAt, sql`now()`)))
    .returning({ transferId: accountOffers.transferId })

  const parcels = swept.flatMap((row) => (row.transferId === null ? [] : [row.transferId]))
  if (parcels.length > 0) {
    await tx.delete(accountTransfers).where(inArray(accountTransfers.id, parcels))
  }
}
