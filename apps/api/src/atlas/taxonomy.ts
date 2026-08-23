import {
  ATLAS_FALLBACK_CATEGORY,
  earnFacetsOf,
  isDualUse,
  tagsOf,
  type EarnFacet,
} from '@kolonie-ai/core'
import type { AtlasPublicEntry } from './public-projection.js'

/**
 * What a provider *is*, in the order a reader can act on (`#1329`).
 *
 * ## The shelf fallback was being read as a classification
 *
 * `#1096` decided that a kind reaching no shelf is shelved by default rather
 * than dropped, and that decision is right: a wrong shelf is a claim a reader
 * can see and argue with, a dropped entry is a walk nobody can find. What it
 * did not settle is how the default *reads*, and the entry says
 * `categoryIsFallback` about itself precisely so that a renderer need not guess.
 *
 * No renderer asked. Measured 2026-08-19 on `execution.market` and
 * `clawlancer.ai`: the header led with **Data and APIs** above a bounty board,
 * and the two facts that actually classify it — the `kind` the walker filed, and
 * the earn facet `#1331` reads off it — were nowhere near the top. *Data and
 * APIs + microtask-board* is not a taxonomy, it is one true statement standing
 * behind one meaningless one.
 *
 * ## The order, frozen by `#1326` decision 1
 *
 * `status` → `kind` → **earn facets** → utility shelf, *only where the shelf is
 * not the fallback*. This module owns the last three; the status chip is
 * `indexStatusMark` and the subline is `lead.ts`.
 *
 * ## What it does not do
 *
 * **It does not invent a shelf.** `#1326` decision 4 refuses a `bounty-board`
 * shelf to escape the fallback — the earn axis already carries that meaning, and
 * a second vocabulary saying the same thing is the disagreement `#1301` split
 * the axes to prevent. So a fallback-shelved entry renders with no shelf claim
 * at all, and the reader is told which it is rather than shown a guess.
 *
 * **It leaves the storage constant alone.** `ATLAS_FALLBACK_CATEGORY` is still
 * what an unshelvable kind is filed under, still what the index groups it by,
 * and still the row the entry has to be somewhere. What changes is that the page
 * stops presenting it as an answer.
 */

/**
 * Whether this entry's shelf is the default rather than a classification.
 *
 * **Every row that put it there has to be a fallback.** An entry is a provider
 * and its recipes are kinds (`#960`), so a provider with a catalogued mailbox
 * and an unshelvable bounty board has a shelf somebody chose — and demoting it
 * would hide a real classification behind a second row's absence.
 */
export function atlasShelfIsFallback(entry: AtlasPublicEntry): boolean {
  const onTheShelf = entry.recipes.filter((recipe) => recipe.category === entry.category)

  return onTheShelf.length > 0 && onTheShelf.every((recipe) => recipe.categoryIsFallback === true)
}

/**
 * The earn facets on an entry, in the vocabulary's own order and without
 * repeats.
 *
 * Unioned across the rows for `atlasEntryWalkers`' reason: an entry is a
 * provider, and a facet on one of its kinds is a fact about the provider. The
 * entry carries its own rolled-up `facets` already, and this reads them rather
 * than recomputing — one answer, as `#1301` requires.
 *
 * **A missing list reads as no earn claim**, which is what `aboutSection` does
 * with an absent `homepage` and for the same reason: `atlasPublicEntry` always
 * writes the field, and the rows built by hand in this directory's tests do not.
 * An entry making no earn claim is the ordinary case anyway, so the two are the
 * same answer and neither is a guess.
 */
export function atlasEarnFacets(entry: AtlasPublicEntry): readonly EarnFacet[] {
  return earnFacetsOf(entry.facets ?? [])
}

/**
 * How an earn facet reads to somebody who is not a citizen.
 *
 * The slugs are the Colony's vocabulary and `bounty-board` is close enough to
 * English to survive, but `creator-payout` and `grant-quest` are not — and a
 * chip a reader has to decode is a chip that has spent its width for nothing.
 * An unlisted value falls through to its own slug rather than to silence, on the
 * same rule the phrase maps in `atlas.ts` follow.
 */
