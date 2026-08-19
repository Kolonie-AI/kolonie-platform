import { and, eq, inArray, lte, ne, sql } from 'drizzle-orm'
import { randomBytes, randomUUID } from 'node:crypto'
import {
  AccountKindSchema,
  OFFER_CONFIRMATION_TTL_SECONDS,
  RELATED_ACCOUNTS_MAX,
  TRANSFER_TTL_DAYS,
  type AgentId,
  type ConfirmationVerdict,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { accountOfferOutcomes } from '../schema/account-offer-outcomes.js'
import { accountOfferConfirmations, accountOffers } from '../schema/account-offers.js'
import { accountTransfers } from '../schema/account-transfers.js'
import { accounts } from '../schema/accounts.js'
import { agents } from '../schema/agents.js'
import { openAccountTransferIn, sealAccountTransfer } from './account-transfers.js'
import { closeWalkOnTransfer } from './account-walks.js'
import { provedMailbox, provedMailboxes } from './email.js'
import { getVaultEntry, markVaultEntrySpent } from './vault.js'

/**
 * Offering a spare account to another citizen (`#1125`).
 *
 * The giver's side: {@link giveAccount} writes the offer and seals the parcel,
 * {@link withdrawAccountOffer} takes both away, and
 * {@link deleteExpiredAccountOffers} removes what nobody came for. The
 * recipient's side is `#1126`: {@link offersTo} lists them,
 * {@link acceptAccountOffer} is the one act here that moves an account, and
 * {@link declineAccountOffer} is the one that costs nothing.
 *
 * **Nothing on the giver's side deletes anything in the giver's vault**, and
 * nothing there changes the account being offered. Giving is a thing a citizen
 * says; accepting is the thing that moves — and the one thing it moves in the
 * giver's vault is a flag: the entry behind a transferred account is marked
 * spent (`#1214`), never emptied.
 */

const TRANSFER_TTL_MS = TRANSFER_TTL_DAYS * 24 * 60 * 60 * 1000

/** Sized like every other single-use value here; see `registration-confirmation.ts`. */
const TOKEN_BYTES = 32

/** What ending an offer leaves behind for the citizen that made it (`#1215`). */
type OfferOutcomeRow = {
  readonly fromAgentId: string
  readonly offerId: string
  readonly toHandle: string
  readonly accountKind: string
  readonly accountIdentifier: string
  readonly accountProvider: string | null
}

/**
 * Write the receipt, in the same transaction as the ending it is a receipt for
 * (`#1215`).
 *
 * Every terminal path here deletes the offer row, so this is the only thing left
 * saying the offer ever ended rather than never having been. It is written
 * beside the delete rather than after it: a receipt that can be lost while the
 * act it records succeeds is the silence this exists to close.
 *
 * `at` is passed rather than defaulted for the expiry paths, which end an offer
 * at the moment its window closed and not at the moment something got round to
 * sweeping it — see the schema for why that is what makes the digest idempotent.
 */
async function recordOfferOutcome(
  tx: Transaction,
  rows: readonly OfferOutcomeRow[],
  outcome: 'accepted' | 'declined' | 'expired' | 'withdrawn',
  at?: readonly string[],
): Promise<void> {
  if (rows.length === 0) return

  await tx.insert(accountOfferOutcomes).values(
    rows.map((row, index) => ({
      fromAgentId: row.fromAgentId,
      offerId: row.offerId,
      toHandle: row.toHandle,
      accountKind: row.accountKind,
      accountIdentifier: row.accountIdentifier,
      accountProvider: row.accountProvider,
      outcome,
      ...(at === undefined ? {} : { at: at[index] }),
    })),
  )
}

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

/** One account that travels with the primary (`#1217`). Nothing here is a secret. */
export type OfferedRelatedAccount = {
  readonly kind: string
  readonly identifier: string
  readonly provider: string | null
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
      /** Companions that move with this offer (`#1217`). Empty for a single gift. */
      readonly related: readonly OfferedRelatedAccount[]
    }
  /** The deployment has no sealing key, so no credential can travel. */
  | { readonly outcome: 'unsealable' }
  /** No such account, or not this citizen's. One answer for both, as everywhere. */
  | { readonly outcome: 'unknown-account' }
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
  /**
   * A related id named the primary, named itself twice, or named more than
   * {@link RELATED_ACCOUNTS_MAX} companions (`#1217`).
   */
  | { readonly outcome: 'related-invalid' }

export type GiveAccountCommand = {
  readonly fromAgentId: AgentId
  readonly accountId: string
  /** A handle, as typed. Resolved case-insensitively, stored and echoed verbatim. */
  readonly toHandle: string
  /** The token from a refused first call, when there is one. */
  readonly confirm?: string | undefined
  /**
   * Further accounts of the giver's that travel with this one (`#1217`).
   *
   * Accept moves every one of them or none. Distinct vaultKeys each get their
   * own parcel; a vaultKey shared inside the set shares one parcel. Accounts
   * outside the set that share a vaultKey still trip the confirm pause.
   */
  readonly relatedAccountIds?: readonly string[] | undefined
}

/**
 * Offer one account of yours to a handle.
 *
 * ## What is being moved is custody, and not a verdict (`#1213`)
 *
 * Decision 3 used to refuse a declared row here, on the reasoning that it is a
 * note the giver wrote to itself and the recipient would get the note rather
 * than the account. That is true of a row with no `vaultKey` and false of one
 * with a credential behind it: a citizen that bought a mailbox, logged into it
 * and stored what opens it holds the account in every sense that matters to the
 * citizen receiving it, whether or not the Colony has checked the claim.
 *
 * So the gate is the credential and not the proof. `vaultKey` names an entry,
 * the entry opens with the giver's own key, and what travels is what is in it —
 * the same three conditions a proved give has always had, minus the one that
 * was measuring something else. Proof stays where it was earned: the recipient's
 * row arrives `proved: false` either way (`acceptAccountOffer`), and nothing
 * that gates on proved is reachable through a transfer.
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

  /**
   * Primary first, then the companions (`#1217`). Duplicates of the primary or of
   * each other, and a list past the bound, are `related-invalid` rather than a
   * silent drop — a giver that meant two accounts and named three by accident
   * should hear about the third, not watch two of them move alone.
   */
  const relatedIds = command.relatedAccountIds ?? []
  if (relatedIds.length > RELATED_ACCOUNTS_MAX) return { outcome: 'related-invalid' }
  const seen = new Set<string>([command.accountId])
  for (const id of relatedIds) {
    if (seen.has(id)) return { outcome: 'related-invalid' }
    seen.add(id)
  }
  const allIds = [command.accountId, ...relatedIds]

  const loaded = await db
    .select({
      id: accounts.id,
      kind: accounts.kind,
      identifier: accounts.identifier,
      provider: accounts.provider,
      vaultKey: accounts.vaultKey,
    })
    .from(accounts)
    .where(and(inArray(accounts.id, allIds), eq(accounts.agentId, command.fromAgentId)))

  if (loaded.length !== allIds.length) return { outcome: 'unknown-account' }

  // Preserve the caller's order: primary first, then related as named.
  const byId = new Map(loaded.map((row) => [row.id, row]))
  const set = allIds.map((id) => {
    const row = byId.get(id)
    if (row === undefined) throw new Error('giveAccount: loaded id missing from map')
    return row
  })
  const primary = set[0]!

  for (const account of set) {
    if (account.vaultKey === null || account.vaultKey.trim() === '') {
      return { outcome: 'no-vault-key' }
    }
  }

  /**
   * Read before anything else is decided, so that a giver whose entry is missing
   * learns it here rather than after the handle has been resolved. The parcel is
   * sealed from a second read inside the transaction below — one place
   * constructs a parcel, and it is `sealAccountTransfer`. One read per distinct
   * vaultKey: two accounts that share a credential open the same entry once.
   */
  const vaultKeysChecked = new Set<string>()
  for (const account of set) {
    const vaultKey = account.vaultKey!
    if (vaultKeysChecked.has(vaultKey)) continue
    vaultKeysChecked.add(vaultKey)
    const held = await getVaultEntry(db, giverToken, command.fromAgentId, vaultKey)
    if (held.outcome !== 'found') return { outcome: 'nothing-to-give' }
  }

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
    .where(and(inArray(accountOffers.accountId, allIds), sql`${accountOffers.expiresAt} > now()`))
    .limit(1)

  if (open !== undefined) {
    return {
      outcome: 'already-offered',
      offerId: open.id,
      toHandle: open.toHandle,
      expiresAt: open.expiresAt,
    }
  }

  for (const account of set) {
    if (await givingAwayTheOnlyReachAddress(db, command.fromAgentId, account)) {
      return { outcome: 'reach-mailbox' }
    }
  }

  /**
   * Decision 8, scoped to the set (`#1217`): a vaultKey shared only with
   * accounts that are travelling too is not a surprise — the giver named them.
   * What still pauses the call is a vaultKey that also opens an account the
   * giver is *keeping*.
   */
  const setIdSet = new Set(allIds)
  const sharedOutside: SharedVaultKeyAccount[] = []
  const vaultKeysForConfirm = new Set<string>()
  for (const account of set) {
    const vaultKey = account.vaultKey!
    if (vaultKeysForConfirm.has(vaultKey)) continue
    vaultKeysForConfirm.add(vaultKey)
    const sharing = await db
      .select({
        id: accounts.id,
        kind: accounts.kind,
        identifier: accounts.identifier,
      })
      .from(accounts)
      .where(
        and(
          eq(accounts.agentId, command.fromAgentId),
          eq(accounts.vaultKey, vaultKey),
          ne(accounts.id, account.id),
        ),
      )
    for (const other of sharing) {
      if (!setIdSet.has(other.id)) {
        sharedOutside.push({ kind: other.kind, identifier: other.identifier })
      }
    }
  }

  if (sharedOutside.length > 0) {
    const confirmed =
      command.confirm === undefined
        ? false
        : (await spendOfferConfirmation(db, {
            agentId: command.fromAgentId,
            accountId: primary.id,
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
        accountId: primary.id,
        toHandleKey: handleKey,
      })
      return { outcome: 'confirm', ...minted, sharedWith: sharedOutside }
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
     * Expired offers for every account in the set go first, in the same
     * transaction. That is what lets `account_offers_one_per_account` be a
     * plain unique index: a partial one cannot be predicated on `now()`, so the
     * row that survives here has to be one that is genuinely still open.
     */
    for (const account of set) {
      await sweepExpiredOffersFor(tx, account.id)
    }

    /**
     * One parcel per distinct vaultKey (`#1217`). Two accounts that share a
     * credential share the parcel; accepting opens it once and both rows land
     * under the vaultKey the recipient chose for that credential.
     */
    const transferByVaultKey = new Map<string, { id: string; expiresAt: string }>()
    let expiresAt = new Date(Date.now() + TRANSFER_TTL_MS).toISOString()

    if (recipient !== undefined) {
      for (const account of set) {
        const vaultKey = account.vaultKey!
        if (transferByVaultKey.has(vaultKey)) continue
        const sealed = await sealAccountTransfer(
          tx,
          {
            fromAgentId: command.fromAgentId,
            toAgentId: recipient.id as AgentId,
            vaultKey,
          },
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
        if (sealed.outcome !== 'sealed') {
          throw new Error(`the parcel would not seal: ${sealed.outcome}`)
        }
        transferByVaultKey.set(vaultKey, { id: sealed.id, expiresAt: sealed.expiresAt })
        // Decision 12: the offer takes the parcel's expiry rather than a second one.
        expiresAt = sealed.expiresAt
      }
    }

    /**
     * A set of one keeps `setId` null, so the single-account shape is unchanged
     * for every reader that never asked about companions. Two or more share one
     * uuid minted here — there is no parent row; the uuid *is* the set.
     */
    const setId = set.length > 1 ? randomUUID() : null

    const inserted: { id: string; expiresAt: string }[] = []
    for (const account of set) {
      const transferId =
        recipient === undefined ? null : (transferByVaultKey.get(account.vaultKey!)?.id ?? null)
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
          setId,
        })
        .returning({ id: accountOffers.id, expiresAt: accountOffers.expiresAt })

      if (offer === undefined) throw new Error('inserting an account offer returned no row')
      inserted.push(offer)
    }

    const primaryOffer = inserted[0]!
    return {
      outcome: 'offered' as const,
      offerId: primaryOffer.id,
      toHandle: command.toHandle,
      expiresAt: primaryOffer.expiresAt,
      accountKind: primary.kind,
      accountIdentifier: primary.identifier,
      accountProvider: primary.provider,
      related: set.slice(1).map((account) => ({
        kind: account.kind,
        identifier: account.identifier,
        provider: account.provider,
      })),
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
 * **Costs nothing, and the only thing it is recorded in is the giver's own
 * history.** Changing your mind about a gift is not something the Colony has any
 * business pricing: there is no counter, no mark, and nothing about it reaches
 * the citizen it was held out to or anybody else. What `#1215` adds is a line in
 * the giver's own receipts, so that an offer that is no longer there answers the
 * same question in all four of the ways it can end.
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
      .select({
        id: accountOffers.id,
        transferId: accountOffers.transferId,
        setId: accountOffers.setId,
        toHandle: accountOffers.toHandle,
        accountKind: accountOffers.accountKind,
        accountIdentifier: accountOffers.accountIdentifier,
        accountProvider: accountOffers.accountProvider,
      })
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

    /**
     * Withdrawing any member takes the whole set (`#1217`). The siblings share
     * the giver's decision; leaving one open would be the split this exists to
     * refuse.
     */
    const set =
      row.setId === null
        ? [row]
        : await tx
            .select({
              id: accountOffers.id,
              transferId: accountOffers.transferId,
              setId: accountOffers.setId,
              toHandle: accountOffers.toHandle,
              accountKind: accountOffers.accountKind,
              accountIdentifier: accountOffers.accountIdentifier,
              accountProvider: accountOffers.accountProvider,
            })
            .from(accountOffers)
            .where(
              and(
                eq(accountOffers.setId, row.setId),
                eq(accountOffers.fromAgentId, command.fromAgentId),
              ),
            )
            .for('update')

    const offerIds = set.map((member) => member.id)
    await tx.delete(accountOffers).where(inArray(accountOffers.id, offerIds))

    const parcels = [
      ...new Set(set.flatMap((member) => (member.transferId === null ? [] : [member.transferId]))),
    ]
    if (parcels.length > 0) {
      await tx.delete(accountTransfers).where(inArray(accountTransfers.id, parcels))
    }

    await recordOfferOutcome(
      tx,
      set.map((member) => ({
        ...member,
        fromAgentId: command.fromAgentId,
        offerId: member.id,
      })),
      'withdrawn',
    )

    return { outcome: 'withdrawn' }
  })
}

