import { VAULT_MAX_ENTRIES, type AgentId } from '@kolonie-ai/core'
import type { GetVaultEntryOutcome, SetVaultEntryOutcome, VaultEntryRow } from '@kolonie-ai/db'
import type { VaultDependencies, VaultStore } from '../vault.js'

/**
 * An in-memory stand-in for the vault's storage.
 *
 * **It reproduces the *rule* that a value opens only for the token that wrote
 * it, and it does so without encrypting anything** — it keeps the sealing token
 * beside the value and compares. That is not a shortcut that weakens the test:
 * whether AES-256-GCM actually holds is asserted in `packages/db`, against the
 * real primitive, by `vault-crypto.test.ts`. Reimplementing the cipher here
 * would only prove this fake agrees with itself, and a fake that encrypts is one
 * a reader has to check before trusting the tests built on it.
 *
 * What `apps/api` is on the hook for is different and is what this exercises:
 * that the plaintext key reaches the store at all, that the three outcomes reach
 * the caller as the right status codes, and that a listing carries no values.
 */
export interface FakeVault extends VaultStore {
  /** Everything held, as `(agentId, key)` → the value. For assertions only. */
  readonly contents: () => ReadonlyMap<string, string>
  /** Fill a citizen's vault to the quota without going through the API. */
  readonly fill: (agentId: AgentId, entries?: number) => void
  /**
   * Move this citizen's entries from one token to another (`#1127`).
   *
   * The same rule the real `reSealVault` follows, expressed in the terms this
   * fake works in: a row whose sealing token is `from` gets `to`, a row sealed
   * under anything else is left exactly as it is and counted, and `updatedAt`
   * does not move because the value did not change. It is here rather than on
   * `VaultStore` because no MCP surface calls it — rotation reaches it through
   * storage, and this is what lets `fakeRotation` model that.
   */
  readonly reSeal: (
    agentId: AgentId,
    from: string,
    to: string,
  ) => { resealed: number; unreadable: number }
}

interface Held {
  readonly token: string
  readonly value: string
  /**
   * Sealed the same way the value is in this fake — kept beside the token that
   * wrote it (#154). A description written with one key and read with another
   * comes back null here exactly as it does in the real store, which is the
   * behaviour `apps/api` is on the hook for: one unopenable row must not fail a
   * listing.
   */
  description: string | null
  readonly createdAt: string
  updatedAt: string
}

export function fakeVault(): FakeVault {
  const held = new Map<string, Held>()
  const at = (agentId: AgentId | string, key: string) => `${String(agentId)}\0${key}`

  const keysOf = (agentId: AgentId) =>
    [...held.keys()].filter((composite) => composite.startsWith(`${String(agentId)}\0`))

  const store: VaultStore = {
    set: async (token, agentId, key, value, description): Promise<SetVaultEntryOutcome> => {
      const existing = held.get(at(agentId, key))

      // The quota gates new names only — an agent must always be able to
      // rewrite something it already holds. Same rule as the real store.
      if (existing === undefined && keysOf(agentId).length >= VAULT_MAX_ENTRIES) {
        return { outcome: 'full', maxEntries: VAULT_MAX_ENTRIES }
      }

      const now = new Date().toISOString()
      const createdAt = existing?.createdAt ?? now

      held.set(at(agentId, key), {
        token,
        value,
        // Absent leaves what was there, which is what makes rotating a token
        // cheap in the real store too.
        description: description ?? existing?.description ?? null,
        createdAt,
        updatedAt: now,
      })

      return {
        outcome: 'stored',
        entry: {
          key,
          description: description ?? existing?.description ?? null,
          createdAt,
          updatedAt: now,
        },
        created: existing === undefined,
      }
    },

    describe: async (token, agentId, key, description) => {
      const entry = held.get(at(agentId, key))
      if (entry === undefined) return { outcome: 'unknown' as const }

      entry.description = description
      // The value is untouched and `updatedAt` does not move: it means *when the
      // value was last written*, and advancing it here would tell a citizen its
      // token had been rotated.
      return {
        outcome: 'described' as const,
        entry: {
          key,
          description: entry.token === token ? description : null,
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt,
        },
      }
    },

    get: async (token, agentId, key): Promise<GetVaultEntryOutcome> => {
      const entry = held.get(at(agentId, key))
      if (entry === undefined) return { outcome: 'unknown' }
      if (entry.token !== token) return { outcome: 'unreadable' }

      return {
        outcome: 'found',
        entry: {
          key,
          description: entry.description,
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt,
        },
        value: entry.value,
      }
    },

    list: async (token, agentId): Promise<readonly VaultEntryRow[]> =>
      keysOf(agentId)
        .map((composite) => {
          const key = composite.split('\0')[1] ?? ''
          const entry = held.get(composite)
          return {
            key,
            // Null when this token did not write it, which is how the real
            // store answers an entry it cannot open.
            description: entry?.token === token ? (entry?.description ?? null) : null,
            createdAt: entry?.createdAt ?? '',
            updatedAt: entry?.updatedAt ?? '',
          }
        })
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt)),

    delete: async (agentId, key): Promise<boolean> => held.delete(at(agentId, key)),
  }

  return {
    ...store,
    contents: () =>
      new Map([...held].map(([composite, entry]) => [composite.replace('\0', ':'), entry.value])),
    reSeal: (agentId, from, to) => {
      let resealed = 0
      let unreadable = 0

      for (const composite of keysOf(agentId)) {
        const entry = held.get(composite)
        if (entry === undefined) continue

        if (entry.token !== from) {
          unreadable += 1
          continue
        }

        held.set(composite, { ...entry, token: to })
        resealed += 1
      }

      return { resealed, unreadable }
    },
    fill: (agentId, entries = VAULT_MAX_ENTRIES) => {
      const now = new Date().toISOString()
      for (let index = 0; index < entries; index += 1) {
        held.set(at(agentId, `filler-${index}`), {
          token: 'whatever',
          value: 'x',
          description: null,
          createdAt: now,
          updatedAt: now,
        })
      }
    },
  }
}

/** The dependency shape `buildApp` wants, around a fresh fake. */
export function fakeVaultDependencies(vault: VaultStore = fakeVault()): VaultDependencies {
  return { vault }
}