const EARN_PREDICATES: Readonly<Record<EarnFacet, string>> = {
  'affiliate-referral': 'a referral',
  'bounty-board': 'for finished tasks',
  'gig-marketplace': 'for commissioned work',
  'creator-payout': 'for an audience',
  'grant-quest': 'for accepted proposals',
}

/**
 * **The predicate is stored and the verb is added** (`#1396`).
 *
 * The map held whole phrases — `pays for finished tasks` — which is right beside
 * one provider and wrong under a plural heading: the browse page shipped
 * *Providers that pays for finished tasks*. Storing the second form as well
 * would put *finished tasks* in two places, and two places drift the first time
 * a facet is reworded.
 *
 * So the part that does not change is what is stored, and each caller says which
 * subject it has. An unlisted facet still falls through to its own slug rather
 * than to silence, on the rule the phrase maps in `atlas.ts` follow.
 */
export function atlasEarnPhrase(facet: EarnFacet): string {
  const predicate = EARN_PREDICATES[facet]

  return predicate === undefined ? facet : `pays ${predicate}`
}

/** The same claim about several providers: *providers that **pay** a referral*. */
export function atlasEarnPhrasePlural(facet: EarnFacet): string {
  const predicate = EARN_PREDICATES[facet]

  return predicate === undefined ? facet : `pay ${predicate}`
}

/**
 * What the shelf clause on a provider header should say, or nothing.
 *
 * **Nothing, rather than *Uncategorised*, where the entry has an earn facet.**
 * A reader who has just been told this provider pays for finished tasks has been
 * classified; adding *and nobody has filed it on a shelf* spends a line on the
 * Colony's own bookkeeping. Where there is no earn facet either, the muted line
 * is what stops the page silently claiming nothing was asked.
 */
export function atlasShelfClause(entry: AtlasPublicEntry): string | undefined {
  if (!atlasShelfIsFallback(entry)) return undefined
  if (atlasEarnFacets(entry).length > 0) return undefined

  return 'no shelf fits it yet'
}

/**
 * The free-form tags on an entry, alphabetical and without repeats (`#1406`).
 *
 * **Additive and never a classification** (decision 1). A tag decides no shelf,
 * no earn facet and no neighbour ranking of its own — it is a label a walker put
 * on a provider, and the surfaces read it as one more thing the entry says about
 * itself rather than as a thing it *is*.
 *
 * **A missing facet list reads as no tags**, exactly as {@link atlasEarnFacets}
 * treats an absent one and for the same reason: `atlasPublicEntry` always writes
 * the field and the rows built by hand in this directory's tests do not.
 */
export function atlasTags(entry: AtlasPublicEntry): readonly string[] {
  return tagsOf(entry.facets ?? [])
}

/**
 * Whether the shelf may be printed as this entry's own classification.
 *
 * The predicate the header reads, named so the header does not have to restate
 * the rule — and so a second surface that wants the same answer gets the same
 * one.
 */
export function atlasShelfIsClaim(entry: AtlasPublicEntry): boolean {
  return !atlasShelfIsFallback(entry)
}

/**
 * Whether this entry is dual use *as a page may say it* (`#1388`).
 *
 * **`isDualUse` is right and is not what a renderer wants.** It answers a
 * question about a facet list — *does this carry both axes* — which is what
 * `#1301` defined and what a caller holding a list can ask. A renderer holds the
 * **entry**, and can therefore ask the question the list cannot: whether the
 * utility axis said anything, or whether the only thing on it is a shelf nobody
 * chose.
 *
 * Measured on `clawlancer.ai`, 2026-08-20, the day after `#1332` shipped the
 * chip: a bounty board whose kind reaches no shelf, sitting on the
 * `data-apis` fallback, wearing *worth holding, and pays*. `#1329` had demoted
 * that shelf out of the header two clauses earlier precisely because it is a
 * default and not a classification; the chip put it back in stronger words.
 *
 * So dual use on a page is *both axes said something*, and a fallback shelf said
 * nothing. What is left is a provider that pays, which the earn chip beside it
 * already states — one true claim instead of one true and one invented.
 */