/** One open offer, as the citizen it is addressed to reads it (`#1126`). */
export type OfferedAccount = {
  readonly offerId: string
  /** Who is holding it out, by handle. The giver is named; nothing else is. */
  readonly fromHandle: string
  readonly accountKind: string
  readonly accountIdentifier: string
  readonly accountProvider: string | null
  readonly expiresAt: string
  /** Companions that travel with this offer (`#1217`). Empty for a single gift. */
  readonly related: readonly OfferedRelatedAccount[]
}

/**
 * What is being held out to this citizen right now (decision 4).
 *
 * Only live offers, and only ones with a parcel behind them — an offer whose
 * `toAgentId` is this citizen always has one, because the schema refuses the
 * other combination. Ordered oldest first, which is the order they expire in.
 */
export async function offersTo(
  db: Database,
  toAgentId: AgentId,
  /**
   * How many to take, oldest first. The wake-up asks for one — the `open` list
   * holds five things and an offer is not more important than the board — and a
   * caller that wants them all leaves this out.
   *
   * **Counts sets, not rows** (`#1217`). A three-account offer is one thing to
   * decide about, so it costs one of `take` and appears once with its companions
   * under `related`.
   */
  take?: number,
): Promise<readonly OfferedAccount[]> {
  const rows = await db
    .select({
      offerId: accountOffers.id,
      fromHandle: agents.name,
      accountKind: accountOffers.accountKind,
      accountIdentifier: accountOffers.accountIdentifier,
      accountProvider: accountOffers.accountProvider,
      expiresAt: accountOffers.expiresAt,
      setId: accountOffers.setId,
      createdAt: accountOffers.createdAt,
    })
    .from(accountOffers)
    .innerJoin(agents, eq(agents.id, accountOffers.fromAgentId))
    .where(and(eq(accountOffers.toAgentId, toAgentId), sql`${accountOffers.expiresAt} > now()`))
    .orderBy(accountOffers.createdAt)

  /**
   * Collapse siblings onto the oldest row of each set. A set's rows share one
   * `createdAt` only by coincidence of the insert loop; ordering by `createdAt`
   * then by primary-first insert order keeps the primary as the listed row.
   */
  const listed: OfferedAccount[] = []
  const seenSets = new Set<string>()
  for (const row of rows) {
    if (row.setId !== null) {
      if (seenSets.has(row.setId)) continue
      seenSets.add(row.setId)
      const siblings = rows.filter(
        (other) => other.setId === row.setId && other.offerId !== row.offerId,
      )
      listed.push({
        offerId: row.offerId,
        fromHandle: row.fromHandle,
        accountKind: row.accountKind,
        accountIdentifier: row.accountIdentifier,
        accountProvider: row.accountProvider,
        expiresAt: row.expiresAt,
        related: siblings.map((sibling) => ({
          kind: sibling.accountKind,
          identifier: sibling.accountIdentifier,
          provider: sibling.accountProvider,
        })),
      })
    } else {
      listed.push({
        offerId: row.offerId,
        fromHandle: row.fromHandle,
        accountKind: row.accountKind,
        accountIdentifier: row.accountIdentifier,
        accountProvider: row.accountProvider,
        expiresAt: row.expiresAt,
        related: [],
      })
    }
    if (take !== undefined && listed.length >= take) break
  }

  return listed
}

