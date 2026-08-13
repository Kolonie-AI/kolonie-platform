import { randomUUID } from 'node:crypto'
import {
  PERMISSION_AGGREGATE_FLOOR,
  type AgentId,
  type Wish,
  type WishAtlasAnswer,
  type WishAuthor,
  type WishId,
} from '@kolonie-ai/core'
import { BUNDLES } from '@kolonie-ai/db'
import type { WishDependencies, WishStore } from '../account-wishes.js'

export interface FakeWishes extends WishStore {
  /** Everything on one agent's list, for a test that wants to read it back. */
  readonly held: (agentId: AgentId) => readonly Wish[]
  /**
   * Say what the Colony has decided about one provider (`#859`).
   *
   * **A seam and not a second queue.** The fake holds no proposals of its own —
   * a test that needs a refusal to reach a citizen states the refusal, which is
   * the only part of `atlas_proposals` any surface above storage reads.
   */
  readonly decide: (provider: string, atlas: WishAtlasAnswer) => void
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
  const decisions = new Map<string, WishAtlasAnswer>()
  const raised = new Set<string>()

  const listFor = (agentId: AgentId): Wish[] => lists.get(agentId) ?? []
  /**
   * **`absent` is the default and not `pending`.** An unseeded provider nobody
   * has written down is one nothing was ever put to the Colony about, which is
   * what a wish written before the propose door existed looks like.
   */
  const atlasFor = (provider: string): WishAtlasAnswer =>
    decisions.get(provider) ?? (raised.has(provider) ? { answer: 'pending' } : { answer: 'absent' })

  /**
   * **The fake raises a proposal on exactly the same condition storage does**
   * (`#859`): the first time a provider nothing is known about is written down,
   * and never again. A fixture that always answered `false` would let the
   * surface say both *this raised a proposal* and *nobody has proposed this*
   * forever, which is the one sentence pair this issue exists to prevent.
   */
  const propose = (provider: string): boolean => {
    if (decisions.has(provider) || raised.has(provider)) return false

    raised.add(provider)
    return true
  }

  return {
    held: listFor,

    decide: (provider, atlas) => {
      decisions.set(provider, atlas)
    },

    list: async (agentId) => listFor(agentId),

    listWithAtlas: async (agentId) =>
      listFor(agentId).map((wish) => ({ wish, atlas: atlasFor(wish.provider) })),

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
          return {
            outcome: 'context-added',
            wish: enriched,
            alsoProposed: false,
            atlas: atlasFor(provider),
          }
        }

        return {
          outcome: 'already-listed',
          wish: existing,
          alsoProposed: false,
          atlas: atlasFor(provider),
        }
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
      // Before the answer is read, because raising one is what makes it pending.
      const alsoProposed = propose(provider)
      return { outcome: 'added', wish, alsoProposed, atlas: atlasFor(provider) }
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
