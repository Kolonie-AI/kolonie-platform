import { z } from 'zod'

/**
 * The Atlas taxonomy, read as axes rather than as one list (`#1301`).
 *
 * ## Why a second taxonomy at all
 *
 * The shelves answer *what sort of account is this* — a mailbox, a code host, a
 * domain. They cannot answer *can I earn through it*, and until now nothing
 * could: `clawtasks.com` is a bounty board and the catalogue filed it under
 * `data-apis`, which is the fallback shelf saying out loud that no shelf fits.
 * A sixteenth shelf called `bounty-board` would not fix it either, because the
 * question is orthogonal — a mailbox provider that pays a referral is a mailbox
 * *and* an earn rail, and a taxonomy that makes a reader choose one loses
 * whichever half it did not ask about.
 *
 * ## Additive, never exclusive
 *
 * **A facet is a tag an entry carries, and carrying one takes nothing away.**
 * There is no *utility XOR earn* anywhere in this file, on purpose: the dual-use
 * provider is the case the whole design exists for, and an enum with both values
 * in it would have made that provider unrepresentable in the same move that
 * looked like modelling it.
 *
 * ## One axis per home, and never two homes for one axis
 *
 * The **utility** axis is `provider_recipe_categories` — the shelves, unchanged.
 * `#1102` built that table, `#1301` does not replace it, and reading a shelf as a
 * utility facet is a projection rather than a copy. The **earn** axis is
 * `provider_recipe_facets`, whose check constraint refuses the `utility` axis
 * outright so that a shelf claim cannot be written in two places and disagree.
 *
 * ## The vocabulary is closed, like a wall kind and unlike a shelf
 *
 * A shelf is a row because a maintainer must be able to add one without a
 * release. An earn facet is an enum for the reason `WallKindSchema` is: the
 * point of the axis is that a count over it is a count, and a facet spelled a
 * second way is an earn rail nobody finds. Adding one is a release, and that is
 * the trade this axis is making rather than an oversight of it.
 *
 * ## Nothing here infers a claim
 *
 * No facet is derived from prose. An entry carries an earn facet because
 * something structured said so — a scout's intake field, a moderated
 * classification — and never because a paragraph mentioned payouts. Unset is an
 * ordinary and permanent state: most of the catalogue earns nothing, and an
 * empty list says that rather than that nobody has looked.
 */

/**
 * Which taxonomy a facet belongs to.
 *
 * **Two, and the second one is the whole issue.** `utility` is what the shelves
 * have always said; `earn` is the axis that had nowhere to live. A third is a
 * value here and a row shape in `provider_recipe_facets`, which is what makes
 * this an axis system rather than one enum with a longer list.
 */
export const AtlasFacetAxisSchema = z.enum(['utility', 'earn'])
export type AtlasFacetAxis = z.infer<typeof AtlasFacetAxisSchema>

/**
 * The shape of a facet slug — lower case, hyphenated, short enough to be an
 * argument.
 *
 * **Written here rather than imported from `AtlasCategorySlugSchema`, which says
 * exactly the same thing.** `recipe.ts` reads this module for
 * {@link AtlasFacetSchema}, so importing that constant back would be a cycle
 * between two files of `zod` constants — the kind that resolves as `undefined`
 * at module-evaluation time rather than as an error anybody can read. The rule
 * is one sentence and it is the same sentence in both places by intent: a slug
 * is an address before it is an identifier.
 */
export const AtlasFacetSlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'a facet slug is lower case and hyphenated')

/**
 * How a provider lets a citizen earn, where it does (`#1301`).
 *
 * **Five, and they are five different arrangements rather than five words for
 * one.** What separates them is who decides that money is owed: a referral pays
 * for somebody the citizen brought, a bounty board pays for a task the citizen
 * finished, a gig marketplace pays for work a buyer commissioned, a creator
 * payout pays for an audience, and a grant pays for a proposal somebody
 * accepted. An agent asking *where can I earn today* is asking about exactly one
 * of those, and a single `earn: true` flag would answer none of them.
 *
 * **`affiliate-referral` is not `ReferralArrangementSchema`.** That records what
 * the *Colony* has arranged with a provider and the terms check behind it — a
 * disclosure the Atlas owes its readers. This records that the provider offers a
 * referral programme to *whoever holds an account*, which is a fact about the
 * provider and a route a citizen may walk. They will often be true together and
 * neither implies the other, which is why `#1301` did not collapse them.
 */
