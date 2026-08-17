import type { AtlasEntry } from '@kolonie-ai/core'

/**
 * How many neighbours a provider page carries (`kolonie-website#113`).
 *
 * **Three, and the number is the point rather than a setting.** The module is
 * the last thing on a page a reader has already read to the bottom of, and what
 * it owes them is *the two or three you would look at next* — a list of forty
 * is the shelf, which is one link above it and is where a reader who wants all
 * of them should go.
 */
export const ATLAS_RELATED = 3

/**
 * The providers a reader would look at next, taken from the catalogue's own
 * order (`kolonie-website#113`).
 *
 * **Measured 2026-08-17**: `/atlas/agentphone.ai` ended at a wall list, and the
 * only way from there to the other three telephony providers was the browser's
 * back button. A wall page is where a reader most needs a neighbour, and it was
 * the page with none.
 *
 * **The same shelf, and no second shelf.** An entry has one category (`#1102`
 * gives it several and the projection carries the one it is filed under), and
 * relatedness computed across shelves would be a second opinion about where a
 * provider lives — the one thing a map may not have two of.
 *
 * **No ranking of its own, which is rule 2 of `#543` reaching this module.**
 * `listEntries` hands over `atlasByOutcome`'s order, so the first three are the
 * three that got somebody through; a sort here would be a second answer to
 * *which provider comes first*, and a second answer is where a paid position
 * could hide. This filters and slices, and that is all it does.
 *
 * **Never the entry itself**, which is the one row a reader on this page
 * demonstrably does not need.
 */
export function atlasNeighbours(
  entry: AtlasEntry,
  catalogue: readonly AtlasEntry[],
): readonly AtlasEntry[] {
  return catalogue
    .filter((one) => one.category === entry.category && one.provider !== entry.provider)
    .slice(0, ATLAS_RELATED)
}