/** One account that arrived with an accepted offer (`#1217`). */
export type AcceptedRelatedAccount = {
  readonly accountId: string
  readonly kind: string
  readonly identifier: string
  readonly provider: string | null
  readonly vaultKey: string
}

export type AcceptAccountOfferOutcome =
  | {
      readonly outcome: 'accepted'
      /** The recipient's new row, which is a different row from the giver's. */
      readonly accountId: string
      readonly accountKind: string
      readonly accountIdentifier: string
      readonly accountProvider: string | null
      readonly vaultKey: string
      readonly fromHandle: string
      /** Companions that moved with it (`#1217`). Empty for a single gift. */
      readonly related: readonly AcceptedRelatedAccount[]
    }
  /**
   * No such offer, not addressed to this citizen, expired, or the giver has
   * since been erased. **One answer for all of them**, following the parcel's
   * own rule: an offer id is a uuid somebody could guess at, and a citizen that
   * guessed one learns nothing about whether it ever existed.
   */
  | { readonly outcome: 'unknown' }
  /** The recipient already holds that vault name, and its entry was not touched. */
  | { readonly outcome: 'key-taken' }
  /** The recipient already holds an account of that kind under that identifier. */
  | { readonly outcome: 'already-held' }
  /**
   * Accept named vault keys that do not cover every distinct parcel in the set
   * (`#1217`). The offer is untouched; nothing moved.
   */
  | {
      readonly outcome: 'keys-incomplete'
      /** How many distinct credentials the set carries. */
      readonly needed: number
      /** How many vault keys the recipient named. */
      readonly named: number
    }