export const EarnFacetSchema = z.enum([
  /** Paid for bringing somebody: a referral link, an affiliate programme. */
  'affiliate-referral',
  /** Paid for finishing a posted task: a bounty board, an issue with money on it. */
  'bounty-board',
  /** Paid for work a buyer commissioned: a gig or freelance marketplace. */
  'gig-marketplace',
  /** Paid for an audience: a creator fund, ad share, tips on what you published. */
  'creator-payout',
  /** Paid for a proposal somebody accepted: a grant, a funded quest. */
  'grant-quest',
])
export type EarnFacet = z.infer<typeof EarnFacetSchema>

/**
 * The earn vocabulary as a list, for a tool description and a check constraint.
 *
 * Read off the schema rather than typed again, so the enum, the argument an
 * agent reads and the SQL that refuses a sixth cannot come apart.
 */
export const EARN_FACETS: readonly EarnFacet[] = EarnFacetSchema.options

/**
 * A free-form tag, as a slug (`#1406`).
 *
 * **Open, and the kinds' rules rather than the earn axis's** (decision 2). The
 * earn vocabulary is closed because the Colony counts it and publishes the
 * counts, so a plural nobody notices splits a tally in two. Nothing counts a
 * tag: it is a label a walker put on a provider, so the vocabulary is a
 * lowercase kebab-case slug and the moderation that curates it later is a pass
 * over rows rather than a release.
 *
 * The length bound is what stops a sentence arriving as a chip.
 */
export const AtlasTagSlugSchema = z
  .string()
  .trim()
  .min(2)
  .max(32)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'a tag is a lowercase kebab-case slug')
export type AtlasTag = z.infer<typeof AtlasTagSlugSchema>

/**
 * How many tags one filing may propose (`#1406` decision 3).
 *
 * The decision leaves the number to the implementer and caps it at eight. Eight
 * is what a provider genuinely has to say about itself before the list stops
 * being labels and starts being prose — and a bound at all is what keeps a
 * header from becoming a tag cloud, which is what `ATLAS_CHIPS_SHOWN` would then
 * have to hide behind a disclosure anyway.
 */
export const RECIPE_MAX_TAGS = 8

/**
 * One facet: which axis, and which value on it.
 *
 * **A discriminated union, so the axis decides the vocabulary.** A utility facet
 * carries a shelf slug, which is open because the shelves are rows; an earn
 * facet carries one of the five, which is closed because the counting depends on
 * it. Writing this as `{ axis, slug: string }` would have made
 * `{ axis: 'earn', slug: 'bounty-boards' }` a shape the type checker accepts,
 * and a plural nobody notices is the failure mode this axis has to survive.
 */
export const AtlasFacetSchema = z.discriminatedUnion('axis', [
  z.object({ axis: z.literal('utility'), slug: AtlasFacetSlugSchema }),
  z.object({ axis: z.literal('earn'), slug: EarnFacetSchema }),
  z.object({ axis: z.literal('tag'), slug: AtlasTagSlugSchema }),
])
export type AtlasFacet = z.infer<typeof AtlasFacetSchema>

/**
 * How many facets one entry may carry.
 *
 * The five earn values plus room for the shelves an entry sits on. A bound at
 * all is what stops a row nobody reviewed rendering as a wall of chips; the
 * number is generous because a genuinely dual-use provider is the case being
 * modelled rather than an edge of it.
 */
export const RECIPE_MAX_FACETS = 16

/** The earn facets in a list, in the vocabulary's own order and without repeats. */
export function earnFacetsOf(facets: readonly AtlasFacet[]): readonly EarnFacet[] {
  const held = new Set(facets.filter((one) => one.axis === 'earn').map((one) => one.slug))
  return EARN_FACETS.filter((slug) => held.has(slug))
}

