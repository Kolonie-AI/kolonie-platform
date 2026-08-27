import type { z } from 'zod'
import {
  SetVaultDescriptionRequestSchema,
  SetVaultEntryRequestSchema,
  ConversationIdSchema,
  ShareVaultEntryRequestSchema,
  VaultKeySchema,
  VAULT_MAX_ENTRIES,
  VAULT_SHARE_DEFAULT_DAYS,
  VAULT_SHARE_MAX_DAYS,
  keyMaterialFinding,
  keyMaterialNotice,
  keyMaterialRefused,
  type ApiError,
  type AgentId,
  type DeleteVaultEntryResponse,
  type GetVaultEntryResponse,
  type ListVaultEntriesResponse,
  type Log,
  type SetVaultEntryResponse,
  type ShareVaultEntryResponse,
  type Timestamp,
  type UnshareVaultEntryResponse,
  type VaultShareNotifyStatus,
} from '@kolonie-ai/core'
import {
  attachShareToConversation,
  deleteVaultEntry,
  getVaultEntry,
  listVaultEntries,
  operatorOf,
  setVaultDescription,
  setVaultEntry,
  shareVaultEntry as shareVaultEntryInDatabase,
  unshareVaultEntry as unshareVaultEntryInDatabase,
  type Database,
  type GetVaultEntryOutcome,
  type SetVaultDescriptionOutcome,
  type SetVaultEntryOutcome,
  type ShareVaultEntryOutcome,
  type UnshareVaultEntryOutcome,
  type VaultEntryRow,
  type VaultShareRow,
} from '@kolonie-ai/db'
import { fieldErrors } from './validation.js'
import type { VaultShareNotifier } from './vault-share-notifier.js'

/**
 * Everything the vault needs from the outside world.
 *
 * The same seam every other surface here has, and it carries one thing none of
 * the others do: **the citizen's plaintext key, as a parameter on the two calls
 * that need it**. It is not on the store, not on a request context and not
 * captured in a closure, because the vault's whole claim is that the plaintext
 * exists for the length of one request and is then gone. A field somewhere would
 * make that a matter of discipline rather than of shape.
 */
export interface VaultStore {
  set(
    token: string,
    agentId: AgentId,
    key: string,
    value: string,
    description?: string | undefined,
  ): Promise<SetVaultEntryOutcome>
  get(token: string, agentId: AgentId, key: string): Promise<GetVaultEntryOutcome>
  /**
   * **The token is here since `#154`**, where the comment used to say a listing
   * decrypts nothing.
   *
   * It still decrypts no *values*, which is the property that mattered — what it
   * opens is at most `VAULT_MAX_ENTRIES` short descriptions, on a call that
   * already holds the key because it is already authenticated.
   */
  list(token: string, agentId: AgentId): Promise<readonly VaultEntryRow[]>
  /** Writing or clearing the description alone, without the value being re-sent. */
  describe(
    token: string,
    agentId: AgentId,
    key: string,
    description: string | null,
  ): Promise<SetVaultDescriptionOutcome>
  /** No token — an entry whose key is lost must still be removable. */
  delete(agentId: AgentId, key: string): Promise<boolean>
  /**
   * Hand one entry to this citizen's operator (`#1439`).
   *
   * **The token, and never the value.** The store reads the entry with the key
   * the caller is presenting and re-seals a copy under the Colony's own — which
   * is what keeps the secret out of the request that shares it.
   *
   * `undefined` when this deployment has no sealing key. The channel is then not
   * offered rather than half-built, which is the shape `DropStore` already has.
   */
  share?:
    | ((input: {
        readonly token: string
        readonly agentId: AgentId
        readonly key: string
        readonly purpose: string
        readonly days?: number | undefined
      }) => Promise<ShareVaultEntryOutcome>)
    | undefined
  /**
   * Attach an open share to a thread the citizen is in (`#1441`).
   *
   * Separate from `share` rather than folded into it, because a share with no
   * thread is an ordinary share and the two failures are different: sharing can
   * fail on the entry, attaching can fail on the conversation, and a citizen
   * told *refused* wants to know which.
   */
  attach?:
    | ((
        agentId: AgentId,
        conversationId: string,
        shareId: string,
      ) => Promise<'attached' | 'not-a-participant'>)
    | undefined
  /** End a share and hand back what the operator wrote, once. */
  unshare?: ((agentId: AgentId, key: string) => Promise<UnshareVaultEntryOutcome>) | undefined
  /**
   * Whether anybody could ever read what this citizen shares (`#918`, `#1439`).
   *
   * The same precondition `openHandover` checks, and it is here for the reason
   * it is there: from the citizen's side *nobody has looked yet* and *nobody
   * could ever look* are the same silence, and only one of them is fixable.
   */
  hasOperator?: ((agentId: AgentId) => Promise<boolean>) | undefined
}

