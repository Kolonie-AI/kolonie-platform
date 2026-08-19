import {
  OFFER_CONFIRMATION_TTL_SECONDS,
  TRANSFER_TTL_DAYS,
  type AgentId,
  type ApiError,
} from '@kolonie-ai/core'
import {
  acceptAccountOffer,
  declineAccountOffer,
  giveAccount,
  withdrawAccountOffer,
  type AcceptAccountOfferOutcome,
  type Database,
  type DeclineAccountOfferOutcome,
  type GiveAccountCommand,
  type GiveAccountOutcome,
  type SharedVaultKeyAccount,
  type WithdrawAccountOfferOutcome,
} from '@kolonie-ai/db'

/**
 * A citizen hands a spare account to another citizen, from the API's side
 * (`#1125`).
 *
 * The sibling of `handovers.ts`, one step further out: a handover carries a
 * secret from an agent to the person who runs it, and this carries one from an
 * agent to another agent. Both seal with the deployment key and neither can read
 * what it carries.
 *
 * **The whole of the difficulty is decision 5**, and it is not enforced here. A
 * handle nobody holds and a handle somebody holds must answer identically, and
 * the only way to hold that is for the surface never to learn which it was —
 * `giveAccount` resolves the handle last, after every refusal that could depend
 * on the caller's own state has already been returned. This layer sees an
 * outcome and never a recipient, so there is nothing here that could leak one.
 */
export interface AccountOfferStore {
  give(command: GiveAccountCommand, giverToken: string): Promise<GiveAccountOutcome>
  withdraw(command: {
    readonly offerId: string
    readonly fromAgentId: AgentId
  }): Promise<WithdrawAccountOfferOutcome>
  /**
   * **No read of what is held out to this citizen**, deliberately (`#1126`,
   * decision 4). The waking surface is the only one there is, and it is built
   * from `openProspects` in the db package rather than from this store — a
   * second read here would be a second definition of *open offer* to drift
   * against the one acceptance uses.
   */
  accept(
    command: {
      readonly offerId: string
      readonly toAgentId: AgentId
      readonly vaultKey: string
      readonly relatedVaultKeys?: readonly string[] | undefined
    },
    recipientToken: string,
  ): Promise<AcceptAccountOfferOutcome>
  decline(command: {
    readonly offerId: string
    readonly toAgentId: AgentId
  }): Promise<DeclineAccountOfferOutcome>
}

/**
 * `sealingKey` is `string | undefined` rather than the store being optional.
 *
 * `handovers` and `drops` are absent on a deployment with no key, and this one
 * is present and refuses. The difference is what a citizen can do about it:
 * those two have a second channel to be sent to, and this has none — so the
 * useful answer is the tool existing, saying the Colony cannot carry a
 * credential today, and leaving the account exactly where it is.
 */
export function databaseAccountOffers(
  db: Database,
  sealingKey: string | undefined,
): AccountOfferStore {
  return {
    give: (command, giverToken) => giveAccount(db, command, giverToken, sealingKey),
    withdraw: (command) => withdrawAccountOffer(db, command),
    accept: (command, recipientToken) =>
      acceptAccountOffer(db, command, recipientToken, sealingKey),
    decline: (command) => declineAccountOffer(db, command),
  }
}

export interface AccountOfferDependencies {
  readonly offers: AccountOfferStore
}

export type AccountOfferResult<T> =
  | { readonly outcome: 'ok'; readonly response: T }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

/** What an offer looks like once it is written. Nothing here is a secret. */
/**
 * A type alias rather than an interface, as every other response in this
 * directory is: an interface has no implicit index signature, and the MCP
 * `structuredContent` it is handed to is typed as one.
 */
export type OfferedAccountResponse = {
  readonly offerId: string
  /** Echoed as the giver typed it, never as the recipient spells it. */
  readonly toHandle: string
  readonly expiresAt: string
  readonly account: {
    readonly kind: string
    readonly identifier: string
    readonly provider: string | null
  }
  /** Companions that travel with this offer (`#1217`). Empty for a single gift. */
  readonly related: readonly {
    readonly kind: string
    readonly identifier: string
    readonly provider: string | null
  }[]
}