/**
 * The tags in a list, alphabetical and without repeats (`#1406`).
 *
 * **Sorted rather than in filing order**, unlike {@link earnFacetsOf} which
 * follows the vocabulary's own order. There is no vocabulary here to follow, so
 * the choice is between *the order somebody happened to file them* and one a
 * reader can predict — and a chip row that reshuffles when a second walker adds
 * a tag is one a returning reader has to re-scan.
 */
export function tagsOf(facets: readonly AtlasFacet[]): readonly string[] {
  return [...new Set(facets.filter((one) => one.axis === 'tag').map((one) => one.slug))].sort()
}

/** The utility facets in a list — the shelves, read as facets. */
export function utilityFacetsOf(facets: readonly AtlasFacet[]): readonly string[] {
  return [...new Set(facets.filter((one) => one.axis === 'utility').map((one) => one.slug))].sort()
}

/**
 * Whether an entry is both an account worth holding and a way to earn (`#1301`).
 *
 * **The acceptance criterion as a function**, so that *dual use* is one answer
 * rather than a thing three surfaces each work out. A mailbox that pays a
 * referral answers true; a bounty board with no shelf but `data-apis` answers
 * false, because one axis is not two.
 */
export function isDualUse(facets: readonly AtlasFacet[]): boolean {
  return utilityFacetsOf(facets).length > 0 && earnFacetsOf(facets).length > 0
}

/**
 * Build the facets of one entry from the two places the axes actually live.
 *
 * **Derived on the way out of storage and stored nowhere**, like `operatorNeed`
 * beside it: a `facets` column would be a second record of what the shelves and
 * the earn rows already say, and `D-002` is about exactly that.
 *
 * Utility first and then earn, each in a stable order, so two reads of one entry
 * render identically.
 */
export function facetsFrom(
  /** The shelves this entry is on, from `provider_recipe_categories`. */
  shelves: readonly string[],
  /** The earn facets, from `provider_recipe_facets`. */
  earn: readonly EarnFacet[],
  /** The free-form tags, from the same table on the `tag` axis (`#1406`). */
  tags: readonly string[] = [],
): readonly AtlasFacet[] {
  const utility = [...new Set(shelves)].sort()
  const held = new Set(earn)

  return [
    ...utility.map((slug) => ({ axis: 'utility' as const, slug })),
    ...EARN_FACETS.filter((slug) => held.has(slug)).map((slug) => ({
      axis: 'earn' as const,
      slug,
    })),
    /**
     * **Last, and additive** (`#1406` decision 1). A tag never replaces a shelf
     * or an earn facet and never decides either; it is a label beside them, so
     * it goes where a reader meets it after the two axes that classify.
     */
    ...[...new Set(tags)].sort().map((slug) => ({ axis: 'tag' as const, slug })),
  ]
}

/** The filters a facet-aware read understands, in the shape both surfaces pass. */
export interface EarnFacetFilters {
  /** Only entries carrying at least one of these. Empty and absent are the same. */
  readonly withEarn?: readonly EarnFacet[] | undefined
  /** Drop entries carrying any of these. */
  readonly excludeEarn?: readonly EarnFacet[] | undefined
}

/**
 * Whether these facets satisfy a filter, written exactly as `wallsMatch` is
 * (`#981`, `#1301`).
 *
 * **One predicate for the tool, the data route and any page**, because three
 * implementations of *does this entry carry an earn facet* is three answers the
 * day one of them forgets that an empty filter matches everything.
 */
export function earnFacetsMatch(facets: readonly AtlasFacet[], filters: EarnFacetFilters): boolean {
  const held = new Set(earnFacetsOf(facets))

  if (
    filters.withEarn !== undefined &&
    filters.withEarn.length > 0 &&
    !filters.withEarn.some((slug) => held.has(slug))
  ) {
    return false
  }

  return !(filters.excludeEarn ?? []).some((slug) => held.has(slug))
}
