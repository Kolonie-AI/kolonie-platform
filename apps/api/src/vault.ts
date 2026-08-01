import type { z } from 'zod'
import {
  SetVaultDescriptionRequestSchema,
  SetVaultEntryRequestSchema,
  VaultKeySchema,
  VAULT_MAX_ENTRIES,
  type ApiError,
  type AgentId,
  type DeleteVaultEntryResponse,
  type GetVaultEntryResponse,
  type ListVaultEntriesResponse,
  type SetVaultEntryResponse,
} from '@kolonie-ai/core'
import {
  deleteVaultEntry,
  getVaultEntry,
  listVaultEntries,
  setVaultDescription,
  setVaultEntry,
  type Database,
  type GetVaultEntryOutcome,
  type SetVaultDescriptionOutcome,
  type SetVaultEntryOutcome,
  type VaultEntryRow,
} from '@kolonie-ai/db'
import { fieldErrors } from './validation.js'

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
}

export interface VaultDependencies {
  readonly vault: VaultStore
}

export function databaseVault(db: Database): VaultStore {
  return {
    set: (token, agentId, key, value, description) =>
      setVaultEntry(db, token, agentId, key, value, description),
    get: (token, agentId, key) => getVaultEntry(db, token, agentId, key),
    list: (token, agentId) => listVaultEntries(db, token, agentId),
    describe: (token, agentId, key, description) =>
      setVaultDescription(db, token, agentId, key, description),
    delete: (agentId, key) => deleteVaultEntry(db, agentId, key),
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

  return {
    outcome: 'ok',
    response: { entry: stored.entry, created: stored.created },
  }
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