export interface VaultDependencies {
  readonly vault: VaultStore
  /** The one knock on a bound operator channel; absent is reported, never refused. */
  readonly notifier?: VaultShareNotifier | undefined
  /** Used only when a notifier throws across its own non-failing contract. */
  readonly log?: Log | undefined
}

export function databaseVault(db: Database, sealingKey?: string | undefined): VaultStore {
  return {
    set: (token, agentId, key, value, description) =>
      setVaultEntry(db, token, agentId, key, value, description),
    get: (token, agentId, key) => getVaultEntry(db, token, agentId, key),
    list: (token, agentId) => listVaultEntries(db, token, agentId),
    describe: (token, agentId, key, description) =>
      setVaultDescription(db, token, agentId, key, description),
    delete: (agentId, key) => deleteVaultEntry(db, agentId, key),
    /**
     * Sharing exists only where a sealing key does.
     *
     * `OPERATOR_DROP_SEALING_KEY`, unrenamed (`#1437` decision 5): it already
     * seals thread slots and account offers, so a share needs no new secret
     * provisioned and a deployment that carries the other channels carries this
     * one for free.
     */
    ...(sealingKey === undefined
      ? {}
      : {
          share: (input) => shareVaultEntryInDatabase(db, { ...input, sealingKey }),
          unshare: (agentId, key) => unshareVaultEntryInDatabase(db, agentId, key, sealingKey),
          attach: (agentId, conversation, shareId) =>
            attachShareToConversation(
              db,
              agentId,
              ConversationIdSchema.parse(conversation),
              shareId,
            ),
        }),
    hasOperator: async (agentId) => (await operatorOf(db, agentId)) !== undefined,
  }
}

/** Every vault operation answers in this shape. */
export type VaultOutcome<T> =
  | { readonly outcome: 'ok'; readonly response: T }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

/**
 * Why a `conflict` was returned, in a form an agent can branch on.
 *
 * Two genuinely different situations share the 409, and prose is not something
 * an agent can act on (AGENTS.md §3). Rather than mint a new error code for each
 * — codes are the stable half of the contract and are expensive to add — the
 * discriminator rides in `details.reason`, which is the pattern `ApiErrorSchema`
 * already documents for `level_locked` and `rate_limited`.
 */
export const VAULT_FULL = 'vault_full'
export const VAULT_SEALED_WITH_ANOTHER_KEY = 'sealed_with_another_key'
/** The account this entry opened was given away, and custody went with it (`#1214`). */
export const VAULT_SPENT = 'credential_transferred'
/** A person can currently read this entry, so it may not be written (`#1439`). */
export const VAULT_SHARED = 'shared_with_operator'
/** This entry would put the nominated recovery factor behind the key it must survive. */
export const VAULT_RECOVERY_FACTOR = 'nominated_recovery_factor'

/**
 * The name in the path, checked before anything touches the database.
 *
 * A path segment rather than a body field, so the error is keyed `key` rather
 * than `body.key` — an agent reading `details` should find the thing it can
 * actually change.
 */
function readKey(raw: string | undefined): { key: string } | { error: ApiError } {
  const parsed = VaultKeySchema.safeParse(raw)
  if (parsed.success) return { key: parsed.data }

  return {
    error: {
      code: 'validation_failed',
      message: 'That is not a usable vault key.',
      details: { key: parsed.error.issues[0]?.message ?? 'invalid' },
    },
  }
}

/**
 * Store a secret under a name.
 *
 * **Idempotent by name**, which is what an agent that crashed mid-task needs: it
 * writes the mailbox password it just minted, and if it is not sure whether the
 * write landed it writes it again. The answer says which of the two happened.
 */
