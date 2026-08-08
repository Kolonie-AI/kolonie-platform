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
