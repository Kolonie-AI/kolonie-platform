import { atlasKindPhrase, type AtlasCategorySlug } from '@kolonie-ai/core'
import type { AtlasPublicEntry } from './public-projection.js'
import {
  atlasEarnFacets,
  atlasEarnPhrase,
  atlasIsDualUse,
  atlasShelfClause,
  atlasShelfIsClaim,
} from './taxonomy.js'

/**
 * How many chips a reader is shown before the rest go behind a disclosure
 * (`#1404` decision 4).
 *
 * **Six, and it is a scanning budget rather than a layout one.** The header is
 * the five seconds in which a reader decides whether the page is about what
 * they came for; past six equally-weighted labels nobody is reading them, they
 * are skipping the block. A genuinely many-facetted provider still says
 * everything it has to say — one click further down.
 */
export const ATLAS_CHIPS_SHOWN = 6

/**
 * The kinds that classify a provider so weakly they are worth demoting
 * (`#1404` decision 2).
 *
 * **`storefront` is on the list and `mailbox` is not**, and the difference is
 * whether the word narrows anything. Measured 2026-08-20 on `opentask.ai`: the
 * header led with *a storefront*, above *pays for finished tasks* and *pays a
 * gig rate* — the least specific label on the line, in the position a reader
 * reads first. A storefront is a shape that a bounty board, a gig marketplace
 * and a shop all have, so as the lead clause it says only *somebody sells
 * something here*.
 *
 * **Demoted, never dropped, and never when it is all there is.** A provider
 * whose only kind is `storefront` still says so — that is the sole meaningful
 * label decision 2 protects, and an entry with an empty kind chip would read as
 * one the Colony has not classified rather than as one it classified plainly.
 */
export const ATLAS_WEAK_KINDS: ReadonlySet<string> = new Set(['storefront'])

/** One chip: which rank it holds, and the HTML it renders as. */
export type AtlasChip = {
  /** What the chip says, unescaped — the tests read this and not the markup. */
  readonly text: string
  /** The class the renderer puts on it, or null for a plain clause. */
  readonly className: string | null
  /**
   * The shelf this chip links to, or null.
   *
   * **A slug and never a path.** `atlasShelfPath` lives in `html.ts`, which
   * imports this module — so building the href here would be an import cycle,
   * and copying the path would be a second place that decides where a shelf
   * lives. The renderer holds one and this holds the other.
   */
  readonly shelf: AtlasCategorySlug | null
}

/**
 * What a provider header says about itself, in one order (`#1404` decision 1).
 *
 * ## The defect
 *
 * Measured 2026-08-20, `opentask.ai`: **a storefront — pays for finished tasks —
 * pays a gig rate — worth holding, and pays — data-apis — walked, but who is
 * needed is not known.** Six clauses of equal weight, led by the least specific
 * one and closed by a sentence that says nothing at all, and a reader — human or
 * agent — cannot tell from the line which of them was measured and which is the
 * Colony's own bookkeeping.
 *
 * ## The order, and why it is this one
 *
 * **Earn first, because it is the strongest true statement about an earn rail
 * and the reason a reader filtered for one.** Then the kind, which answers *what
 * sort of account is this*; then whether anybody actually holds one, which is
 * the usefulness signal and the one thing on the line nobody can write about
 * themselves; then the shelf, which is the Colony's filing and is worth a link
 * where somebody chose it. Operator-need is last because it is a condition
 * rather than an identity.
 *
 * **Status is not here and is not missing.** `atlasStatusSubline` prints it
 * directly under the `h1`, one block above this, in a full sentence — it is the
 * fact that decides how a reader takes everything below it (`#1333`), and a
 * second copy as a chip would be the page saying it twice.
 *
 * ## What is omitted rather than said
 *
 * **An unknown operator-need renders nothing** (decision 3). *Walked, but who is
 * needed is not known* was the closing clause on every earn provider page on the
 * day this was written — twenty-one of twenty-one — so a reader scanning the
 * shelf saw the same headline non-fact on every row. It is a true statement and
 * the wrong one to spend the last chip on: the criteria box below answers the
 * same question in the same words, where a reader who wants it is looking.
 *
 * **The fallback shelf renders nothing as a chip.** `atlasShelfIsClaim` already
 * knows the difference, and `#1329` demoted it on this line; the clause form
 * survives for the entry that nothing else classifies, where saying *nobody
 * filed it on a shelf* is a finding rather than filing.
 */