export async function storeVaultEntry(
  token: string,
  agentId: AgentId,
  rawKey: string | undefined,
  body: unknown,
  deps: VaultDependencies,
): Promise<VaultOutcome<SetVaultEntryResponse>> {
  const named = readKey(rawKey)
  if ('error' in named) return { outcome: 'rejected', error: named.error }

  const parsed = SetVaultEntryRequestSchema.safeParse(body)
  if (!parsed.success) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message: 'The request could not be read as documented.',
        details: fieldErrors(parsed.error),
      },
    }
  }

  /**
   * A PEM private-key block is the one class this write will not hold (`#1685`).
   *
   * **Before the store, so a refusal leaves nothing behind.** The other findings
   * `credentialFinding` names — a labelled password, a TOTP URI, a vendor key,
   * a high-entropy run — are what a vault is for.
   */
  const keyMaterial = keyMaterialFinding(parsed.data.value)
  if (keyMaterial !== null) {
    return { outcome: 'rejected', error: keyMaterialRefused(keyMaterial) }
  }

  const stored = await deps.vault.set(
    token,
    agentId,
    named.key,
    parsed.data.value,
    parsed.data.description,
  )

  if (stored.outcome === 'full') {
    return {
      outcome: 'rejected',
      error: {
        code: 'conflict',
        message:
          `Your vault already holds ${stored.maxEntries} entries, which is the limit. ` +
          'Delete something you no longer need — kolonie.vault.list shows what is in there. ' +
          'Replacing an entry you already hold is always allowed, however full it is.',
        details: { reason: VAULT_FULL, maxEntries: String(stored.maxEntries) },
      },
    }
  }

  if (stored.outcome === 'shared') {
    return {
      outcome: 'rejected',
      error: {
        code: 'conflict',
        message:
          `"${named.key}" is shared with your operator until ${stored.share.expiresAt}, so it ` +
          'cannot be written while they are holding it. What they can read is a copy taken when ' +
          'the share opened; writing underneath it would leave them working from a credential ' +
          'you have already replaced. Take it back with kolonie.vault.unshare — that also hands ' +
          'you anything they wrote — and then store the new value.',
        details: { reason: VAULT_SHARED, expiresAt: stored.share.expiresAt },
      },
    }
  }

  if (stored.outcome === 'recovery-factor') {
    return {
      outcome: 'rejected',
      error: {
        code: 'conflict',
        message:
          `Your account register says "${named.key}" opens the account you nominated for ` +
          'credential recovery. A vault entry is sealed under your API key and does not survive ' +
          'losing that key, so storing this factor here would make recovery fail exactly when you ' +
          'need it. Clear the account’s vaultKey with kolonie.accounts.set or nominate a different ' +
          'recovery account before storing this entry.',
        details: { reason: VAULT_RECOVERY_FACTOR, vaultKey: named.key },
      },
    }
  }

  return {
    outcome: 'ok',
    response: { entry: stored.entry, created: stored.created },
  }
}

/**
 * The refusal a citizen with nobody linked gets, on both share calls (`#1439`).
 *
 * **The same shape `openHandover` uses and for the same measured reason.** A
 * share is read by a person, and a person the Colony has no link to has no
 * surface to read it on: the value would sit sealed, the window would run, and
 * it would be destroyed unread. From the agent's side that is indistinguishable
 * from an operator who simply has not looked yet — which is the failure `#918`
 * cost a citizen six days.
 */
const NOBODY_LINKED: ApiError = {
  code: 'validation_failed',
  message:
    'Nobody could read this. A share is read by the person linked to you, and no person is ' +
    'linked — so it would sit sealed until it expired and nobody would ever have seen it. ' +
    'kolonie.operator.link is the one call that changes that: your operator generates a code in ' +
    'their console, you redeem it, and the durable page they already hold starts showing what ' +
    'you share.',
}

/** The refusal when this deployment was never given a sealing key. */
const NO_SEALING_KEY: ApiError = {
  code: 'rung_unavailable',
  message:
    'This Colony has no sealing key configured, so it cannot carry a secret to a person at all. ' +
    'Nothing is wrong with your request and there is nothing you can do about it — ' +
    'kolonie.support.open reaches somebody who can configure it.',
}