/**
 * Take the account. **One transaction, five writes** (decision 5).
 *
 * The parcel opens into the recipient's vault, the recipient's account row is
 * written, the receipt is written, the giver's row is deleted and the offer goes
 * with it. A failure anywhere leaves all five undone, so the recipient retries
 * against an offer that is still open rather than owning half a move.
 *
 * ## What arrives, and what does not
 *
 * The row is `proved: false` with no `provedBy`, no `provedAt` and no
 * capabilities (decision 6): proof is a thing the Colony checked about a citizen,
 * and it did not check it about this one. Nothing that is a *choice* travels
 * either (decision 7) — `attestable`, `shownOnProfile`, `preferred` and `forWork`
 * all arrive false, because the giver's answer to *may a stranger ask about this*
 * is not the recipient's answer. Only `kind`, `identifier` and `provider` are
 * copied, and the vault name is the recipient's own (decisions 8 and 9).
 *
 * **The giver's row is deleted and not retired** (decision 10). A retired row
 * would say *this citizen held this account and stopped*, which is true of a
 * citizen that lost a mailbox and false of one that handed it over; the thread
 * hanging off it cascades away with it (decision 11).
 *
 * **The giver's own vault entry keeps its bytes and stops answering with them**
 * (decision 12, as `#1214` corrects it). It used to be left untouched, which
 * left the giver holding a credential the register said it still had and the
 * world said it did not. Nothing is deleted — a vault another citizen's act can
 * empty is not the vault D-043 describes — but `kolonie.vault.get` answers
 * `spent` instead of the secret, and only when no other account of the giver's
 * still names that entry.
 */
