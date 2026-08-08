import { randomUUID } from 'node:crypto'
import type { AgentId, Wish, WishAuthor } from '@kolonie-ai/core'
import type { WishDependencies, WishStore } from '../account-wishes.js'

export interface FakeWishes extends WishStore {
  /** Everything on one agent's list, for a test that wants to read it back. */
  readonly held: (agentId: AgentId) => readonly Wish[]
}

/**
 * The shared account list, in memory (`#527`).
 *
 * **The gate is reimplemented here and it is the one thing this fixture must get
 * exactly right**: `blocksHandoff` answers `false` for a provider nobody wrote
 * down, and `true` only for one that is on the list and not marked wanted. A
 * fake that blocked everything would make the handoff tests pass for the wrong
 * reason, and one that blocked nothing would let the gate rot.
 */
export function fakeWishes(): FakeWishes {
  const lists = new Map<AgentId, Wish[]>()

  const listFor = (agentId: AgentId): Wish[] => lists.get(agentId) ?? []

  return {
    held: listFor,

    list: async (agentId) => listFor(agentId),

    add: async ({ agentId, provider, author, noticedWhile }) => {
      const held = listFor(agentId)
      const existing = held.find((wish) => wish.provider === provider)
      if (existing !== undefined) return { outcome: 'already-listed', wish: existing }

      const wish: Wish = {
        id: randomUUID(),
        provider,
        author: author as WishAuthor,
        // Only a citizen has something it was doing — the table refuses the
        // other case, so the fake does too.
        noticedWhile: author === 'citizen' ? (noticedWhile ?? null) : null,
        wantedAt: null,
        addedAt: new Date().toISOString(),
      }

      lists.set(agentId, [...held, wish])
      return { outcome: 'added', wish }
    },

    want: async (agentId, provider) => {
      const held = listFor(agentId)
      const wish = held.find((row) => row.provider === provider)
      if (wish === undefined || wish.wantedAt !== null) return false

      lists.set(
        agentId,
        held.map((row) =>
          row.provider === provider ? { ...row, wantedAt: new Date().toISOString() } : row,
        ),
      )
      return true
    },

    remove: async (agentId, provider) => {
      const held = listFor(agentId)
      const kept = held.filter((row) => row.provider !== provider)
      lists.set(agentId, kept)
      return kept.length !== held.length
    },

    blocksHandoff: async (agentId, provider) => {
      const wish = listFor(agentId).find((row) => row.provider === provider)
      return wish !== undefined && wish.wantedAt === null
    },
  }
}

export function fakeWishList(): WishDependencies & { readonly store: FakeWishes } {
  return { store: fakeWishes() }
}