/**
 * Hand one entry to this citizen's operator, for a bounded time (`#1439`).
 *
 * **The value is not in the request and is not in the answer.** The key is what
 * travels; the Colony opens the entry with the token this call already carries,
 * re-seals a copy under its own, and hands back the entry with its share on it.
 */
export async function shareVaultEntry(
  token: string,
  agentId: AgentId,
  agentName: string,
  rawKey: string | undefined,
  body: unknown,
  deps: VaultDependencies,
): Promise<VaultOutcome<ShareVaultEntryResponse>> {
  const named = readKey(rawKey)
  if ('error' in named) return { outcome: 'rejected', error: named.error }

  const share = deps.vault.share
  if (share === undefined) return { outcome: 'rejected', error: NO_SEALING_KEY }

  const parsed = ShareVaultEntryRequestSchema.safeParse(body)
  if (!parsed.success) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message:
          'Send {"purpose": "<why they are being shown this>"}, and "days": <up to ' +
          `${VAULT_SHARE_MAX_DAYS}> if ${VAULT_SHARE_DEFAULT_DAYS} is not what you want. ` +
          'There is no field for the value: the Colony reads the entry itself, which is what ' +
          'keeps the secret out of this request.',
        details: fieldErrors(parsed.error),
      },
    }
  }

  /**
   * **Checked before anything is opened**, so that a citizen with no operator
   * never has its plaintext decrypted into this process to answer a call that
   * was always going to be refused.
   */
  if (deps.vault.hasOperator !== undefined && !(await deps.vault.hasOperator(agentId))) {
    return { outcome: 'rejected', error: NOBODY_LINKED }
  }

  const shared = await share({
    token,
    agentId,
    key: named.key,
    purpose: parsed.data.purpose,
    days: parsed.data.days,
  })

  if (shared.outcome === 'unknown') {
    return {
      outcome: 'rejected',
      error: { code: 'not_found', message: `You have nothing stored under "${named.key}".` },
    }
  }

  if (shared.outcome === 'spent') {
    return {
      outcome: 'rejected',
      error: {
        code: 'conflict',
        message:
          `The account "${named.key}" opened belongs to another citizen now, and the credential ` +
          'went with it. Sharing it would send a person to use an account that is not yours. ' +
          'Write something new under the name and it is live again.',
        details: { reason: VAULT_SPENT },
      },
    }
  }

  if (shared.outcome === 'unreadable') {
    return {
      outcome: 'rejected',
      error: {
        code: 'conflict',
        message:
          `Something is stored under "${named.key}" and it was sealed with a different API key ` +
          'from the one you are presenting, so there is nothing here that could be copied. ' +
          'Nothing can recover it — store the value again to replace it, then share that.',
        details: { reason: VAULT_SEALED_WITH_ANOTHER_KEY },
      },
    }
  }

  /**
   * Attached after the share exists, and a refusal here does not undo it
   * (`#1441`).
   *
   * The share is the thing that was asked for; the thread is where it is being
   * talked about. A citizen that named a conversation it is not in has made one
   * mistake, and taking the share away as well would make it two — the entry is
   * shared, the answer says which thread it did *not* land on, and
   * `kolonie.vault.unshare` is one call away if that was not what was wanted.
   */
  let attachedTo: string | null = null

  if (parsed.data.conversationId !== undefined && deps.vault.attach !== undefined) {
    const attached = await deps.vault.attach(agentId, parsed.data.conversationId, shared.shareId)
    if (attached === 'attached') attachedTo = parsed.data.conversationId
  }

  /**
   * The share and its attachment are already durable before a channel is tried.
   * A notification is a way back to the share, not a condition of its existence.
   */
  let notifyStatus: VaultShareNotifyStatus = 'undeliverable'
  if (deps.notifier !== undefined) {
    try {
      notifyStatus = await deps.notifier.notify({
        agentId,
        agentName,
        purpose: parsed.data.purpose,
      })
    } catch (error) {
      deps.log?.warn('a vault share notification failed outside its adapter', {
        event: 'vault.share.notify.failed',
        channel: 'unknown',
        reason: error instanceof Error ? error.name : 'unknown',
      })
    }
  }

  const read = await deps.vault.get(token, agentId, named.key)

  return {
    outcome: 'ok',
    response: {
      // The entry as it now stands, share included. Read back rather than
      // assembled here, so that what a citizen is told after sharing is exactly
      // what `kolonie.vault.list` will tell it on the next waking.
      entry: entryOr(read, named.key, shared.share),
      extended: shared.extended,
      notifyStatus,
      attachedTo,
    },
  }
}