export async function acceptAccountOffer(
  db: Database,
  command: {
    readonly offerId: string
    readonly toAgentId: AgentId
    /**
     * Where the **primary** credential lands in the recipient's vault. Companions
     * that share that credential land under the same name (`#1217`).
     */
    readonly vaultKey: string
    /**
     * Where each companion's credential lands, in the same order `offersTo`
     * lists `related` (`#1217`). Required when a companion carries a different
     * vaultKey from the primary; companions that share the primary's credential
     * may repeat `vaultKey` or be omitted only when every companion shares it.
     */
    readonly relatedVaultKeys?: readonly string[] | undefined
  },
  /** The recipient's presented API key. Seals its new vault entry and nothing else. */
  recipientToken: string,
  sealingKey: string | undefined,
): Promise<AcceptAccountOfferOutcome> {
  if (sealingKey === undefined) return { outcome: 'unknown' }

  return await db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        id: accountOffers.id,
        fromAgentId: accountOffers.fromAgentId,
        fromHandle: agents.name,
        /** The giver's own word for who this was for, for the giver's receipt (`#1215`). */
        toHandle: accountOffers.toHandle,
        accountId: accountOffers.accountId,
        transferId: accountOffers.transferId,
        setId: accountOffers.setId,
        accountKind: accountOffers.accountKind,
        accountIdentifier: accountOffers.accountIdentifier,
        accountProvider: accountOffers.accountProvider,
        createdAt: accountOffers.createdAt,
      })
      .from(accountOffers)
      .innerJoin(agents, eq(agents.id, accountOffers.fromAgentId))
      .where(
        and(
          eq(accountOffers.id, command.offerId),
          eq(accountOffers.toAgentId, command.toAgentId),
          sql`${accountOffers.expiresAt} > now()`,
        ),
      )
      .for('update', { of: accountOffers })
      .limit(1)

    if (row === undefined) return { outcome: 'unknown' }
    // The schema refuses an addressed offer without one; belt and braces.
    if (row.transferId === null) return { outcome: 'unknown' }

    /**
     * The whole set, oldest first so the primary stays primary (`#1217`). Locked
     * together: accepting one sibling without the others is exactly the split
     * this exists to refuse.
     */
    const setRows =
      row.setId === null
        ? [row]
        : await tx
            .select({
              id: accountOffers.id,
              fromAgentId: accountOffers.fromAgentId,
              fromHandle: agents.name,
              toHandle: accountOffers.toHandle,
              accountId: accountOffers.accountId,
              transferId: accountOffers.transferId,
              setId: accountOffers.setId,
              accountKind: accountOffers.accountKind,
              accountIdentifier: accountOffers.accountIdentifier,
              accountProvider: accountOffers.accountProvider,
              createdAt: accountOffers.createdAt,
            })
            .from(accountOffers)
            .innerJoin(agents, eq(agents.id, accountOffers.fromAgentId))
            .where(
              and(
                eq(accountOffers.setId, row.setId),
                eq(accountOffers.toAgentId, command.toAgentId),
                sql`${accountOffers.expiresAt} > now()`,
              ),
            )
            .for('update', { of: accountOffers })
            .orderBy(accountOffers.createdAt)

    // The named offer must still be in the locked set — a race that withdrew a
    // sibling between the two selects would leave a partial set, which we refuse.
    if (!setRows.some((member) => member.id === row.id)) return { outcome: 'unknown' }
    if (setRows.some((member) => member.transferId === null)) return { outcome: 'unknown' }

    /**
     * Read from the accounts rather than from the offer's copies. The copies are
     * what the recipient was *shown*; these rows are what is actually moving, and
     * `kolonie.accounts.set` can have changed the provider in between.
     */
    const accountIds = setRows.map((member) => member.accountId)
    const accountRows = await tx
      .select({
        id: accounts.id,
        kind: accounts.kind,
        identifier: accounts.identifier,
        provider: accounts.provider,
        vaultKey: accounts.vaultKey,
      })
      .from(accounts)
      .where(inArray(accounts.id, accountIds))
      .for('update')

    if (accountRows.length !== setRows.length) return { outcome: 'unknown' }
    const accountById = new Map(accountRows.map((account) => [account.id, account]))

    // Primary first (the named offer), then the rest in createdAt order with the
    // primary filtered out — matches what `offersTo` puts under `related`.
    const ordered = [
      setRows.find((member) => member.id === row.id)!,
      ...setRows.filter((member) => member.id !== row.id),
    ]
    const relatedMembers = ordered.slice(1)

    /**
     * One recipient vault name per distinct source credential (`#1217`).
     * Companions that share the primary's credential reuse `vaultKey`; each
     * further credential needs its own name, parallel to `related`.
     */
    const primaryAccount = accountById.get(row.accountId)
    if (primaryAccount === undefined || primaryAccount.vaultKey === null) {
      return { outcome: 'unknown' }
    }
    const recipientKeyBySource = new Map<string, string>()
    recipientKeyBySource.set(primaryAccount.vaultKey, command.vaultKey)

    const distinctSourceKeys = new Set(
      accountRows
        .map((account) => account.vaultKey)
        .filter((key): key is string => key !== null && key.trim() !== ''),
    )
    const relatedKeys = command.relatedVaultKeys ?? []
    let relatedKeyIndex = 0
    for (const member of relatedMembers) {
      const account = accountById.get(member.accountId)
      if (account === undefined || account.vaultKey === null) return { outcome: 'unknown' }
      if (recipientKeyBySource.has(account.vaultKey)) continue
      const named = relatedKeys[relatedKeyIndex]
      relatedKeyIndex += 1
      if (named === undefined || named.trim() === '') {
        return {
          outcome: 'keys-incomplete',
          needed: distinctSourceKeys.size,
          named: 1 + relatedKeys.filter((key) => key.trim() !== '').length,
        }
      }
      recipientKeyBySource.set(account.vaultKey, named)
    }

    /**
     * Before any parcel is opened, so a refusal costs them nothing — the same
     * rule `key-taken` follows, and for the same reason: both are names the
     * recipient can change, and neither may destroy what the recipient already
     * holds. Checked across the whole set so a partial move cannot start.
     */
    for (const member of ordered) {
      const account = accountById.get(member.accountId)!
      const [held] = await tx
        .select({ id: accounts.id })
        .from(accounts)
        .where(
          and(
            eq(accounts.agentId, command.toAgentId),
            eq(accounts.kind, account.kind),
            sql`lower(${accounts.identifier}) = lower(${account.identifier})`,
          ),
        )
        .limit(1)
      if (held !== undefined) return { outcome: 'already-held' }
    }

    /**
     * Open each distinct parcel once. After the first settles, every refusal
     * must throw so the caller's transaction rolls the opened parcel back —
     * `openAccountTransferIn` documents that contract and we honour it.
     */
    const openedParcels = new Set<string>()
    let openedAny = false
    for (const member of ordered) {
      const account = accountById.get(member.accountId)!
      const transferId = member.transferId!
      if (openedParcels.has(transferId)) continue
      openedParcels.add(transferId)
      const destKey = recipientKeyBySource.get(account.vaultKey!)
      if (destKey === undefined) {
        throw new Error('acceptAccountOffer: source vaultKey has no recipient name')
      }
      const opened = await openAccountTransferIn(
        tx,
        {
          transferId,
          toAgentId: command.toAgentId,
          vaultKey: destKey,
          accountKind: account.kind,
          accountIdentifier: account.identifier,
        },
        recipientToken,
        sealingKey,
      )
      if (opened.outcome === 'key-taken') {
        if (openedAny) throw new Error('acceptAccountOffer: key-taken after a parcel settled')
        return { outcome: 'key-taken' }
      }
      if (opened.outcome !== 'settled') {
        if (openedAny)
          throw new Error(`acceptAccountOffer: ${opened.outcome} after a parcel settled`)
        return { outcome: 'unknown' }
      }
      openedAny = true
    }

    const arrivedByOfferId = new Map<string, AcceptedRelatedAccount>()
    for (const member of ordered) {
      const account = accountById.get(member.accountId)!
      const destKey = recipientKeyBySource.get(account.vaultKey!)!
      const [arrived] = await tx
        .insert(accounts)
        .values({
          agentId: command.toAgentId,
          kind: account.kind,
          identifier: account.identifier,
          provider: account.provider,
          vaultKey: destKey,
          forWork: false,
        })
        .returning({ id: accounts.id })
      if (arrived === undefined) throw new Error('inserting the accepted account returned no row')
      arrivedByOfferId.set(member.id, {
        accountId: arrived.id,
        kind: account.kind,
        identifier: account.identifier,
        provider: account.provider,
        vaultKey: destKey,
      })
    }

    /**
     * Delete every giver row in the set. Cascades take the offer rows with them.
     * Spent-marking runs after, against what is left — a vaultKey still named by
     * an account outside the set stays live for the giver.
     */
    await tx.delete(accounts).where(inArray(accounts.id, accountIds))

    const spentKeys = new Set<string>()
    for (const account of accountRows) {
      if (account.vaultKey === null || account.vaultKey.trim() === '') continue
      if (spentKeys.has(account.vaultKey)) continue
      spentKeys.add(account.vaultKey)
      const [stillMine] = await tx
        .select({ id: accounts.id })
        .from(accounts)
        .where(and(eq(accounts.agentId, row.fromAgentId), eq(accounts.vaultKey, account.vaultKey)))
        .limit(1)
      if (stillMine === undefined) {
        await markVaultEntrySpent(tx, row.fromAgentId as AgentId, account.vaultKey)
      }
    }

    await recordOfferOutcome(
      tx,
      ordered.map((member) => {
        const account = accountById.get(member.accountId)!
        return {
          fromAgentId: member.fromAgentId,
          offerId: member.id,
          toHandle: member.toHandle,
          accountKind: account.kind,
          accountIdentifier: account.identifier,
          accountProvider: account.provider,
        }
      }),
      'accepted',
    )

    for (const account of accountRows) {
      if (account.provider !== null && account.provider.trim() !== '') {
        await closeWalkOnTransfer(tx, row.fromAgentId as AgentId, {
          kind: AccountKindSchema.parse(account.kind),
          provider: account.provider,
        })
      }
    }

    const primaryArrived = arrivedByOfferId.get(row.id)!
    return {
      outcome: 'accepted',
      accountId: primaryArrived.accountId,
      accountKind: primaryArrived.kind,
      accountIdentifier: primaryArrived.identifier,
      accountProvider: primaryArrived.provider,
      vaultKey: primaryArrived.vaultKey,
      fromHandle: row.fromHandle,
      related: relatedMembers.map((member) => arrivedByOfferId.get(member.id)!),
    }
  })
}

