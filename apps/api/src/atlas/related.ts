import type { AtlasEntry, AtlasFacet } from '@kolonie-ai/core'
import { ATLAS_FALLBACK_CATEGORY, earnFacetsOf, tagsOf } from '@kolonie-ai/core'

/**
 * How many neighbours a provider page carries (`kolonie-website#113`).
 *
 * **Three, and the number is the point rather than a setting.** The module is
 * the last thing on a page a reader has already read to the bottom of, and what
 * it owes them is *the two or three you would look at next* — a list of forty
 * is the shelf, which is one link above it and is where a reader who wants all
 * of them should go.
 *
 * **A ceiling and never a quota** (`#1403` decision 3). A provider with one
 * earn-similar neighbour shows one. Padding the other two from the shelf is what
 * put Alpha Vantage under a bounty board, and *three things worth looking at*
 * and *three things* are different promises.
 */
export const ATLAS_RELATED = 3

/**
 * How similar one provider is to another, by the signals that survive `#1403`.
 *
 * The fields are read in the order they are declared, which is the order
 * decision 1 fixes: earn facet, then tags, then kind, then a shelf that means
 * something. `sameShelf` is last and cannot qualify a candidate on its own —
 * see {@link atlasNeighbours}.
 */
type Similarity = {
  readonly earn: number
  readonly tags: number
  readonly kinds: number
  readonly leadKind: boolean
  readonly sameShelf: boolean
}

/**
 * The providers a reader would look at next (`kolonie-website#113`, rescored by
 * `#1403`).
 *
 * **Measured 2026-08-17**: `/atlas/agentphone.ai` ended at a wall list, and the
 * only way from there to the other three telephony providers was the browser's
 * back button. A wall page is where a reader most needs a neighbour, and it was
 * the page with none.
 *
 * ## Why the shelf stopped being the answer
 *
 * The first version of this took the same shelf and the catalogue's own order,
 * on the reasoning that an entry has one category and relatedness across shelves
 * would be a second opinion about where a provider lives. That reasoning holds
 * for a provider whose shelf is a claim. It collapses for one whose shelf is the
 * fallback.
 *
 * **Measured 2026-08-20 on `opentask.ai`**: a bounty board, filed under
 * `data-apis` because no shelf fitted, offering Alpha Vantage, Anthropic and the
 * OpenAI Platform as the three things to look at next. All four share exactly
 * one thing — that the Colony had nowhere to put them — and the module was
 * presenting that as a resemblance. Twenty-one of the twenty-one earn providers
 * sat on that shelf on the day this was written, so it was every earn page.
 *
 * So the shelf is still a signal and is no longer the only one, and a shelf that
 * is the fallback is not a signal at all (decision 2). What replaces it is the
 * facet axis `#1301` added precisely because one category could not say *this is
 * a way to earn*.
 *
 * ## Why this is still not a ranking
 *
 * **Rule 2 of `#543` said this module must not sort, and it still must not.** A
 * sort would be a second answer to *which provider comes first*, and a second
 * answer is where a paid position could hide.
 *
 * What is computed here is not that. It is a **similarity to the provider whose
 * page this is**, so it has no value independent of the page it is on: the same
 * candidate is first here and absent one page over, and there is no field
 * anybody can pay to move because there is no field. Ties are broken by the
 * catalogue's own order, which `listEntries` handed over — so where two
 * candidates resemble this one equally, the answer is still `atlasByOutcome`'s
 * and never this module's.
 *
 * **Never the entry itself**, which is the one row a reader on this page
 * demonstrably does not need.
 */