/**
 * Take a share back, and collect whatever the operator left in it.
 *
 * **The entry is untouched.** What ends is the copy. The addition comes back
 * here exactly once, because after this the Colony no longer holds it and could
 * not seal it into the vault in any case — see `#1437` decision 4.
 */
export async function unshareVaultEntry(
  token: string,
  agentId: AgentId,
  rawKey: string | undefined,
  deps: VaultDependencies,
): Promise<VaultOutcome<UnshareVaultEntryResponse>> {
  const named = readKey(rawKey)
  if ('error' in named) return { outcome: 'rejected', error: named.error }

  const unshare = deps.vault.unshare
  if (unshare === undefined) return { outcome: 'rejected', error: NO_SEALING_KEY }

  const ended = await unshare(agentId, named.key)

  if (ended.outcome === 'not-shared') {
    return {
      outcome: 'rejected',
      error: {
        code: 'not_found',
        message:
          `"${named.key}" is not shared with anybody, so there was nothing to take back. It may ` +
          'never have been shared, or you may have taken it back already — kolonie.vault.list ' +
          'names every entry a person can currently read.',
      },
    }
  }

  const read = await deps.vault.get(token, agentId, named.key)

  return {
    outcome: 'ok',
    response: {
      key: named.key,
      operatorAddition: ended.operatorAddition,
      reads: ended.reads,
      handedBackByOperator: ended.handedBackByOperator,
      entry: entryOr(read, named.key, null),
      ...keyMaterialNotice(ended.operatorAddition),
    },
  }
}

/**
 * The entry a read answered with, or the little that can honestly be said when
 * it answered with no entry at all.
 *
 * **`unreadable` is the case that makes this necessary, not `unknown`.** A
 * citizen that rotated its key still has to be told what it just shared or took
 * back, and `getVaultEntry` reports an unopenable row as `unreadable` with no
 * entry on it. The fallback invents nothing: the description is the absence it
 * is, and the timestamps are the share's own rather than a guess at the row's.
 */
function entryOr(
  read: GetVaultEntryOutcome,
  key: string,
  share: VaultShareRow | null,
): VaultEntryRow {
  if (read.outcome === 'found' || read.outcome === 'spent') return read.entry

  const stamp = (share === null ? new Date().toISOString() : share.sharedAt) as Timestamp
  return { key, description: null, spentAt: null, share, createdAt: stamp, updatedAt: stamp }
}

/**
 * Read one secret back.
 *
 * The one endpoint in the Colony that returns something the Colony cannot read
 * itself, and the only one whose answer depends on *which* valid credential was
 * presented rather than on which citizen holds it.
 */
export async function readVaultEntry(
  token: string,
  agentId: AgentId,
  rawKey: string | undefined,
  deps: VaultDependencies,
): Promise<VaultOutcome<GetVaultEntryResponse>> {
  const named = readKey(rawKey)
  if ('error' in named) return { outcome: 'rejected', error: named.error }

  const read = await deps.vault.get(token, agentId, named.key)

  if (read.outcome === 'unknown') {
    return {
      outcome: 'rejected',
      error: {
        code: 'not_found',
        message: `You have nothing stored under "${named.key}".`,
      },
    }
  }

  if (read.outcome === 'spent') {
    return {
      outcome: 'rejected',
      error: {
        code: 'conflict',
        message:
          `The account "${named.key}" opened is another citizen's now, and the credential went ` +
          'with it when the offer was accepted. What is sealed under that name is still ' +
          'sealed and is not handed back: reading it would tell you that you still hold an ' +
          'account you gave away. The entry is yours to delete, to describe, and to write ' +
          'something new into — a value you store under it now is live again.',
        details: { reason: VAULT_SPENT, spentAt: read.entry.spentAt ?? '' },
      },
    }
  }

  if (read.outcome === 'unreadable') {
    return {
      outcome: 'rejected',
      error: {
        code: 'conflict',
        message:
          `Something is stored under "${named.key}", and it was sealed with a different API ` +
          'key from the one you are presenting. Nothing can recover it — the Colony holds only ' +
          'a hash of the key that wrote it. Store the value again to replace it, or delete it.',
        details: { reason: VAULT_SEALED_WITH_ANOTHER_KEY },
      },
    }
  }

  return { outcome: 'ok', response: { entry: read.entry, value: read.value } }
}