export type DeclineAccountOfferOutcome =
  | { readonly outcome: 'declined' }
  /** No such offer, or not addressed to this citizen. One answer for both. */
  | { readonly outcome: 'unknown' }

/**
 * Say no, and leave nothing behind (decision 2).
 *
 * The offer and the parcel go; the giver's account, vault entry and thread are
 * not touched at all. **No reason is asked for and none is recorded** — declining
 * a gift costs nothing and is not a mark against anybody. The giver is told the
 * offer was declined and nothing else (`#1215`): *no* is a complete answer, and
 * a channel that carried a reason would be the one thing that could make saying
 * it expensive.
 */
export async function declineAccountOffer(
  db: Database,
  command: { readonly offerId: string; readonly toAgentId: AgentId },
): Promise<DeclineAccountOfferOutcome> {
  return await db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        id: accountOffers.id,
        transferId: accountOffers.transferId,
        setId: accountOffers.setId,
        fromAgentId: accountOffers.fromAgentId,
        toHandle: accountOffers.toHandle,
        accountKind: accountOffers.accountKind,
        accountIdentifier: accountOffers.accountIdentifier,
        accountProvider: accountOffers.accountProvider,
      })
      .from(accountOffers)
      .where(
        and(eq(accountOffers.id, command.offerId), eq(accountOffers.toAgentId, command.toAgentId)),
      )
      .for('update')
      .limit(1)

    if (row === undefined) return { outcome: 'unknown' }

    /**
     * Declining any member takes the whole set (`#1217`). The offer was one
     * decision for the recipient; leaving a sibling open would ask them again.
     */
    const set =
      row.setId === null
        ? [row]
        : await tx
            .select({
              id: accountOffers.id,
              transferId: accountOffers.transferId,
              setId: accountOffers.setId,
              fromAgentId: accountOffers.fromAgentId,
              toHandle: accountOffers.toHandle,
              accountKind: accountOffers.accountKind,
              accountIdentifier: accountOffers.accountIdentifier,
              accountProvider: accountOffers.accountProvider,
            })
            .from(accountOffers)
            .where(
              and(
                eq(accountOffers.setId, row.setId),
                eq(accountOffers.toAgentId, command.toAgentId),
              ),
            )
            .for('update')

    const offerIds = set.map((member) => member.id)
    await tx.delete(accountOffers).where(inArray(accountOffers.id, offerIds))

    const parcels = [
      ...new Set(set.flatMap((member) => (member.transferId === null ? [] : [member.transferId]))),
    ]
    if (parcels.length > 0) {
      await tx.delete(accountTransfers).where(inArray(accountTransfers.id, parcels))
    }

    await recordOfferOutcome(
      tx,
      set.map((member) => ({ ...member, offerId: member.id })),
      'declined',
    )

    return { outcome: 'declined' }
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
      .returning({
        id: accountOffers.id,
        transferId: accountOffers.transferId,
        fromAgentId: accountOffers.fromAgentId,
        toHandle: accountOffers.toHandle,
        accountKind: accountOffers.accountKind,
        accountIdentifier: accountOffers.accountIdentifier,
        accountProvider: accountOffers.accountProvider,
        expiresAt: accountOffers.expiresAt,
      })

    const parcels = swept.flatMap((row) => (row.transferId === null ? [] : [row.transferId]))
    if (parcels.length > 0) {
      await tx.delete(accountTransfers).where(inArray(accountTransfers.id, parcels))
    }

    await recordExpiries(tx, swept)

    return swept.length
  })
}

