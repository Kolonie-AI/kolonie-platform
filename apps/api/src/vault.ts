import type { z } from 'zod'
import {
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
  setVaultEntry,
  type Database,
  type GetVaultEntryOutcome,
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
  set(token: string, agentId: AgentId, key: string, value: string): Promise<SetVaultEntryOutcome>
  get(token: string, agentId: AgentId, key: string): Promise<GetVaultEntryOutcome>
  /** No token: listing decrypts nothing. See `listVaultEntries` in `packages/db`. */
  list(agentId: AgentId): Promise<readonly VaultEntryRow[]>
  /** No token either — an entry whose key is lost must still be removable. */
  delete(agentId: AgentId, key: string): Promise<boolean>
}

export interface VaultDependencies {
  readonly vault: VaultStore
}

export function databaseVault(db: Database): VaultStore {
  return {
    set: (token, agentId, key, value) => setVaultEntry(db, token, agentId, key, value),
    get: (token, agentId, key) => getVaultEntry(db, token, agentId, key),
    list: (agentId) => listVaultEntries(db, agentId),
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

  const stored = await deps.vault.set(token, agentId, named.key, parsed.data.value)

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

/** What this citizen has stored, by name. No values, and nothing decrypted. */
export async function listVault(
  agentId: AgentId,
  deps: VaultDependencies,
): Promise<VaultOutcome<ListVaultEntriesResponse>> {
  const entries = await deps.vault.list(agentId)

  return {
    outcome: 'ok',
    response: { entries: [...entries], maxEntries: VAULT_MAX_ENTRIES },
  }
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
