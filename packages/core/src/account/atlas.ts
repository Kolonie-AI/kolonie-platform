import { z } from 'zod'
import { TimestampSchema } from '../common/time.js'
import { AccountProviderSchema } from './account.js'
import { AtlasFiguresSchema, atlasRank, noFigures, type AtlasFigures } from './atlas-figures.js'
import {
  AtlasCategorySchema,
  ProviderRecipeSchema,
  RecipeOperatorNeedSchema,
  RecipeStatusSchema,
  type ProviderRecipe,
} from './recipe.js'
import type { RecipeOperatorNeed, RecipeStatus } from './recipe.js'

/**
 * The Atlas: the provider catalogue, as something a stranger can read (`#546`).
 *
 * **The catalogue and the Atlas are one thing under two names, and that is
 * deliberate rather than sloppy.** `provider_recipes` is what the Colony stores
 * and `kolonie.accounts.providers` is what an agent calls; *Atlas* is the name
 * used with people — on the website, in a conversation with a provider. `#550`
 * refuses a second tool namespace for exactly this reason, and this module is
 * where the two names meet: one shape, assembled once, served to a browser
 * (`#547`), to an agent (`#550`) and as data (`#551`).
 *
 * ## Why the entry is not the row
 *
 * `provider_recipes` is unique on **(kind, provider)** — one row per thing you
 * can hold at a provider. A page per row would be `#547`'s doorway pattern
 * arriving from the database side: *github/account* and *github/website* are not
 * two subjects a reader is looking for, they are one provider with two things it
 * offers. So an **entry is a provider**, and its rows are what it carries.
 */

/** Where the Atlas answers, on the website's own host. */
export const ATLAS_PATH = '/atlas'

/**
 * How long a public Atlas response may be served from a cache.
 *
 * **Five minutes, and the number is chosen against the curation session rather
 * than against the traffic.** `#546` rejected a build-time Atlas because
 * curating twenty entries would mean twenty deploys; a cache measured in hours
 * would give that back — an editor fixing a wrong step would not see it and
 * would fix it again. Five minutes is short enough that a correction feels
 * applied and long enough that a crawler walking four hundred pages costs the
 * database almost nothing.
 */
export const ATLAS_CACHE_SECONDS = 300

/**
 * The path one provider's page is at.
 *
 * **The provider *is* the slug**, which is why there is no slug column anywhere.
 * `AccountProviderSchema` already normalises to one lowercase token whose
 * characters are all URL-safe, so deriving the path is a formatting concern and
 * not a stored fact — and a stored slug is a second copy of the provider's name
 * that can disagree with it.
 */
export function atlasPath(provider: string): string {
  return `${ATLAS_PATH}/${AccountProviderSchema.parse(provider)}`
}

/**
 * One Atlas entry: a provider, and everything the Colony knows about joining it.
 *
 * Assembled from rows rather than stored, so nothing can be true on the page and
 * false in the tool.
 */
export const AtlasEntrySchema = z.object({
  provider: AccountProviderSchema,
  /** The path this entry is served at, so no consumer has to build it. */
  path: z.string(),
  /**
   * What the entry is called, taken from the row a reader is most likely to want.
   *
   * A joinable row's title wins over a refusal's: a provider with one working
   * recipe and one refused kind is a provider you can join, and titling the page
   * with the refusal would say the opposite before the reader gets to the list.
   */
  title: z.string().min(1),
  /**
   * What this provider is, rolled up from its rows (`#588`).
   *
   * **The strongest thing true of any row wins**, in that order: `joinable` if
   * anything here can be joined honestly, else `refused` if anything was walked
   * and found closed, else `unwritten`. A provider with one working recipe and
   * one refused kind is a provider you can join, and the rows below say which is
   * which.
   *
   * `refused` means every row was looked at and none is passable — a page and not
   * an omission (`#482`), which `#547` requires to be a full one. `unwritten`
   * means nobody has looked at any of them, which is a different sentence and
   * must never be rendered as either of the other two.
   */
  status: RecipeStatusSchema,
  /**
   * The shelf this provider sits on (`#589`).
   *
   * **One category per entry and not the set of its rows'**, taken from the same
   * row the title comes from. An entry is a provider, and a provider listed on
   * two shelves is `#547`'s combination page arriving as an index — which
   * `growth/README.md` refuses in as many words: *one page per provider, never
   * one per combination*. The per-kind categories are still on the rows below,
   * where a reader who has arrived is looking at one provider anyway.
   */
  category: AtlasCategorySchema,
  /**
   * Whether this provider can be joined without an operator (`#589`).
   *
   * **The strictest row wins**: if any row on this entry needs an operator, the
   * entry does. An operator deciding whether to volunteer an afternoon is asking
   * *will I be needed here*, and answering *not for one of the three things* is
   * the answer that gets them called at the wrong moment.
   */
  operatorNeed: RecipeOperatorNeedSchema,
  /** True when the answer above rests on a guess rather than on a walked step. */
  operatorNeedIsGuess: z.boolean(),
  /**
   * One row per kind, in the catalogue's own order, each with what was measured
   * about it (`#545`). Never empty.
   */
  recipes: z.array(ProviderRecipeSchema.extend({ figures: AtlasFiguresSchema })).min(1),
  /** The most recent edit across the rows, which is what a reader wants dated. */
  updatedAt: TimestampSchema,
})
export type AtlasEntry = z.infer<typeof AtlasEntrySchema>