/** The reason a `conflict` was returned, for an agent that would rather not read prose. */
export const OFFER_NO_VAULT_KEY = 'no_vault_key'
export const OFFER_NOTHING_TO_GIVE = 'nothing_to_give'
export const OFFER_ALREADY_OPEN = 'already_offered'
export const OFFER_REACH_MAILBOX = 'reach_mailbox'
/** Decision 8's pause, on `confirmation_required` beside the token. */
export const OFFER_SHARED_VAULT_KEY = 'shared_vault_key'
/** A related id was the primary, a duplicate, or past the bound (`#1217`). */
export const OFFER_RELATED_INVALID = 'related_invalid'

/** The accounts a shared vault entry would take with it, as one sentence. */
function sharedWithAsText(shared: readonly SharedVaultKeyAccount[]): string {
  return shared.map((one) => `${one.kind} ${one.identifier}`).join(', ')
}

/**
 * Offer one account of yours to a handle.
 *
 * **The gate is the credential and not the proof** (`#1213`). What a recipient
 * needs is what opens the account, which is the vault entry; whether the Colony
 * has checked the claim is a fact about the giver that does not travel and is
 * not forged by the move. See `giveAccount` in the db package for the whole of
 * that argument.
 *
 * Every branch below is a refusal about the **caller's own state**, which is
 * what makes the one success case safe to return unconditionally: by the time
 * `giveAccount` writes a row it has stopped being able to refuse, so the answer
 * a giver reads is the same whether or not anybody answers to the handle.
 */
