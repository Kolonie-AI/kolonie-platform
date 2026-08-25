import { randomUUID } from 'node:crypto'
import {
  RELATED_ACCOUNTS_MAX,
  TRANSFER_TTL_DAYS,
  keyMaterialFinding,
  type AgentId,
  type CredentialFinding,
} from '@kolonie-ai/core'
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
 *
 * Multi-account offers (`#1217`) share a `setId` across sibling rows. Accept,
 * withdraw and decline take the whole set or none.
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
      /** A declared row. Givable all the same, once it names a vault entry (`#1213`). */
      readonly proved?: boolean
      /** `null` is what `no-vault-key` is asserted through. */
      readonly vaultKey?: string | null
      /** The one address the Colony writes to, and the only one proved. */
      readonly reachMailbox?: boolean
      /** What else that vault entry opens — non-empty mints the confirmation. */
      readonly sharedWith?: readonly SharedVaultKeyAccount[]
      /**
       * The plaintext the parcel would carry (`#1685`). Absent is an ordinary
       * credential the fixture does not inspect. Present so an accept can
       * notice a PEM without implementing AES.
       */
      readonly vaultValue?: string
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
  /** Whether an offer is still open at all, however it stopped being one. */
  isOpen(offerId: string): boolean
  /** One account row as it now stands, or `undefined` if it is gone (`#1126`). */
  row(accountId: string): ArrivedAccount | undefined
  /** Every account row a citizen holds — the giver's absence is what is asserted. */
  rowsOf(agentId: AgentId): readonly (ArrivedAccount & { readonly accountId: string })[]
  /** Whether a citizen's vault holds that name. The giver's must survive. */
  holdsVaultEntry(agentId: AgentId, key: string): boolean
  /**
   * Whether that entry has been marked as no longer the citizen's to use
   * (`#1214`). The giver's entry survives an accept and stops opening: both
   * halves are asserted, so the fixture has to be able to tell them apart.
   */
  spentVaultEntry(agentId: AgentId, key: string): boolean
}

/** An account row as a test reads it back. Nothing here is sealed. */
export type ArrivedAccount = {
  readonly ownerId: AgentId
  readonly kind: string
  readonly identifier: string
  readonly provider: string | null
  readonly proved: boolean
  readonly vaultKey: string | null
  /** `false` on arrival, always: a choice is not transferable (decision 7). */
  readonly forWork: boolean
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
  /**
   * Whether the account is offered to work naming its kind (decision 7).
   *
   * `true` on a row a citizen declared, which is the storage default, and
   * `false` on one that arrived from somebody else. The fixture carries it
   * because it is the single column an arrived row is permitted to differ in,
   * and a fixture that did not model it could not assert *only* that.
   */
  readonly forWork: boolean
}

type OpenOffer = {
  readonly fromAgentId: AgentId
  readonly accountId: string
  readonly toHandle: string
  readonly expiresAt: string
  readonly hasParcel: boolean
  /** Shared across siblings of a multi-account offer (`#1217`), else null. */
  readonly setId: string | null
}

const handleKey = (handle: string): string => handle.trim().toLowerCase()