/**
 * What an account kind is called where a reader sees it (`#791`).
 *
 * **A heading is prose, and it is derived from the identifier rather than being
 * the identifier.** `trello`, `code-host` and `api` are what the rows are keyed
 * on; rendered as an `<h2>` they are a stray word under the title, and on an
 * entry with several rows they are the only thing telling the sections apart —
 * which is exactly when they need to be a sentence.
 *
 * **The article is baked into each value**, because it is the half that cannot
 * be computed: *a mailbox*, *an API account*, *a phone number*. A caller
 * prefixing its own article gets `a api` back, which is the fault this map was
 * written for.
 *
 * **A kind that is not here renders as its own slug** — ugly, and readable,
 * and nothing throws. {@link AccountKindSchema} is an open vocabulary rather
 * than an enum, so a curator can file a kind this map has never heard of; the
 * page that results must be plain rather than absent.
 */
export const ATLAS_KIND_PHRASES: Readonly<Record<string, string>> = {
  api: 'An API account',
  chat: 'A chat account',
  'code-host': 'A code-hosting account',
  design: 'A design account',
  domain: 'A domain',
  github: 'A GitHub account',
  hosting: 'A hosting account',
  identity: 'An identity account',
  mailbox: 'A mailbox',
  notes: 'A notes account',
  payments: 'A payments account',
  phone: 'A phone number',
  'project-tracker': 'A project tracker',
  social: 'A social account',
  storage: 'A storage account',
  storefront: 'A storefront',
  trello: 'A Trello account',
}

/**
 * What a capability is called where a reader sees it (`#791`).
 *
 * Separate from {@link ATLAS_KIND_PHRASES} because the same slug is a different
 * thing in the two places: `api` as a kind is an account you hold, `api` as a
 * capability is the key that account reaches. Falls back to the kind map — a
 * capability the Colony reaches by holding the thing itself reads correctly
 * there — and then to the slug.
 */
export const ATLAS_CAPABILITY_PHRASES: Readonly<Record<string, string>> = {
  api: 'An API key',
}

/**
 * What a shelf is called at the top of the index (`#791`).
 *
 * The `<h2>` and the nav link are the document outline a crawler reads, and
 * `identity-security` is not a title. **The slug is kept everywhere it is an
 * address**: the fragment `id` on the heading, and every `?category=` link,
 * which {@link atlasPath}'s neighbour builds from the same value.
 *
 * A category that is not here renders as its own slug, on the same argument as
 * the map above.
 */
export const ATLAS_SHELF_TITLES: Readonly<Record<string, string>> = {
  'code-hosting': 'Code hosting',
  'commerce-marketplace': 'Commerce and marketplaces',
  communication: 'Communication',
  'compute-hosting': 'Compute and hosting',
  'data-apis': 'Data and APIs',
  'design-media': 'Design and media',
  'domain-dns': 'Domains and DNS',
  'identity-security': 'Identity and security',
  'knowledge-docs': 'Knowledge and documents',
  mailbox: 'Mailboxes',
  'payments-finance': 'Payments and finance',
  'project-tracking': 'Project tracking',
  'social-publishing': 'Social and publishing',
  storage: 'Storage',
  telephony: 'Telephony',
}

/** The noun phrase for an account kind, or the slug if this one is new. */
export function atlasKindPhrase(kind: string): string {
  return ATLAS_KIND_PHRASES[kind] ?? kind
}

