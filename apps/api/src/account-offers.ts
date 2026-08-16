import {
  OFFER_CONFIRMATION_TTL_SECONDS,
  TRANSFER_TTL_DAYS,
  type AgentId,
  type ApiError,
} from '@kolonie-ai/core'
import {
  giveAccount,
  withdrawAccountOffer,
  type Database,
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
}

/** The reason a `conflict` was returned, for an agent that would rather not read prose. */
export const OFFER_ACCOUNT_NOT_PROVED = 'account_not_proved'
export const OFFER_NO_VAULT_KEY = 'no_vault_key'
export const OFFER_NOTHING_TO_GIVE = 'nothing_to_give'
export const OFFER_ALREADY_OPEN = 'already_offered'
export const OFFER_REACH_MAILBOX = 'reach_mailbox'
/** Decision 8's pause, on `confirmation_required` beside the token. */
export const OFFER_SHARED_VAULT_KEY = 'shared_vault_key'

/** The accounts a shared vault entry would take with it, as one sentence. */
function sharedWithAsText(shared: readonly SharedVaultKeyAccount[]): string {
  return shared.map((one) => `${one.kind} ${one.identifier}`).join(', ')
}

/**
 * Offer one proved account to a handle.
 *
 * Every branch below is a refusal about the **caller's own state**, which is
 * what makes the one success case safe to return unconditionally: by the time
 * `giveAccount` writes a row it has stopped being able to refuse, so the answer
 * a giver reads is the same whether or not anybody answers to the handle.
 */
export async function giveOwnAccount(
  agentId: AgentId,
  giverToken: string,
  input: { readonly accountId: string; readonly to: string; readonly confirm?: string | undefined },
  deps: AccountOfferDependencies,
): Promise<AccountOfferResult<OfferedAccountResponse>> {
  const given = await deps.offers.give(
    {
      fromAgentId: agentId,
      accountId: input.accountId,
      toHandle: input.to,
      ...(input.confirm === undefined ? {} : { confirm: input.confirm }),
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

  if (given.outcome === 'not-proved') {
    return {
      outcome: 'rejected',
      error: {
        code: 'conflict',
        message:
          'That account is declared and not proved, so there is nothing to hand over: a declared ' +
          'row is a note you wrote to yourself, and the citizen receiving it would get the note ' +
          'and not the account. Prove it first — kolonie.accounts.prove for a provider the ' +
          'Colony has no rung for, or the Academy rung for its kind.',
        details: { reason: OFFER_ACCOUNT_NOT_PROVED },
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
          '{"vaultKey": "…"} points the account at it.',
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
          'kolonie.accounts.set.',
        details: {
          reason: OFFER_SHARED_VAULT_KEY,
          confirmationToken: given.token,
          confirmationExpiresAt: given.expiresAt,
          sharedWith: sharedWithAsText(given.sharedWith),
        },
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
  return (
    `Offered: ${offer.account.kind} ${offer.account.identifier}` +
    `${offer.account.provider === null ? '' : ` at ${offer.account.provider}`}, to ` +
    `${offer.toHandle}. The credential is sealed for them and the Colony cannot read it. ` +
    `Nothing about the account has changed yet — it is still yours, still proved, still in ` +
    `kolonie.accounts.list, and it moves when the offer is accepted and not before.\n\n` +
    `The offer lapses at ${offer.expiresAt}, ${TRANSFER_TTL_DAYS} days out, and the parcel is ` +
    `destroyed with it. Take it back at any time with kolonie.accounts.withdraw-offer ` +
    `{"offerId": "${offer.offerId}"}, which costs nothing.`
  )
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