/** The same sweep, narrowed to one account, run inside `give`'s own transaction. */
async function sweepExpiredOffersFor(tx: Transaction, accountId: string): Promise<void> {
  const swept = await tx
    .delete(accountOffers)
    .where(and(eq(accountOffers.accountId, accountId), lte(accountOffers.expiresAt, sql`now()`)))
    .returning({
      id: accountOffers.id,
      transferId: accountOffers.transferId,
      fromAgentId: accountOffers.fromAgentId,
      toHandle: accountOffers.toHandle,
      accountKind: accountOffers.accountKind,
      accountIdentifier: accountOffers.accountIdentifier,
      accountProvider: accountOffers.accountProvider,
      expiresAt: accountOffers.expiresAt,
    })

  const parcels = swept.flatMap((row) => (row.transferId === null ? [] : [row.transferId]))
  if (parcels.length > 0) {
    await tx.delete(accountTransfers).where(inArray(accountTransfers.id, parcels))
  }

  await recordExpiries(tx, swept)
}

/**
 * The receipt for an offer nobody came for, from either sweep (`#1215`).
 *
 * **Stamped at the moment the window closed, not at the moment it was swept.**
 * Nothing runs either sweep on a schedule today, so an expired offer is
 * invisible everywhere long before its row goes — which is why the digest reads
 * expiries out of the offers still sitting there as well as out of this table.
 * The two are the same fact seen before and after the sweep, and writing
 * `expiresAt` here is what makes them the same fact to a `since` window too: a
 * giver told about the expiry from the live row is not told about it a second
 * time once the row is gone.
 */
async function recordExpiries(
  tx: Transaction,
  swept: readonly (Omit<OfferOutcomeRow, 'offerId'> & {
    readonly id: string
    readonly expiresAt: string
  })[],
): Promise<void> {
  await recordOfferOutcome(
    tx,
    swept.map((row) => ({ ...row, offerId: row.id })),
    'expired',
    swept.map((row) => row.expiresAt),
  )
}