export function atlasNeighbours(
  entry: AtlasEntry,
  catalogue: readonly AtlasEntry[],
): readonly AtlasEntry[] {
  const earn = new Set(earnFacetsOf(facetsOf(entry)))
  const kinds = new Set((entry.recipes ?? []).map((recipe) => recipe.kind))
  const lead = (entry.recipes ?? [])[0]?.kind
  const tags = new Set(atlasEntryTags(entry))

  /**
   * **What a candidate has to share to be offered at all.**
   *
   * An earn provider is compared on the earn axis and on nothing else: a reader
   * on a bounty board is looking for another way to be paid, and the strongest
   * true statement about the other twenty is that they are also that. Where the
   * entry names no earn facet the question is the ordinary one — *another
   * provider of the same thing* — and the kind answers it.
   *
   * **A shared shelf qualifies nobody by itself when that shelf is the
   * fallback** (decision 2), which is the whole of the `opentask.ai` defect. It
   * still qualifies where the shelf is a claim, because *the other mailbox
   * providers* is a real answer and was never the thing that broke.
   */
  const qualifies = (found: Similarity): boolean =>
    earn.size > 0 ? found.earn > 0 : found.kinds > 0 || found.tags > 0 || found.sameShelf

  const shelfIsClaim = !isFallbackShelf(entry)

  const scored = catalogue
    .filter((one) => one.provider !== entry.provider)
    .map((one, order) => {
      const theirEarn = new Set(earnFacetsOf(facetsOf(one)))
      const theirTags = new Set(atlasEntryTags(one))

      return {
        entry: one,
        order,
        found: {
          earn: countShared(earn, theirEarn),
          tags: countShared(tags, theirTags),
          kinds: (one.recipes ?? []).filter((recipe) => kinds.has(recipe.kind)).length,
          leadKind: lead !== undefined && (one.recipes ?? [])[0]?.kind === lead,
          sameShelf: shelfIsClaim && !isFallbackShelf(one) && one.category === entry.category,
        } satisfies Similarity,
      }
    })
    .filter((one) => qualifies(one.found))

  return scored
    .sort((a, b) => compare(a.found, b.found) || a.order - b.order)
    .slice(0, ATLAS_RELATED)
    .map((one) => one.entry)
}

/**
 * The subtitle the section prints under the list (`#1403` decision 4).
 *
 * **The rule has to be stated where the list is**, because a reader cannot tell
 * *the same shelf* from *the same way of earning* by looking at three provider
 * names — and the old sentence said *the same shelf* on pages where that had
 * stopped being true. It is exported so the page cannot describe a rule this
 * module did not apply.
 */
export function atlasNeighbourRule(entry: AtlasEntry): string {
  return earnFacetsOf(facetsOf(entry)).length > 0
    ? 'Providers that pay the same way, in the catalogue’s own order: measured outcome, never who paid.'
    : 'Providers of the same thing, in the catalogue’s own order: measured outcome, never who paid.'
}

/**
 * The entry's free-form tags (`#1403`'s hook, filled by `#1406`).
 *
 * **A reader rather than a field access**, which is what made this one line to
 * change: `#1403` put tags between the earn facet and the kind and shipped the
 * position empty, and landing the axis changed neither the ordering, the
 * qualification rule nor a test that pins them.
 *
 * A tag is a shared signal here and never a qualifier on its own for an earn
 * entry — see the rule in {@link atlasNeighbours}. Two providers sharing
 * `crypto` and nothing else are not neighbours.
 */
function atlasEntryTags(entry: AtlasEntry): readonly string[] {
  return tagsOf(facetsOf(entry))
}

/**
 * The entry's facets, tolerating a row that predates `#1301`.
 *
 * `AtlasEntrySchema` requires the array, so a projected entry always has one.
 * What does not is an older stored row and every hand-built fixture, and the
 * cost of the difference is asymmetric: a page that renders no neighbour has
 * lost a module, and a page that throws inside `earnFacetsOf` has lost the whole
 * provider. `aboutSection` treats a missing `homepage` the same way.
 */
function facetsOf(entry: AtlasEntry): readonly AtlasFacet[] {
  return entry.facets ?? []
}

/** Whether the entry's shelf is the one that means *nowhere else fitted*. */
function isFallbackShelf(entry: AtlasEntry): boolean {
  return (
    entry.category === ATLAS_FALLBACK_CATEGORY ||
    (entry.recipes ?? []).some((recipe) => recipe.categoryIsFallback === true)
  )
}

/** How many of the first set the second one also holds. */
function countShared<T>(mine: ReadonlySet<T>, theirs: ReadonlySet<T>): number {
  let shared = 0
  for (const one of mine) if (theirs.has(one)) shared += 1

  return shared
}

/** Decision 1's order, as a comparator: earn, then tags, then kind, then shelf. */
function compare(a: Similarity, b: Similarity): number {
  return (
    b.earn - a.earn ||
    b.tags - a.tags ||
    b.kinds - a.kinds ||
    Number(b.leadKind) - Number(a.leadKind) ||
    Number(b.sameShelf) - Number(a.sameShelf)
  )
}