export function atlasHeaderChips(
  entry: AtlasPublicEntry,
  extra: { readonly proved?: AtlasChip | undefined } = {},
): readonly AtlasChip[] {
  const earn = atlasEarnFacets(entry)

  const chips: (AtlasChip | null)[] = [
    ...earn.map((facet) => chip(atlasEarnPhrase(facet), 'k-atlas-earn')),
    /**
     * **Both axes at once is its own claim** (`#1301`), and it sits with the
     * earn chips rather than after the kind because it is a statement about the
     * earning: a mailbox that pays a referral is the case the facet system
     * exists for, and a reader scanning for it should not have to notice that
     * two unrelated chips are present.
     */
    atlasIsDualUse(entry) ? chip('worth holding, and pays', 'k-atlas-dual') : null,
    kindChip(entry),
    extra.proved ?? null,
    atlasShelfIsClaim(entry) ? chip(entry.category, null, entry.category) : shelfClauseChip(entry),
    operatorChip(entry),
  ]

  return chips.filter((one): one is AtlasChip => one !== null)
}

/**
 * The chips a reader sees, and the ones behind the disclosure (`#1404`
 * decision 4).
 *
 * **The split is here rather than at the renderer**, so *what is above the
 * fold* is a decision this module took and a test can read, rather than a
 * `.slice` somebody moved. `rest` is empty far more often than not, and a
 * renderer handed an empty `rest` emits no disclosure at all.
 */
export function atlasChipsShown(chips: readonly AtlasChip[]): {
  readonly shown: readonly AtlasChip[]
  readonly rest: readonly AtlasChip[]
} {
  return {
    shown: chips.slice(0, ATLAS_CHIPS_SHOWN),
    rest: chips.slice(ATLAS_CHIPS_SHOWN),
  }
}

/**
 * The kind, demoted where the word narrows nothing (decision 2).
 *
 * An entry with several kinds names them all, as it always did — the demotion
 * is about which word leads, and `a storefront, a bounty board` led with the
 * wrong one. Where the weak kind is the only one, it stays: see
 * {@link ATLAS_WEAK_KINDS}.
 */
function kindChip(entry: AtlasPublicEntry): AtlasChip | null {
  const kinds = [...new Set(entry.recipes.map((recipe) => recipe.kind))]
  const strong = kinds.filter((kind) => !ATLAS_WEAK_KINDS.has(kind))
  const shown = strong.length === 0 ? kinds : strong

  if (shown.length === 0) return null

  return chip(shown.map((kind) => lowerFirst(atlasKindPhrase(kind))).join(', '), null)
}

/** Who is needed, and nothing at all where nobody knows (decision 3). */
function operatorChip(entry: AtlasPublicEntry): AtlasChip | null {
  if (entry.operatorNeed === 'unknown') return null

  const said = {
    unaided: 'an agent can do this alone',
    'operator-needed': 'needs a person at one step',
  }[entry.operatorNeed]

  return chip(entry.operatorNeedIsGuess ? `${said} (a guess, not a walk)` : said, null)
}

/** The words for a shelf nobody chose, where there are any. */
function shelfClauseChip(entry: AtlasPublicEntry): AtlasChip | null {
  const clause = atlasShelfClause(entry)

  return clause === undefined ? null : chip(clause, null)
}

const chip = (
  text: string,
  className: string | null,
  shelf: AtlasCategorySlug | null = null,
): AtlasChip => ({ text, className, shelf })

/** Lowercases the first character and leaves every other one alone. */
function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1)
}
