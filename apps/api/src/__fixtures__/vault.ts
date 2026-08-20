import {
  VAULT_MAX_ENTRIES,
  VAULT_SHARE_DEFAULT_DAYS,
  VAULT_SHARE_MAX_DAYS,
  type AgentId,
} from '@kolonie-ai/core'
import type {
  GetVaultEntryOutcome,
  SetVaultEntryOutcome,
  ShareVaultEntryOutcome,
  UnshareVaultEntryOutcome,
  VaultEntryRow,
  VaultShareRow,
} from '@kolonie-ai/db'
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
  /**
   * Mark one entry spent, as `acceptAccountOffer` does at the far end of a
   * transfer (`#1214`). Here for the same reason `reSeal` is: no MCP surface
   * calls it, and `apps/api` is on the hook for what the outcome turns into.
   */
  readonly spend: (agentId: AgentId, key: string) => void
  /**
   * Whether this citizen has a person linked (`#1439`).
   *
   * True by default, because almost every test is about what sharing does
   * rather than about the one refusal that comes before it — and the refusal is
   * a single assertion that flips this.
   */
  readonly setOperator: (linked: boolean) => void
  /**
   * Write what the operator left, as `#1440` will from the far end.
   *
   * Here so that `apps/api` can assert the one thing it is on the hook for: the
   * addition is handed over exactly once, by `unshare`, and never by a read.
   */
  readonly operatorWrites: (agentId: AgentId, key: string, addition: string) => void
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
  /** Set when the account this opened moved to another citizen (`#1214`). */
  spentAt: string | null
  readonly createdAt: string
  updatedAt: string
}

interface Shared {
  readonly purpose: string
  readonly sharedAt: string
  readonly expiresAt: string
  addition: string | null
}

export function fakeVault(): FakeVault {
  const held = new Map<string, Held>()
  const shares = new Map<string, Shared>()
  let linked = true
  const at = (agentId: AgentId | string, key: string) => `${String(agentId)}\0${key}`

  /**
   * The share as a reader sees it, or null once its window has passed.
   *
   * Expiry is read here rather than swept, which is the real store's rule: a
   * share past its window answers as no share whether or not anything ran.
   */
  const shareOf = (agentId: AgentId | string, key: string): VaultShareRow | null => {
    const open = shares.get(at(agentId, key))
    if (open === undefined || Date.parse(open.expiresAt) <= Date.now()) return null

    return {
      purpose: open.purpose,
      sharedAt: open.sharedAt as VaultShareRow['sharedAt'],
      expiresAt: open.expiresAt as VaultShareRow['expiresAt'],
      operatorWrote: open.addition !== null,
    }
  }

  const keysOf = (agentId: AgentId) =>
    [...held.keys()].filter((composite) => composite.startsWith(`${String(agentId)}\0`))

  const store: VaultStore = {
    set: async (token, agentId, key, value, description): Promise<SetVaultEntryOutcome> => {
      const existing = held.get(at(agentId, key))

      // `#1437` decision 4: refused while a person can read it, so that the
      // copy they hold cannot silently stop being what the entry says.
      const open = shareOf(agentId, key)
      if (existing !== undefined && open !== null) return { outcome: 'shared', share: open }

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
        // A written value is a live value: the real store clears the mark on
        // the same reasoning.
        spentAt: null,
        createdAt,
        updatedAt: now,
      })

      return {
        outcome: 'stored',
        entry: {
          key,
          description: description ?? existing?.description ?? null,
          spentAt: null,
          share: null,
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
          spentAt: entry.spentAt,
          share: shareOf(agentId, key),
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt,
        },
      }
    },

    get: async (token, agentId, key): Promise<GetVaultEntryOutcome> => {
      const entry = held.get(at(agentId, key))
      if (entry === undefined) return { outcome: 'unknown' }

      const row = {
        key,
        description: entry.description,
        spentAt: entry.spentAt,
        share: shareOf(agentId, key),
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      }

      // Above `unreadable`, as in the real store: an entry that is both spent
      // and sealed with an older key is answered with the fact one can act on.
      if (entry.spentAt !== null) return { outcome: 'spent', entry: row }
      if (entry.token !== token) return { outcome: 'unreadable' }

      return { outcome: 'found', entry: row, value: entry.value }
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
            spentAt: entry?.spentAt ?? null,
            share: shareOf(agentId, key),
            createdAt: entry?.createdAt ?? '',
            updatedAt: entry?.updatedAt ?? '',
          }
        })
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt)),

    delete: async (agentId, key): Promise<boolean> => held.delete(at(agentId, key)),

    share: async ({ token, agentId, key, purpose, days }): Promise<ShareVaultEntryOutcome> => {
      const entry = held.get(at(agentId, key))
      if (entry === undefined) return { outcome: 'unknown' }
      if (entry.spentAt !== null) return { outcome: 'spent' }
      // The rule the real store enforces with the cipher: nothing can be copied
      // out of an entry this token cannot open.
      if (entry.token !== token) return { outcome: 'unreadable' }

      const open = shareOf(agentId, key)
      const now = new Date().toISOString()
      const window = Math.min(days ?? VAULT_SHARE_DEFAULT_DAYS, VAULT_SHARE_MAX_DAYS)
      const expiresAt = new Date(Date.now() + window * 86_400_000).toISOString()

      const existing = shares.get(at(agentId, key))
      shares.set(at(agentId, key), {
        purpose,
        // Extending keeps the first stamp: it means *when a person first got
        // this*, which is what a citizen weighing a take-back wants.
        sharedAt: open === null ? now : (existing?.sharedAt ?? now),
        expiresAt,
        addition: open === null ? null : (existing?.addition ?? null),
      })

      return {
        outcome: 'shared',
        share: shareOf(agentId, key) as VaultShareRow,
        extended: open !== null,
      }
    },

    unshare: async (agentId, key): Promise<UnshareVaultEntryOutcome> => {
      const open = shares.get(at(agentId, key))
      if (open === undefined) return { outcome: 'not-shared' }

      shares.delete(at(agentId, key))
      // Handed over once, and an expired share still gives it up: the window
      // governs what the person may read, and what they left is the citizen's.
      return { outcome: 'unshared', operatorAddition: open.addition }
    },

    hasOperator: async () => linked,
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
    setOperator: (value) => {
      linked = value
    },
    operatorWrites: (agentId, key, addition) => {
      const open = shares.get(at(agentId, key))
      if (open !== undefined) open.addition = addition
    },
    spend: (agentId, key) => {
      const entry = held.get(at(agentId, key))
      if (entry === undefined || entry.spentAt !== null) return
      held.set(at(agentId, key), { ...entry, spentAt: new Date().toISOString() })
    },
    fill: (agentId, entries = VAULT_MAX_ENTRIES) => {
      const now = new Date().toISOString()
      for (let index = 0; index < entries; index += 1) {
        held.set(at(agentId, `filler-${index}`), {
          token: 'whatever',
          value: 'x',
          description: null,
          spentAt: null,
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