/** The noun phrase for a capability, or the kind's, or the slug. */
export function atlasCapabilityPhrase(capability: string): string {
  return ATLAS_CAPABILITY_PHRASES[capability] ?? atlasKindPhrase(capability)
}

/** The shelf title for a category, or the slug if this one is new. */
export function atlasShelfTitle(category: string): string {
  return ATLAS_SHELF_TITLES[category] ?? category
}

/**
 * Group catalogue rows into entries, one per provider.
 *
 * **Here rather than in a query**, because every surface needs the same grouping
 * and a `GROUP BY` returning JSON would put the assembly in SQL where the shape
 * cannot be parsed. `providerRecipeList` already orders joinable-first then by
 * kind and provider; this preserves the order it was given and never re-sorts,
 * so the catalogue has one order and it is stated in one place.
 */
export function atlasEntries(
  recipes: readonly ProviderRecipe[],
  /**
   * What was measured, by `kind\u0000provider` (`#545`).
   *
   * **Optional, and an absent figure is `noFigures` rather than an error.** A
   * colony where nobody has attempted a provider is the ordinary early state of
   * every entry, and a surface that could not render one would be a surface that
   * cannot show a newly written recipe.
   */
  figures: ReadonlyMap<string, AtlasFigures> = new Map(),
): readonly AtlasEntry[] {
  const byProvider = new Map<string, ProviderRecipe[]>()

  for (const recipe of recipes) {
    const held = byProvider.get(recipe.provider)
    if (held === undefined) byProvider.set(recipe.provider, [recipe])
    else held.push(recipe)
  }

  return [...byProvider.entries()].map(([provider, rows]) => {
    const status = atlasEntryStatus(rows)

    /**
     * The title comes from a row in the entry's own state, so a page is never
     * named after something it does not say. A provider with one working recipe
     * is titled by the working one; a provider nobody has looked at is titled by
     * an unwritten row, which is the only kind it has.
     */
    const lead = rows.find((row) => row.status === status) ?? rows[0]

    /**
     * `byProvider` only ever holds keys it pushed a row under, so this cannot
     * happen — and it is thrown rather than defaulted because the alternative is
     * inventing a category for an entry that has no rows, which would put a
     * provider on a shelf nobody chose.
     */
    if (lead === undefined) throw new Error(`atlasEntries: no rows for ${provider}`)

    const need = atlasEntryOperatorNeed(rows)

    return {
      provider: AccountProviderSchema.parse(provider),
      path: atlasPath(provider),
      title: lead.title,
      status,
      category: lead.category,
      operatorNeed: need.need,
      operatorNeedIsGuess: need.isGuess,
      recipes: rows.map((row) => ({
        ...row,
        figures:
          figures.get(figureKey(row.kind, row.provider)) ?? noFigures(row.kind, row.provider),
      })),
      updatedAt: rows
        .map((row) => row.updatedAt)
        .reduce((latest, at) => (at > latest ? at : latest)),
    }
  })
}

/**
 * What one provider is, from what its rows are (`#588`, `#604`).
 *
 * **Not `some(joinable)` with a boolean's two answers.** The rollup has to keep
 * *walked and closed* apart from *nobody looked*, and a provider whose every row
 * is unwritten is the one the old shape could not express at all — it came out as
 * *cannot be joined*, which is a claim about the provider the Colony has not
 * earned.
 *
 * **The order is a finding first, and `unwritten` last**, which is the principle
 * `#588` set and `#604` extended rather than changed: four of the six states are
 * something the Colony learned, and one is the admission that it has not looked.
 * A row that says something outranks a row that says nothing about the same
 * provider.
 *
 * **This is the opposite of `atlasRank`'s order and that is not a bug.** There,
 * `refused` sorts *below* `unwritten`, because ranking answers *where should a
 * reader look first* and a road that may work beats one known to be closed. Here
 * the question is *which row describes this provider*, and a walked refusal
 * describes it better than a row nobody has opened. The two functions answer two
 * questions and the answers point in different directions; a test asserts each,
 * because the natural instinct on reading one is to make the other match it.
 *
 * `#604`'s two visible states slot in by the same rule. `draft` is a finding —
 * somebody walked it — so it sits under `joinable`. `retired` is a finding too,
 * and sits under `refused`: both say the road is not open, and a reader learns
 * more from *there is no honest route* than from *the Colony withdrew this*.
 *
 * **`proposed` never reaches here.** Nothing public reads a proposed row — see
 * `recipeStatusIsPublic` — and if every row of a provider is proposed the
 * provider is not on the Atlas at all, so there is nothing to roll up. The
 * fallback below is `unwritten` rather than `proposed` for that reason: an empty
 * rollup means *on the map, nobody has looked*.
 *
 * Exported because `#591`'s browsing surface and the website's index group by it,
 * and a second implementation of this ordering is a second answer to it.
 */