/**
 * What this citizen has stored: names and descriptions, never values.
 *
 * **The description is in the list because that is the entire point of having
 * one** (`#154`). A description a citizen has to fetch per entry is a
 * description it will not read, and the failure being repaired is an agent
 * waking to forty labels it cannot tell apart.
 */
export async function listVault(
  token: string,
  agentId: AgentId,
  deps: VaultDependencies,
): Promise<VaultOutcome<ListVaultEntriesResponse>> {
  const entries = await deps.vault.list(token, agentId)

  return {
    outcome: 'ok',
    response: { entries: [...entries], maxEntries: VAULT_MAX_ENTRIES },
  }
}

/**
 * Write or clear an entry's description, without the value being re-sent.
 *
 * A 404 when there is no such entry, for the reason `forgetVaultEntry` gives: an
 * agent describing something it does not hold has usually misremembered a name,
 * and a cheerful 200 would hide that.
 */
export async function describeVaultEntry(
  token: string,
  agentId: AgentId,
  rawKey: string | undefined,
  body: unknown,
  deps: VaultDependencies,
): Promise<VaultOutcome<SetVaultEntryResponse>> {
  const named = readKey(rawKey)
  if ('error' in named) return { outcome: 'rejected', error: named.error }

  const parsed = SetVaultDescriptionRequestSchema.safeParse(body)
  if (!parsed.success) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message:
          'Send {"description": "<what this entry is>"} or {"description": null} to clear it.',
        details: fieldErrors(parsed.error),
      },
    }
  }

  const described = await deps.vault.describe(token, agentId, named.key, parsed.data.description)

  if (described.outcome === 'unknown') {
    return {
      outcome: 'rejected',
      error: {
        code: 'not_found',
        message: `You have nothing stored under "${named.key}".`,
      },
    }
  }

  // `created: false` is the honest answer: nothing was created, and the field
  // means what it means on the write path rather than being repurposed here.
  return { outcome: 'ok', response: { entry: described.entry, created: false } }
}

/**
 * Forget one entry.
 *
 * A 404 when there was nothing to forget, rather than a cheerful 200. The agent
 * asked the Colony to remove a specific thing, and *"there was no such thing"*
 * is a fact it may want — most often because it misremembered the name and the
 * secret it meant to destroy is still sitting there under another one.
 */
export async function forgetVaultEntry(
  agentId: AgentId,
  rawKey: string | undefined,
  deps: VaultDependencies,
): Promise<VaultOutcome<DeleteVaultEntryResponse>> {
  const named = readKey(rawKey)
  if ('error' in named) return { outcome: 'rejected', error: named.error }

  const deleted = await deps.vault.delete(agentId, named.key)

  if (!deleted) {
    return {
      outcome: 'rejected',
      error: {
        code: 'not_found',
        message: `You have nothing stored under "${named.key}", so there was nothing to delete.`,
      },
    }
  }

  return { outcome: 'ok', response: { key: named.key, deleted: true } }
}

/**
 * The value argument, as the MCP tool declares it.
 *
 * Taken from the core schema rather than redeclared, so the limit an agent is
 * told about over MCP is the limit the API enforces.
 */
export const VaultValueArgumentSchema: z.ZodString = SetVaultEntryRequestSchema.shape.value

/**
 * The description argument, taken from core for the same reason.
 *
 * `SetVaultDescriptionRequestSchema` rather than the optional field on the write
 * request, because this is the one that carries the nullable form — the tool
 * that clears a description needs to be able to say null.
 */
export const VaultDescriptionArgumentSchema: z.ZodString =
  SetVaultEntryRequestSchema.shape.description.unwrap()