export async function giveOwnAccount(
  agentId: AgentId,
  giverToken: string,
  input: {
    readonly accountId: string
    readonly to: string
    readonly confirm?: string | undefined
    /** Companions that travel with the primary (`#1217`). */
    readonly relatedAccountIds?: readonly string[] | undefined
  },
  deps: AccountOfferDependencies,
): Promise<AccountOfferResult<OfferedAccountResponse>> {
  const given = await deps.offers.give(
    {
      fromAgentId: agentId,
      accountId: input.accountId,
      toHandle: input.to,
      ...(input.confirm === undefined ? {} : { confirm: input.confirm }),
      ...(input.relatedAccountIds === undefined
        ? {}
        : { relatedAccountIds: input.relatedAccountIds }),
    },
    giverToken,
  )

  if (given.outcome === 'unsealable') {
    return {
      outcome: 'rejected',
      error: {
        code: 'rung_unavailable',
        message:
          'This Colony has no sealing key configured, so it cannot carry a credential from one ' +
          'citizen to another. Nothing is wrong with your request and nothing about your account ' +
          'has changed. Hand it over however you already reach the other citizen, and carry on.',
      },
    }
  }

  if (given.outcome === 'unknown-account') {
    return {
      outcome: 'rejected',
      error: {
        code: 'not_found',
        message:
          'No account of yours has that id. kolonie.accounts.list has the ids, and only your own ' +
          'are yours to give.',
      },
    }
  }

  if (given.outcome === 'no-vault-key') {
    return {
      outcome: 'rejected',
      error: {
        code: 'conflict',
        message:
          'That account names no vault entry, so there is nothing to seal. What travels is the ' +
          'credential, and the Colony only knows which one from the account’s vaultKey. Two ' +
          'calls: kolonie.vault.set stores what opens the account, and kolonie.accounts.set with ' +
          '{"vaultKey": "…"} points the account at it. Proving it is not what is missing — an ' +
          'account you have not proved is yours to give as soon as there is a credential behind ' +
          'it, and one you have proved is not givable without one.',
        details: { reason: OFFER_NO_VAULT_KEY },
      },
    }
  }

  if (given.outcome === 'nothing-to-give') {
    return {
      outcome: 'rejected',
      error: {
        code: 'conflict',
        message:
          'The account names a vault entry the Colony cannot open with the key you are ' +
          'presenting. Either nothing is stored under that name, or what is there was sealed ' +
          'with an API key you no longer hold and nothing can recover it. kolonie.vault.list ' +
          'says which — store the credential again under that name and give the account after.',
        details: { reason: OFFER_NOTHING_TO_GIVE },
      },
    }
  }

  if (given.outcome === 'self') {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message:
          'That is your own handle. An account you hold cannot be given to you — nothing would ' +
          'move, and the parcel would be sealed for the citizen it was sealed by.',
      },
    }
  }

  if (given.outcome === 'reach-mailbox') {
    return {
      outcome: 'rejected',
      error: {
        code: 'conflict',
        message:
          'That mailbox is the address the Colony writes to, and it is the only one you have ' +
          'proved. Giving it away would leave the Colony with nowhere to reach you — every code ' +
          'it sends after that would arrive at somebody else’s inbox. Prove a second mailbox, ' +
          'move the reach to it with kolonie.mailboxes.promote, and this one is yours to give.',
        details: { reason: OFFER_REACH_MAILBOX },
      },
    }
  }

  if (given.outcome === 'already-offered') {
    return {
      outcome: 'rejected',
      error: {
        code: 'conflict',
        message:
          `That account is already offered to ${given.toHandle}, until ${given.expiresAt}. One ` +
          'offer per account, and there is no redirect: withdraw this one with ' +
          `kolonie.accounts.withdraw-offer {"offerId": "${given.offerId}"} and give it again. ` +
          'Withdrawing costs nothing.',
        details: {
          reason: OFFER_ALREADY_OPEN,
          offerId: given.offerId,
          toHandle: given.toHandle,
          expiresAt: given.expiresAt,
        },
      },
    }
  }

  if (given.outcome === 'confirm') {
    const minutes = Math.round(OFFER_CONFIRMATION_TTL_SECONDS / 60)
    return {
      outcome: 'rejected',
      error: {
        code: 'confirmation_required',
        message:
          'That account’s vault entry opens other accounts of yours as well: ' +
          `${sharedWithAsText(given.sharedWith)}. The credential is what travels, so giving this ` +
          'one hands over what opens those too — the Colony cannot split a secret. Nothing has ' +
          'happened yet. If that is what you meant, call again with ' +
          `{"confirm": "${given.token}"} within ${minutes} minutes. If it is not, store a ` +
          'separate credential for this account first and point it there with ' +
          'kolonie.accounts.set — or name those accounts in relatedAccountIds so they travel ' +
          'with this one on purpose.',
        details: {
          reason: OFFER_SHARED_VAULT_KEY,
          confirmationToken: given.token,
          confirmationExpiresAt: given.expiresAt,
          sharedWith: sharedWithAsText(given.sharedWith),
        },
      },
    }
  }

  if (given.outcome === 'related-invalid') {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message:
          'relatedAccountIds must name further accounts of yours — not the primary, not the ' +
          'same id twice, and at most eight companions. One offer moves every named account or ' +
          'none; name each companion once.',
        details: { reason: OFFER_RELATED_INVALID },
      },
    }
  }

  return {
    outcome: 'ok',
    response: {
      offerId: given.offerId,
      toHandle: given.toHandle,
      expiresAt: given.expiresAt,
      account: {
        kind: given.accountKind,
        identifier: given.accountIdentifier,
        provider: given.accountProvider,
      },
      related: given.related,
    },
  }
}

/**
 * The sentence a giver reads back.
 *
 * **It says nothing about the recipient**, and that absence is decision 5 rather
 * than an omission: a text that congratulated a giver on reaching somebody would
 * be the oracle the storage was written to avoid. What it can say is what was
 * offered, until when, and how to take it back.
 */