export function atlasEntryStatus(rows: readonly { readonly status: RecipeStatus }[]): RecipeStatus {
  const order: readonly RecipeStatus[] = ['joinable', 'draft', 'refused', 'retired', 'unwritten']

  return order.find((status) => rows.some((row) => row.status === status)) ?? 'unwritten'
}

/**
 * Whether a provider needs an operator anywhere on it (`#589`).
 *
 * **The strictest row wins, and an unknown row does not soften a known one.** A
 * provider with one walked recipe that needs an operator and one nobody has
 * looked at needs an operator: the first is a fact, and the second is silence.
 * The order is `operator-needed`, then `unknown`, then `unaided` — the middle
 * one sits where it does because *we do not know* must never read as *you are
 * not needed*, which is the sentence that gets somebody called at the wrong
 * moment.
 *
 * The guess flag rides on whichever row decided it, so a page can say *needs
 * you, we think* without a second field for the reason.
 */
export function atlasEntryOperatorNeed(
  rows: readonly {
    readonly operatorNeed: RecipeOperatorNeed
    readonly operatorNeedIsGuess: boolean
  }[],
): { readonly need: RecipeOperatorNeed; readonly isGuess: boolean } {
  for (const need of ['operator-needed', 'unknown', 'unaided'] as const) {
    const found = rows.filter((row) => row.operatorNeed === need)
    if (found.length === 0) continue

    /** A guess only where *every* row that decided it was one. */
    return { need, isGuess: found.every((row) => row.operatorNeedIsGuess) }
  }

  return { need: 'unknown', isGuess: false }
}

/**
 * The catalogue as data, for a reader with no credential (`#551`).
 *
 * **Not what the website is built from** — `#546` settled that the pages are
 * rendered by the API rather than from a feed, so this blocks nothing and should
 * not pretend to. What it is for is `llms-full.txt` reading a bounded index
 * rather than the website holding a copy, third parties who want to tell their
 * own users which providers an agent can join, and the plainest reason of all:
 * **the Atlas is only worth trusting if it can be checked**, and a catalogue
 * readable only through our own pages is one nobody can audit.
 */
export const AtlasDocumentSchema = z.object({
  /**
   * When this answer was assembled.
   *
   * **A consumer has to be able to tell a stale copy from a current one**, and
   * the entries' own `updatedAt` cannot do it: a catalogue nobody edited for a
   * month and a cached response from a month ago look identical through them.
   */
  generatedAt: TimestampSchema,
  /**
   * How long this may be treated as current, in seconds.
   *
   * Stated in the document as well as in the header, because a consumer that
   * stored the body has thrown the header away — and the one that did is exactly
   * the one at risk of serving a year-old catalogue as fact.
   */
  maxAgeSeconds: z.int().min(0),
  entries: z.array(AtlasEntrySchema),
})
export type AtlasDocument = z.infer<typeof AtlasDocumentSchema>

/**
 * How a figure is looked up: the pair that identifies the recipe it measures.
 *
 * A NUL separator rather than a hyphen or a colon, because both are legal inside
 * a provider — `mail.tm` and `x-com` are ordinary values — and a separator that
 * can appear in a key is a collision waiting for the provider that contains it.
 */
export function figureKey(kind: string, provider: string): string {
  return `${kind}\u0000${provider}`
}

/**
 * The catalogue in the order a visitor should meet it (`#545`).
 *
 * **Ordered by measured outcome, never by payment**, and derived on every read
 * rather than stored — which is what makes it something nobody can buy. A
 * visitor should be able to see at a glance which providers are actually
 * passable by an agent; `#547` calls that ordering the product.
 *
 * Ties fall back to the catalogue's own order, so two unmeasured entries stay
 * where `providerRecipeList` put them rather than swapping between reads.
 */
export function atlasByOutcome(entries: readonly AtlasEntry[]): readonly AtlasEntry[] {
  return entries
    .map((entry, index) => ({
      entry,
      index,
      rank: atlasRank({
        status: entry.status,
        figures: entry.recipes.map((recipe) => recipe.figures),
      }),
    }))
    .sort((a, b) => b.rank - a.rank || a.index - b.index)
    .map((one) => one.entry)
}
