import { AccountKindSchema, type AccountKind } from './account.js'
import { atlasCanonicalKind } from './atlas-proposal.js'
import { EarnFacetSchema, type EarnFacet } from './atlas-facets.js'

/**
 * The account kinds that are an earn rail by definition (`#1331`).
 *
 * ## Why a table and not a judgement
 *
 * `#1301` built the earn axis and left it empty on purpose: *no facet is derived
 * from prose*, so an entry carries one because somebody said so. What it did not
 * settle is that a scout filing `kind: bounty-board` **has** said so — the kind
 * is a structured field with a closed meaning, and *a bounty board is a bounty
 * board* is not an inference about a provider, it is a restatement of the word
 * the walker chose from the vocabulary.
 *
 * The cost of leaving that gap was measured on 2026-08-19: every walked earn
 * provider in the catalogue — `clawlancer.ai`, `clawtasks.com`, `opentask.ai`,
 * `execution.market` — carried an empty earn axis, so the one filter an agent
 * asking *where can I earn today* would reach for returned none of them, and the
 * public page led with the shelf fallback instead. The facet table was correct
 * and had nothing in it.
 *
 * ## What this is not
 *
 * **It is not prose inference and never becomes one.** Nothing here reads a
 * title, a description, an `about` or a walker's narrative. The input is one
 * enum-shaped field the walker filed, and a kind absent from this table maps to
 * nothing at all rather than to a guess — which is why a `mailbox` or a `social`
 * kind at a provider that happens to pay referrals still needs somebody to say
 * so (`#1326` decision 5, and `#1301`'s rule underneath it).
 *
 * **It does not expand {@link EarnFacetSchema}.** `microtask-board` and
 * `survey-panel` have no facet of their own and are mapped to the nearest of the
 * five, which is a v1 decision recorded here rather than a silence:
 *
 * - `microtask-board` → `bounty-board`. Both pay for finishing a posted task;
 *   what differs is the size of the task, and size is not who decides money is
 *   owed — which is the line the five facets are cut along.
 * - `survey-panel` and `rewards-platform` → `creator-payout`. Both pay the
 *   holder for something they supplied rather than for a commissioned piece of
 *   work or a task off a board.
 *
 * Both mappings are the ones `#1326` decision 5 froze, and both are the kind of
 * approximation that is better read than left blank. Expanding the enum is a
 * later decision, and the thing that would justify it is these mappings failing
 * in practice rather than reading awkwardly in this comment.
 */
const EARN_FACET_BY_KIND: Readonly<Record<string, EarnFacet>> = {
  'bounty-board': 'bounty-board',
  'gig-marketplace': 'gig-marketplace',
  'microtask-board': 'bounty-board',
  'survey-panel': 'creator-payout',
  'rewards-platform': 'creator-payout',
}

/**
 * Checked at load, on {@link ATLAS_CATEGORY_BY_KIND}'s argument one file over: a
 * value typed into the table above that is not one of the five would otherwise
 * be a facet nothing can filter on, discovered by a reader of a page.
 */
for (const [kind, facet] of Object.entries(EARN_FACET_BY_KIND)) {
  AccountKindSchema.parse(kind)
  EarnFacetSchema.parse(facet)
}

/**
 * The earn facet an account kind is one of by definition, or nothing.
 *
 * **Through the aliases** (`#1144`), so a spelling and the kind it means cannot
 * reach different answers — the same reason {@link atlasCategoryForKind} resolves
 * before it looks up.
 *
 * **Nothing, and never a throw.** Most kinds are not an earn rail and that is the
 * ordinary case rather than an unmapped one, which is the opposite of the shelf
 * lookup beside it: a missing shelf is a gap in the catalogue, a missing earn
 * facet is the answer.
 */
export function earnFacetForKind(kind: AccountKind | string): EarnFacet | undefined {
  return EARN_FACET_BY_KIND[atlasCanonicalKind(kind)]
}

/**
 * The same answer as a list, for the callers that build a facet set.
 *
 * `facetsFrom` takes the earn axis as an array and a caller with one optional
 * value would otherwise write the empty-or-single spread at each site.
 */
export function earnFacetsForKind(kind: AccountKind | string): readonly EarnFacet[] {
  const facet = earnFacetForKind(kind)
  return facet === undefined ? [] : [facet]
}

/**
 * Every kind this table answers for, so a reader can be asked the complement.
 *
 * Read off the table rather than typed again, on `EARN_FACETS`' argument: the
 * documentation an agent reads, the mapping and its test cannot come apart.
 */
export const EARN_FACET_KINDS: readonly string[] = Object.keys(EARN_FACET_BY_KIND).sort()
