import { randomUUID } from 'node:crypto'
import { TRANSFER_TTL_DAYS, type AgentId } from '@kolonie-ai/core'
import type { AccountOfferStore } from '../account-offers.js'
import type { GiveAccountCommand, GiveAccountOutcome, SharedVaultKeyAccount } from '@kolonie-ai/db'

/**
 * An account offered from one citizen to another, in memory (`#1125`).
 *
 * **It reproduces the check order and none of the cryptography**, on the same
 * reasoning `account-threads.ts` gives: whether a parcel actually opens is
 * asserted in `packages/db` against the real primitive, and a second
 * implementation of AES here would only prove the two agree.
 *
 * The order is the part worth reproducing, because it is the whole of decision
 * 5. Every refusal below concerns the **giver's own state** and is returned
 * before the handle is looked at; the handle is resolved last, and finding
 * nobody is not a refusal — it writes the offer with no parcel behind it. A
 * fixture that resolved the handle first would let a tool test pass while the
 * surface it stands in for leaked which names are taken.
 */
export interface FakeAccountOffers extends AccountOfferStore {
  /** Put a proved, givable account on a citizen's register. */
  hold(
    agentId: AgentId,
    account: {
      readonly id?: string
      readonly kind: string
      readonly identifier: string
      readonly provider?: string | null
      /** A declared row: `false` is what `not-proved` is asserted through. */
      readonly proved?: boolean
      /** `null` is what `no-vault-key` is asserted through. */
      readonly vaultKey?: string | null
      /** The one address the Colony writes to, and the only one proved. */
      readonly reachMailbox?: boolean
      /** What else that vault entry opens — non-empty mints the confirmation. */
      readonly sharedWith?: readonly SharedVaultKeyAccount[]
    },
  ): string
  /** A credential the giver can actually open. Absent is `nothing-to-give`. */
  storeVaultEntry(agentId: AgentId, key: string): void
  /**
   * Take the credential away and leave the account pointing at it.
   *
   * `hold` stores one for every account that names a key, because that is the
   * ordinary state; this is how a test composes the account whose vaultKey
   * opens nothing — sealed with an API key the giver no longer holds, or never
   * stored at all.
   */
  forgetVaultEntry(agentId: AgentId, key: string): void
  /** A citizen somebody answers to. Whether one exists must not change an answer. */
  citizen(agentId: AgentId, handle: string): void
  /** Whether a parcel was written — the fact the surface must never disclose. */
  hasParcel(offerId: string): boolean
  /** Take the whole sealing key away, for the `unsealable` refusal. */
  loseSealingKey(): void
}

type HeldAccount = {
  readonly ownerId: AgentId
  readonly kind: string
  readonly identifier: string
  readonly provider: string | null
  readonly proved: boolean
  readonly vaultKey: string | null
  readonly reachMailbox: boolean
  readonly sharedWith: readonly SharedVaultKeyAccount[]
}

type OpenOffer = {
  readonly fromAgentId: AgentId
  readonly accountId: string
  readonly toHandle: string
  readonly expiresAt: string
  readonly hasParcel: boolean
}

const handleKey = (handle: string): string => handle.trim().toLowerCase()