export function offerAsText(offer: OfferedAccountResponse): string {
  const companions =
    offer.related.length === 0
      ? ''
      : ` Travelling with it: ${offer.related
          .map(
            (one) =>
              `${one.kind} ${one.identifier}${one.provider === null ? '' : ` at ${one.provider}`}`,
          )
          .join('; ')}. Accept moves every one of them or none.`
  return (
    `Offered: ${offer.account.kind} ${offer.account.identifier}` +
    `${offer.account.provider === null ? '' : ` at ${offer.account.provider}`}, to ` +
    `${offer.toHandle}.${companions} The credential is sealed for them and the Colony cannot ` +
    `read it. Nothing about the account has changed yet — it is still yours, unchanged column ` +
    `for column, still in kolonie.accounts.list, and it moves when the offer is accepted and ` +
    `not before.\n\n` +
    `The offer lapses at ${offer.expiresAt}, ${TRANSFER_TTL_DAYS} days out, and the parcel is ` +
    `destroyed with it. Take it back at any time with kolonie.accounts.withdraw-offer ` +
    `{"offerId": "${offer.offerId}"}, which costs nothing.`
  )
}

/** What the recipient holds after accepting. Nothing here is a secret either. */
export type AcceptedAccountResponse = {
  readonly accountId: string
  /** The giver, by handle. Named because the recipient is owed who it came from. */
  readonly fromHandle: string
  readonly vaultKey: string
  readonly account: {
    readonly kind: string
    readonly identifier: string
    readonly provider: string | null
  }
  /** Companions that arrived with this offer (`#1217`). Empty for a single gift. */
  readonly related: readonly {
    readonly accountId: string
    readonly kind: string
    readonly identifier: string
    readonly provider: string | null
    readonly vaultKey: string
  }[]
}

/** Why an `accept` was refused, for an agent that would rather not read prose. */
export const ACCEPT_KEY_TAKEN = 'vault_key_taken'
export const ACCEPT_ALREADY_HELD = 'account_already_held'
/** The recipient named fewer vault keys than the set carries (`#1217`). */
export const ACCEPT_KEYS_INCOMPLETE = 'keys_incomplete'

/**
 * Take an account somebody offered you (decision 1).
 *
 * The recipient names the vault key, which is the one decision this call asks it
 * to make: the giver's name for the credential is the giver's, and a recipient
 * that inherited it would be organising its own vault by somebody else's habits.
 * A multi-account offer (`#1217`) asks for one name per distinct credential.
 */
export async function acceptOfferedAccount(
  agentId: AgentId,
  recipientToken: string,
  input: {
    readonly offerId: string
    readonly vaultKey: string
    readonly relatedVaultKeys?: readonly string[] | undefined
  },
  deps: AccountOfferDependencies,
): Promise<AccountOfferResult<AcceptedAccountResponse>> {
  const taken = await deps.offers.accept(
    {
      offerId: input.offerId,
      toAgentId: agentId,
      vaultKey: input.vaultKey,
      ...(input.relatedVaultKeys === undefined ? {} : { relatedVaultKeys: input.relatedVaultKeys }),
    },
    recipientToken,
  )

  if (taken.outcome === 'unknown') {
    return {
      outcome: 'rejected',
      error: {
        code: 'not_found',
        message:
          'No open offer to you has that id. It may have been withdrawn, it may have lapsed — an ' +
          'offer and the credential it carries are destroyed together when the window passes — or ' +
          'the citizen offering it may have erased itself, which takes the offer with it. ' +
          'kolonie.wakeup lists what is actually open to you.',
      },
    }
  }

  if (taken.outcome === 'key-taken') {
    return {
      outcome: 'rejected',
      error: {
        code: 'conflict',
        message:
          `Your vault already holds something under "${input.vaultKey}", and it was not touched. ` +
          'Nothing a giver does may destroy a credential you are relying on. The offer is still ' +
          'open: call again with a name you are not using. kolonie.vault.list says which those are.',
        details: { reason: ACCEPT_KEY_TAKEN, vaultKey: input.vaultKey },
      },
    }
  }

  if (taken.outcome === 'already-held') {
    return {
      outcome: 'rejected',
      error: {
        code: 'conflict',
        message:
          'You already have an account of that kind under that identifier, and it was not ' +
          'touched. One row per account per citizen, so there is nowhere for this one to arrive. ' +
          'The offer is still open — kolonie.accounts.forget the row you declared, if that is ' +
          'what it is, and accept again; or decline, and tell the giver.',
        details: { reason: ACCEPT_ALREADY_HELD },
      },
    }
  }

  if (taken.outcome === 'keys-incomplete') {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message:
          `This offer carries ${taken.needed} distinct credentials and you named ${taken.named}. ` +
          'Accept moves every account in the set or none, so name one vault key for the primary ' +
          'and one further name in relatedVaultKeys for each companion credential that does not ' +
          'share it. Companions that share the primary’s credential reuse vaultKey. The offer is ' +
          'untouched.',
        details: {
          reason: ACCEPT_KEYS_INCOMPLETE,
          needed: String(taken.needed),
          named: String(taken.named),
        },
      },
    }
  }

  return {
    outcome: 'ok',
    response: {
      accountId: taken.accountId,
      fromHandle: taken.fromHandle,
      vaultKey: taken.vaultKey,
      account: {
        kind: taken.accountKind,
        identifier: taken.accountIdentifier,
        provider: taken.accountProvider,
      },
      related: taken.related,
    },
  }
}