export function fakeAccountOffers(): FakeAccountOffers {
  const accounts = new Map<string, HeldAccount>()
  const vaultEntries = new Set<string>()
  /** Plaintext a test put under a vault name, so accept can notice a PEM (`#1685`). */
  const vaultValues = new Map<string, string>()
  /** A subset of `vaultEntries`: still held, no longer the citizen's to use. */
  const spentEntries = new Set<string>()
  const handles = new Map<string, AgentId>()
  const offers = new Map<string, OpenOffer>()
  const confirmations = new Map<string, { accountId: string; toHandleKey: string }>()
  let sealingKey: string | undefined = 'a-fixture-sealing-key'

  const expiry = (): string =>
    new Date(Date.now() + TRANSFER_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString()

  /** Every open offer in the same set as `offerId`, including itself. */
  function setOf(offerId: string): OpenOffer[] {
    const open = offers.get(offerId)
    if (open === undefined) return []
    if (open.setId === null) return [open]
    return [...offers.values()].filter((member) => member.setId === open.setId)
  }

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
        // The storage default, which is what a declared row arrives with.
        forWork: true,
      })
      const held = accounts.get(id) as HeldAccount
      if (held.vaultKey !== null) {
        vaultEntries.add(`${agentId}:${held.vaultKey}`)
        if (account.vaultValue !== undefined) {
          vaultValues.set(`${agentId}:${held.vaultKey}`, account.vaultValue)
        }
      }
      return id
    },

    storeVaultEntry(agentId, key) {
      vaultEntries.add(`${agentId}:${key}`)
      // Writing a value makes a spent name live again, as the store does.
      spentEntries.delete(`${agentId}:${key}`)
    },

    forgetVaultEntry(agentId, key) {
      vaultEntries.delete(`${agentId}:${key}`)
      spentEntries.delete(`${agentId}:${key}`)
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

    isOpen(offerId) {
      return offers.has(offerId)
    },

    row(accountId) {
      return accounts.get(accountId)
    },

    rowsOf(agentId) {
      return [...accounts]
        .filter(([, held]) => held.ownerId === agentId)
        .map(([accountId, held]) => ({ ...held, accountId }))
    },

    holdsVaultEntry(agentId, key) {
      return vaultEntries.has(`${agentId}:${key}`)
    },

    spentVaultEntry(agentId, key) {
      return spentEntries.has(`${agentId}:${key}`)
    },

    give(command: GiveAccountCommand): Promise<GiveAccountOutcome> {
      if (sealingKey === undefined) return Promise.resolve({ outcome: 'unsealable' })

      const relatedIds = command.relatedAccountIds ?? []
      if (relatedIds.length > RELATED_ACCOUNTS_MAX) {
        return Promise.resolve({ outcome: 'related-invalid' })
      }
      const seen = new Set<string>([command.accountId])
      for (const id of relatedIds) {
        if (seen.has(id)) return Promise.resolve({ outcome: 'related-invalid' })
        seen.add(id)
      }

      const allIds = [command.accountId, ...relatedIds]
      const set: HeldAccount[] = []
      for (const id of allIds) {
        const account = accounts.get(id)
        if (account === undefined || account.ownerId !== command.fromAgentId) {
          return Promise.resolve({ outcome: 'unknown-account' })
        }
        set.push(account)
      }

      for (const account of set) {
        if (account.vaultKey === null) return Promise.resolve({ outcome: 'no-vault-key' })
      }

      const vaultKeysChecked = new Set<string>()
      for (const account of set) {
        const vaultKey = account.vaultKey as string
        if (vaultKeysChecked.has(vaultKey)) continue
        vaultKeysChecked.add(vaultKey)
        const entry = `${command.fromAgentId}:${vaultKey}`
        if (!vaultEntries.has(entry) || spentEntries.has(entry)) {
          return Promise.resolve({ outcome: 'nothing-to-give' })
        }
      }

      if (handles.get(handleKey(command.toHandle)) === command.fromAgentId) {
        return Promise.resolve({ outcome: 'self' })
      }

      for (const [offerId, open] of offers) {
        if (allIds.includes(open.accountId)) {
          return Promise.resolve({
            outcome: 'already-offered',
            offerId,
            toHandle: open.toHandle,
            expiresAt: open.expiresAt,
          })
        }
      }

      for (const account of set) {
        if (account.reachMailbox) return Promise.resolve({ outcome: 'reach-mailbox' })
      }

      /**
       * Confirm only for vault keys shared with accounts the giver is **keeping**
       * (`#1217`). Companions inside the set do not trip the pause.
       */
      const setIdSet = new Set(allIds)
      const sharedOutside: SharedVaultKeyAccount[] = []
      const vaultKeysForConfirm = new Set<string>()
      for (const account of set) {
        const vaultKey = account.vaultKey as string
        if (vaultKeysForConfirm.has(vaultKey)) continue
        vaultKeysForConfirm.add(vaultKey)
        for (const [id, held] of accounts) {
          if (held.ownerId !== command.fromAgentId) continue
          if (held.vaultKey !== vaultKey) continue
          if (setIdSet.has(id)) continue
          sharedOutside.push({ kind: held.kind, identifier: held.identifier })
        }
        for (const named of account.sharedWith) {
          if (
            sharedOutside.some(
              (one) => one.kind === named.kind && one.identifier === named.identifier,
            )
          ) {
            continue
          }
          // `sharedWith` is what the test author declared; honour it when the
          // named companion is not itself in the set.
          const companionInSet = set.some(
            (member) => member.kind === named.kind && member.identifier === named.identifier,
          )
          if (!companionInSet) sharedOutside.push(named)
        }
      }

      if (sharedOutside.length > 0) {
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
            sharedWith: sharedOutside,
          })
        }
        confirmations.delete(command.confirm as string)
      }

      const hasParcel = handles.has(handleKey(command.toHandle))
      const expiresAt = expiry()
      const setId = set.length > 1 ? randomUUID() : null
      const primaryOfferId = randomUUID()

      offers.set(primaryOfferId, {
        fromAgentId: command.fromAgentId,
        accountId: command.accountId,
        toHandle: command.toHandle,
        expiresAt,
        hasParcel,
        setId,
      })

      const related = set.slice(1).map((account, index) => {
        const relatedOfferId = randomUUID()
        offers.set(relatedOfferId, {
          fromAgentId: command.fromAgentId,
          accountId: allIds[index + 1] as string,
          toHandle: command.toHandle,
          expiresAt,
          hasParcel,
          setId,
        })
        return {
          kind: account.kind,
          identifier: account.identifier,
          provider: account.provider,
        }
      })

      return Promise.resolve({
        outcome: 'offered',
        offerId: primaryOfferId,
        toHandle: command.toHandle,
        expiresAt,
        accountKind: set[0]!.kind,
        accountIdentifier: set[0]!.identifier,
        accountProvider: set[0]!.provider,
        related,
      })
    },

    withdraw(command) {
      const open = offers.get(command.offerId)
      if (open === undefined || open.fromAgentId !== command.fromAgentId) {
        return Promise.resolve({ outcome: 'unknown' as const })
      }
      for (const [id, member] of offers) {
        if (member === open || (open.setId !== null && member.setId === open.setId)) {
          offers.delete(id)
        }
      }
      return Promise.resolve({ outcome: 'withdrawn' as const })
    },

    /**
     * The recipient's half, in the storage's own check order (`#1126`).
     *
     * **Every refusal is answered before anything is opened.** The parcel is
     * single-use in the real storage, so a check made after the credential has
     * been unsealed would spend an offer to tell the recipient it cannot have
     * it — and the recipient's own retry would then find nothing. The order
     * here is the order there, which is the part worth reproducing.
     *
     * **A parcel-less offer is `unknown`, and it is the same `unknown` as an
     * id nobody ever issued.** That is decision 5 arriving on this side: an
     * offer written to a handle nobody holds cannot be accepted by anybody, so
     * there is no recipient to answer and nothing to distinguish.
     *
     * Multi-account offers (`#1217`) move every member or none.
     */
    accept(command, _recipientToken) {
      const open = offers.get(command.offerId)
      const addressee = open === undefined ? undefined : handles.get(handleKey(open.toHandle))
      if (open === undefined || !open.hasParcel || addressee !== command.toAgentId) {
        return Promise.resolve({ outcome: 'unknown' as const })
      }

      const members = setOf(command.offerId)
      if (members.length === 0) return Promise.resolve({ outcome: 'unknown' as const })

      const memberAccounts: { offer: OpenOffer; account: HeldAccount; accountId: string }[] = []
      for (const member of members) {
        const accountId = [...accounts].find(
          ([id, held]) => id === member.accountId && held.ownerId === member.fromAgentId,
        )?.[0]
        if (accountId === undefined) return Promise.resolve({ outcome: 'unknown' as const })
        const account = accounts.get(accountId)
        if (account === undefined || account.vaultKey === null) {
          return Promise.resolve({ outcome: 'unknown' as const })
        }
        memberAccounts.push({ offer: member, account, accountId })
      }

      // Primary first (the named offer), then the rest in insertion order.
      const ordered = [
        memberAccounts.find((member) => member.offer === open)!,
        ...memberAccounts.filter((member) => member.offer !== open),
      ]

      const primaryVaultKey = ordered[0]!.account.vaultKey as string
      const recipientKeyBySource = new Map<string, string>([[primaryVaultKey, command.vaultKey]])
      const relatedKeys = command.relatedVaultKeys ?? []
      let relatedKeyIndex = 0
      const distinctSourceKeys = new Set(
        ordered
          .map((member) => member.account.vaultKey)
          .filter((key): key is string => key !== null && key.trim() !== ''),
      )
      for (const member of ordered.slice(1)) {
        const sourceKey = member.account.vaultKey as string
        if (recipientKeyBySource.has(sourceKey)) continue
        const named = relatedKeys[relatedKeyIndex]
        relatedKeyIndex += 1
        if (named === undefined || named.trim() === '') {
          return Promise.resolve({
            outcome: 'keys-incomplete' as const,
            needed: distinctSourceKeys.size,
            named: 1 + relatedKeys.filter((key) => key.trim() !== '').length,
          })
        }
        recipientKeyBySource.set(sourceKey, named)
      }

      for (const destKey of new Set(recipientKeyBySource.values())) {
        if (vaultEntries.has(`${command.toAgentId}:${destKey}`)) {
          return Promise.resolve({ outcome: 'key-taken' as const })
        }
      }

      for (const member of ordered) {
        const clash = [...accounts.values()].some(
          (held) =>
            held.ownerId === command.toAgentId &&
            held.kind === member.account.kind &&
            held.identifier.toLowerCase() === member.account.identifier.toLowerCase(),
        )
        if (clash) return Promise.resolve({ outcome: 'already-held' as const })
      }

      const arrived: {
        accountId: string
        kind: string
        identifier: string
        provider: string | null
        vaultKey: string
      }[] = []
      for (const member of ordered) {
        const destKey = recipientKeyBySource.get(member.account.vaultKey as string)!
        vaultEntries.add(`${command.toAgentId}:${destKey}`)
        const accountId = randomUUID()
        accounts.set(accountId, {
          ownerId: command.toAgentId,
          kind: member.account.kind,
          identifier: member.account.identifier,
          provider: member.account.provider,
          proved: false,
          vaultKey: destKey,
          reachMailbox: false,
          sharedWith: [],
          forWork: false,
        })
        arrived.push({
          accountId,
          kind: member.account.kind,
          identifier: member.account.identifier,
          provider: member.account.provider,
          vaultKey: destKey,
        })
        accounts.delete(member.accountId)
      }

      for (const [id, member] of offers) {
        if (member === open || (open.setId !== null && member.setId === open.setId)) {
          offers.delete(id)
        }
      }

      const spentKeys = new Set<string>()
      for (const member of ordered) {
        const vaultKey = member.account.vaultKey
        if (vaultKey === null || spentKeys.has(vaultKey)) continue
        spentKeys.add(vaultKey)
        const stillMine = [...accounts.values()].some(
          (held) => held.ownerId === member.account.ownerId && held.vaultKey === vaultKey,
        )
        if (!stillMine) spentEntries.add(`${member.account.ownerId}:${vaultKey}`)
      }

      const primary = arrived[0]!
      let noticed: CredentialFinding | undefined
      for (const member of ordered) {
        const vaultKey = member.account.vaultKey
        if (vaultKey === null) continue
        const plaintext = vaultValues.get(`${member.account.ownerId}:${vaultKey}`)
        if (plaintext === undefined) continue
        const finding = keyMaterialFinding(plaintext)
        if (finding !== null) {
          noticed = finding
          break
        }
      }
      return Promise.resolve({
        outcome: 'accepted' as const,
        accountId: primary.accountId,
        accountKind: primary.kind,
        accountIdentifier: primary.identifier,
        accountProvider: primary.provider,
        vaultKey: primary.vaultKey,
        fromHandle: giverHandle(open.fromAgentId),
        related: arrived.slice(1),
        ...(noticed === undefined ? {} : { noticed }),
      })
    },

    /** No reason asked for, none recorded, and the giver's row untouched. */
    decline(command) {
      const open = offers.get(command.offerId)
      const addressee = open === undefined ? undefined : handles.get(handleKey(open.toHandle))
      if (open === undefined || addressee !== command.toAgentId) {
        return Promise.resolve({ outcome: 'unknown' as const })
      }
      for (const [id, member] of offers) {
        if (member === open || (open.setId !== null && member.setId === open.setId)) {
          offers.delete(id)
        }
      }
      return Promise.resolve({ outcome: 'declined' as const })
    },
  }

  /** The giver's handle, or a stand-in when the test never registered one. */
  function giverHandle(agentId: AgentId): string {
    for (const [key, id] of handles) if (id === agentId) return key
    return 'a-citizen'
  }
}