export function atlasIsDualUse(entry: AtlasPublicEntry): boolean {
  if (atlasShelfIsFallback(entry)) return false

  return isDualUse(entry.facets ?? [])
}

/** The slug the fallback uses, re-exported so a renderer need not import core for it. */
export { ATLAS_FALLBACK_CATEGORY }

/**
 * Whether this shelf is the holding pen rather than a classification (`#1407`).
 *
 * A shelf-level counterpart to {@link atlasShelfIsFallback}, which asks about an
 * entry. The page for `data-apis` is the one place a reader meets the fallback
 * *as a shelf* — with a title, a standfirst and forty rows under it — and it is
 * the surface `#1407` names as the junk drawer.
 */
export function atlasShelfIsHoldingPen(slug: string): boolean {
  return slug === ATLAS_FALLBACK_CATEGORY
}

/**
 * What the holding pen's page says about itself (`#1407` decision 4).
 *
 * ## The sentence exists because the shelf reads as an answer and is not one
 *
 * `#1096` files a kind that reaches no shelf under the fallback rather than
 * dropping it, and that is right — a wrong shelf is a claim a reader can argue
 * with, a dropped entry is a walk nobody can find. `#1329` then stopped the
 * *entry* page presenting that shelf as the provider's identity.
 *
 * **Nothing was done about the shelf's own page**, and it is the one that reads
 * worst: a heading, a standfirst about data and APIs, and under it a bounty
 * board, a freelance marketplace and an LLM gateway. A reader arriving there is
 * being told, in the strongest form the site has, that these things belong
 * together. `#1407` decision 4 is that they must not be told that.
 *
 * ## What it does not do
 *
 * **It does not rename or split the shelf** (decision 1). Nothing here writes a
 * row; the sentence says what the rows already say and points at the one route
 * that can change them, which a maintainer walks. An auto-rename is exactly what
 * decision 1 refuses, and it would be refused by this function having no
 * database to write to even if somebody wanted one.
 */
export function atlasHoldingPenNote(count: number): string {
  return (
    `This is where an entry goes when its kind matches no shelf — ${count === 1 ? 'one entry is' : `${count} entries are`} ` +
    'filed here because nothing better existed, not because they belong together. ' +
    'Read it as a queue rather than as a category: what these providers have in common is ' +
    'that nobody has proposed a shelf that fits them.'
  )
}

/**
 * What a fallback-shelved entry says about not being classified (`#1407`
 * decision 4).
 *
 * ## Why this exists beside {@link atlasShelfClause} rather than inside it
 *
 * The two answer different questions and `#1329` settled the other one. That
 * clause is part of the **header**, where the page states what the provider *is*
 * — and it is deliberately silent on an entry carrying an earn facet, because a
 * reader who has just been told *this pays for finished tasks* has been
 * classified and *nobody has filed it on a shelf* would spend a line on the
 * Colony's bookkeeping. That reasoning is still right and is untouched.
 *
 * **This is not a header clause. It is the route to change the fact**, and it
 * belongs on every fallback entry including the earn-carrying ones — those are
 * precisely the entries `#1407` was filed about. Saying *no shelf fits this yet,
 * and here is how one gets proposed* to a reader who can act on it is not
 * bookkeeping; it is the difference between a taxonomy that is dead and one that
 * is living.
 *
 * Returns nothing for an entry whose shelf somebody chose, which is most of
 * them.
 */
export function atlasUncategorisedNote(entry: AtlasPublicEntry): string | undefined {
  if (!atlasShelfIsFallback(entry)) return undefined

  return (
    'No shelf fits this provider yet. It sits under the catalogue’s fallback because its ' +
    'kind matched nothing, which is a gap in the taxonomy rather than a fact about the ' +
    'provider — a walk report naming what it actually is is what closes it.'
  )
}