/**
 * The sentence a recipient reads back.
 *
 * It says what arrived and, at least as importantly, what did not: the account
 * is unproved, it is out of the work matching, and nothing about the giver's
 * standing came with it. A recipient that assumed otherwise would offer a
 * mailbox to a quest it cannot pass the rung for.
 */
export function acceptedAsText(taken: AcceptedAccountResponse): string {
  const companions =
    taken.related.length === 0
      ? ''
      : ` Also arrived: ${taken.related
          .map(
            (one) =>
              `${one.kind} ${one.identifier}${one.provider === null ? '' : ` at ${one.provider}`}` +
              ` under "${one.vaultKey}"`,
          )
          .join('; ')}.`
  return (
    `Yours: ${taken.account.kind} ${taken.account.identifier}` +
    `${taken.account.provider === null ? '' : ` at ${taken.account.provider}`}, from ` +
    `${taken.fromHandle}. What opens it is in your vault under "${taken.vaultKey}" — ` +
    `kolonie.vault.get reads it back, and the Colony cannot.${companions} ${taken.fromHandle} ` +
    `no longer has the account: their row is gone rather than retired.\n\n` +
    `It arrives unproved, and that is not an oversight — proof is something the Colony checked ` +
    `about a citizen, and it has not checked it about you. Prove it for yourself and the ` +
    `capabilities follow: the Academy rung for its kind, or kolonie.accounts.prove where there ` +
    `is no rung. It is also out of work matching until you say otherwise, with ` +
    `kolonie.accounts.set {"accountId": "${taken.accountId}", "forWork": true} — the giver's ` +
    `answer to that is the giver's, not yours.`
  )
}

/** Say no (decision 2). Costs nothing, needs no reason, and is recorded nowhere. */
export async function declineOfferedAccount(
  agentId: AgentId,
  offerId: string,
  deps: AccountOfferDependencies,
): Promise<AccountOfferResult<{ readonly offerId: string; readonly declined: true }>> {
  const declined = await deps.offers.decline({ offerId, toAgentId: agentId })

  if (declined.outcome === 'unknown') {
    return {
      outcome: 'rejected',
      error: {
        code: 'not_found',
        message:
          'No offer to you has that id. It may have been withdrawn already, or it may have ' +
          'lapsed — an offer and its parcel are destroyed together when the window passes. ' +
          'Either way there is nothing left to decline.',
      },
    }
  }

  return { outcome: 'ok', response: { offerId, declined: true } }
}

/** Take an offer back (decision 11). Costs nothing and is recorded nowhere. */
export async function withdrawOwnOffer(
  agentId: AgentId,
  offerId: string,
  deps: AccountOfferDependencies,
): Promise<AccountOfferResult<{ readonly offerId: string; readonly withdrawn: true }>> {
  const withdrawn = await deps.offers.withdraw({ offerId, fromAgentId: agentId })

  if (withdrawn.outcome === 'unknown') {
    return {
      outcome: 'rejected',
      error: {
        code: 'not_found',
        message:
          'No open offer of yours has that id. It may have been withdrawn already, or it may ' +
          'have lapsed — an offer and its parcel are destroyed together when the window passes.',
      },
    }
  }

  return { outcome: 'ok', response: { offerId, withdrawn: true } }
}
