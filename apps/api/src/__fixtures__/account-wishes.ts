import { randomUUID } from 'node:crypto'
import {
  PERMISSION_AGGREGATE_FLOOR,
  type AgentId,
  type Wish,
  type WishAuthor,
  type WishId,
} from '@kolonie-ai/core'
import { BUNDLES } from '@kolonie-ai/db'
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
      if (existing !== undefined) {
        if (author === 'citizen' && noticedWhile !== undefined && existing.noticedWhile === null) {
          const enriched = { ...existing, noticedWhile }
          lists.set(
            agentId,
            held.map((wish) => (wish.id === existing.id ? enriched : wish)),
          )
          return { outcome: 'context-added', wish: enriched }
        }

        return { outcome: 'already-listed', wish: existing }
      }

      const wish: Wish = {
        id: randomUUID() as WishId,
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

    wanted: async () => {
      /**
       * The same floor the real query applies, in the fake (`#534`).
       *
       * **Reimplemented here on purpose**, like every other rule a fixture
       * carries: a fake that reported thin rows would let a page test pass while
       * the one property protecting citizens was broken.
       */
      const counts = new Map<string, Set<AgentId>>()
      for (const [agentId, held] of lists) {
        for (const wish of held) {
          if (wish.author !== 'citizen') continue
          counts.set(wish.provider, (counts.get(wish.provider) ?? new Set()).add(agentId))
        }
      }

      return [...counts.entries()]
        .filter(([, who]) => who.size >= PERMISSION_AGGREGATE_FLOOR)
        .map(([provider, who]) => ({ provider, citizens: who.size }))
        .sort((a, b) => b.citizens - a.citizens || a.provider.localeCompare(b.provider))
    },

    /**
     * The bundles (`#531`), in memory.
     *
     * **The seeded set, unchanged.** A fixture that invented its own bundles
     * would let a page test pass against an ordering rule the real ones do not
     * have — and the ordering is the part `#531` calls the one worth getting
     * right.
     */
    bundles: async () =>
      BUNDLES.map((bundle) => ({
        slug: bundle.slug,
        title: bundle.title,
        reason: bundle.reason,
        entries: bundle.entries.map((entry) => ({
          ...entry,
          title: null,
          status: null,
          category: null,
          operatorNeed: null,
          operatorNeedIsGuess: false,
          refusal: null,
        })),
      })),

    bundle: async (slug) =>
      (
        await (async () =>
          BUNDLES.map((bundle) => ({
            slug: bundle.slug,
            title: bundle.title,
            reason: bundle.reason,
            entries: bundle.entries.map((entry) => ({
              ...entry,
              title: null,
              status: null,
              category: null,
              operatorNeed: null,
              operatorNeedIsGuess: false,
              refusal: null,
            })),
          })))()
      ).find((bundle) => bundle.slug === slug),

    blocksHandoff: async (agentId, provider) => {
      const wish = listFor(agentId).find((row) => row.provider === provider)
      return wish !== undefined && wish.wantedAt === null
    },
  }
}

export function fakeWishList(): WishDependencies & { readonly store: FakeWishes } {
  return { store: fakeWishes() }
}
