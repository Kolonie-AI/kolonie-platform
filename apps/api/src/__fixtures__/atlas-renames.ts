import type { AtlasRenames } from '../atlas/renames.js'

/**
 * Where a provider used to be, in memory (`#546`).
 *
 * **The chain-repointing is reimplemented here rather than stubbed**, because it
 * is the one behaviour a page test can be wrong about in a way that matters: a
 * fake that returned the last hop would let a two-rename test pass while a
 * crawler followed two redirects for every page.
 */
export function fakeAtlasRenames(): AtlasRenames {
  const rows = new Map<string, string>()

  return {
    async renamedTo(from) {
      return rows.get(from.toLowerCase())
    },

    async canonical(provider) {
      const asked = provider.toLowerCase()
      return rows.get(asked) ?? asked
    },

    /**
     * The flattening, and nothing about shadowing.
     *
     * **This fake holds no catalogue**, so *would this alias hide an entry* is a
     * question it cannot answer — and a fake that answered *no* to it would be
     * asserting the safe case rather than modelling the rule. That refusal is
     * checked against real rows in `packages/db`'s own test, which is the only
     * place it can be checked truthfully.
     */
    async alias(from, to) {
      const fromProvider = from.toLowerCase()
      const toProvider = rows.get(to.toLowerCase()) ?? to.toLowerCase()

      if (fromProvider === toProvider) return { outcome: 'points-at-itself' }

      for (const [old, target] of rows) {
        if (target === fromProvider) rows.set(old, toProvider)
      }
      rows.set(fromProvider, toProvider)

      return { outcome: 'recorded', alias: fromProvider, provider: toProvider }
    },

    async rename(from, to) {
      const fromProvider = from.toLowerCase()
      const toProvider = to.toLowerCase()
      if (fromProvider === toProvider) return { moved: 0 }

      for (const [old, target] of rows) {
        if (target === fromProvider) rows.set(old, toProvider)
      }
      rows.set(fromProvider, toProvider)

      return { moved: 1 }
    },
  }
}