export function fakeAccountOffers(): FakeAccountOffers {
  const accounts = new Map<string, HeldAccount>()
  const vaultEntries = new Set<string>()
  const handles = new Map<string, AgentId>()
  const offers = new Map<string, OpenOffer>()
  const confirmations = new Map<string, { accountId: string; toHandleKey: string }>()
  let sealingKey: string | undefined = 'a-fixture-sealing-key'

  const expiry = (): string =>
    new Date(Date.now() + TRANSFER_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString()

  return {
    hold(agentId, account) {
      const id = account.id ?? randomUUID()
      accounts.set(id, {
        ownerId: agentId,
        kind: account.kind,
        identifier: account.identifier,
        provider: account.provider ?? null,
        proved: account.proved ?? true,
        vaultKey:
          account.vaultKey === undefined
            ? `${account.kind}/${account.identifier}`
            : account.vaultKey,
        reachMailbox: account.reachMailbox ?? false,
        sharedWith: account.sharedWith ?? [],
      })
      const held = accounts.get(id) as HeldAccount
      if (held.vaultKey !== null) vaultEntries.add(`${agentId}:${held.vaultKey}`)
      return id
    },

    storeVaultEntry(agentId, key) {
      vaultEntries.add(`${agentId}:${key}`)
    },

    forgetVaultEntry(agentId, key) {
      vaultEntries.delete(`${agentId}:${key}`)
    },

    citizen(agentId, handle) {
      handles.set(handleKey(handle), agentId)
    },

    hasParcel(offerId) {
      return offers.get(offerId)?.hasParcel ?? false
    },

    loseSealingKey() {
      sealingKey = undefined
    },

    give(command: GiveAccountCommand): Promise<GiveAccountOutcome> {
      if (sealingKey === undefined) return Promise.resolve({ outcome: 'unsealable' })

      const account = accounts.get(command.accountId)
      // One answer for *not yours* and *does not exist*, as the storage gives.
      if (account === undefined || account.ownerId !== command.fromAgentId) {
        return Promise.resolve({ outcome: 'unknown-account' })
      }
      if (!account.proved) return Promise.resolve({ outcome: 'not-proved' })
      if (account.vaultKey === null) return Promise.resolve({ outcome: 'no-vault-key' })
      if (!vaultEntries.has(`${command.fromAgentId}:${account.vaultKey}`)) {
        return Promise.resolve({ outcome: 'nothing-to-give' })
      }
      if (account.reachMailbox) return Promise.resolve({ outcome: 'reach-mailbox' })

      for (const [offerId, open] of offers) {
        if (open.accountId === command.accountId) {
          return Promise.resolve({
            outcome: 'already-offered',
            offerId,
            toHandle: open.toHandle,
            expiresAt: open.expiresAt,
          })
        }
      }

      // Self is exempt from decision 5 (decision 6), so it is the one place a
      // handle is compared before the offer is written.
      if (handles.get(handleKey(command.toHandle)) === command.fromAgentId) {
        return Promise.resolve({ outcome: 'self' })
      }

      if (account.sharedWith.length > 0) {
        const held = command.confirm === undefined ? undefined : confirmations.get(command.confirm)
        const answered =
          held !== undefined &&
          held.accountId === command.accountId &&
          held.toHandleKey === handleKey(command.toHandle)
        if (!answered) {
          const token = randomUUID()
          confirmations.set(token, {
            accountId: command.accountId,
            toHandleKey: handleKey(command.toHandle),
          })
          return Promise.resolve({
            outcome: 'confirm',
            token,
            expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
            sharedWith: account.sharedWith,
          })
        }
        confirmations.delete(command.confirm as string)
      }

      // The handle, last and unrefusable. A recipient nobody answers to gets an
      // offer with no parcel, and the giver cannot tell the two apart.
      const offerId = randomUUID()
      const expiresAt = expiry()
      offers.set(offerId, {
        fromAgentId: command.fromAgentId,
        accountId: command.accountId,
        toHandle: command.toHandle,
        expiresAt,
        hasParcel: handles.has(handleKey(command.toHandle)),
      })

      return Promise.resolve({
        outcome: 'offered',
        offerId,
        // Verbatim as the giver typed it, never as the recipient holds it.
        toHandle: command.toHandle,
        expiresAt,
        accountKind: account.kind,
        accountIdentifier: account.identifier,
        accountProvider: account.provider,
      })
    },

    withdraw(command) {
      const open = offers.get(command.offerId)
      if (open === undefined || open.fromAgentId !== command.fromAgentId) {
        return Promise.resolve({ outcome: 'unknown' as const })
      }
      offers.delete(command.offerId)
      return Promise.resolve({ outcome: 'withdrawn' as const })
    },
  }
}
