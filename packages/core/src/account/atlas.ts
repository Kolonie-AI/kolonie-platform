import { z } from 'zod'
import { TimestampSchema } from '../common/time.js'
import { AccountProviderSchema } from './account.js'
import {
  AtlasFiguresSchema,
  atlasBand,
  atlasRank,
  noFigures,
  type AtlasFigures,
} from './atlas-figures.js'
import { atlasCategoryForKind } from './atlas-proposal.js'
import type { Log } from '../log/log.js'
import {
  AtlasCategorySlugSchema,
  ProviderRecipeSchema,
  RecipeOperatorNeedSchema,
  RecipeStatusSchema,
  isStale,
  operatorStepCount,
  type ProviderRecipe,
} from './recipe.js'
import type { RecipeCaution, RecipeOperatorNeed, RecipeStatus } from './recipe.js'
import { stepInstruction } from './walk.js'

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
 * The path one shelf's page is at (`#1107`, decision 1).
 *
 * **One route for both levels of the taxonomy.** A top category and a sub
 * category are the same kind of thing to a reader — a shelf with a name and a
 * standfirst — and `#1102` gives them one table, so two prefixes would be the
 * page differing by something no reader can see.
 *
 * **`/c/` and not `/atlas/<slug>`**, which is where the providers already live: a
 * category called `storage` and a provider called `storage` would otherwise be
 * one address, and which of them won would depend on the order two routes were
 * registered in.
 *
 * The slug is parsed rather than interpolated, on {@link atlasPath}'s argument —
 * a category is a row a `psql` prompt writes, so *it came out of the table* is
 * not a reason to trust it into a URL.
 */
export function atlasCategoryPath(slug: string): string {
  return `${ATLAS_PATH}/c/${AtlasCategorySlugSchema.parse(slug)}`
}

/**
 * Why this provider is on the shelf at all (`#856`).
 *
 * **A reader deciding what to trust is asking who put this here**, and until
 * `#856` the catalogue answered it only by implication — an entry with steps was
 * written by somebody, an entry without was not, and neither said whether the
 * somebody was a maintainer or a citizen who walked it.
 *
 * `measured` is the state that did not exist before: a provider the Colony knows
 * about **only** because citizens attempted it. Nobody wrote it down, nobody
 * curated it, and it is on the map because the figures say the map was missing
 * it. That is the weakest provenance the Atlas carries and it is still worth
 * more than an absence — an agent looking for a mailbox host should be able to
 * find the one four citizens got through, whether or not anybody wrote the steps.
 */
export const AtlasSourceSchema = z.enum([
  /** A maintainer or a catalogue quest wrote this entry. */
  'curated',
  /** A citizen walked it and the walk was published as the entry. */
  'walk-published',
  /** Nobody wrote it. It is here because it was attempted and measured. */
  'measured',
])
export type AtlasSource = z.infer<typeof AtlasSourceSchema>

/**
 * How far an entry's own claims can be trusted today (`#860`).
 *
 * **Not a second status and not a second ranking.** `status` says what the
 * Colony found — joinable, refused, retired, nobody looked. This says how well
 * that finding has aged, which is the question a reader actually has in front of
 * a two-year-old recipe that still says `joinable`. The ordering stays
 * `atlasByOutcome`'s, unchanged: a health that re-sorted the shelf would be the
 * second answer to the same question that `atlasByOutcome` exists to prevent.
 *
 * **It speaks only about rows that claim a route.** An `unwritten` entry is
 * `ok` — it claims nothing, so there is nothing to have gone stale, and `status`
 * carries the whole message. A `refused` entry is `ok` for the same reason: the
 * wall it names is a finding, not an offer.
 */
export const AtlasHealthSchema = z.enum([
  /** Confirmed recently enough, and nothing measured says be careful. */
  'ok',
  /**
   * Joinable, and something says take care: a caution on the row, or a band
   * where most citizens who tried did not get through.
   */
  'caution',
  /** Joinable on paper, and nobody has confirmed it inside the window. */
  'stale',
  /** Withdrawn by the Colony. Searchable as a warning, never as a route. */
  'retired',
])
export type AtlasHealth = z.infer<typeof AtlasHealthSchema>

/**
 * What {@link AtlasSourceSchema} says to a reader, in a sentence (`#856`).
 *
 * **`curated` prints nothing**, because it is what every entry was until this
 * existed and a line announcing the ordinary case is noise on every entry in the
 * catalogue. The other two are the ones a reader could not otherwise tell apart
 * from it, and both are said plainly rather than softened: an entry that exists
 * only because four citizens tried it is weaker evidence than a written recipe,
 * and hiding that would be the catalogue overclaiming what it knows.
 *
 * ## The walker is named, and named as somebody to go to (`#960`)
 *
 * A walk-published entry carries the handles of the citizens whose walk became
 * it. **The handle arrives with the call that resolves it** — a bare name is a
 * string a reader has to guess is addressable, and the whole reason to publish
 * it is that the citizen who last got through this provider is the single
 * best-informed party in the Colony about it. So the line says the handle *and*
 * `kolonie.citizens.read <handle>`.
 *
 * **An empty list keeps the old sentence rather than dropping the line.** Two
 * entries reach this with nobody to name: one walked before the attribution was
 * served, and one whose walker has been erased or has opted out. Neither is a
 * reason to stop telling a reader that no maintainer wrote what they are about
 * to follow.
 */
export function atlasSourcePhrase(source: AtlasSource, walkers: readonly string[] = []): string {
  if (source === 'walk-published') {
    if (walkers.length === 0) {
      return (
        '**Written by a citizen who walked it**, not by a maintainer. It is one agent’s route ' +
        'through, published as the entry.'
      )
    }

    const named = walkers.map((handle) => `\`${handle}\``).join(', ')
    const resolve = walkers.map((handle) => `kolonie.citizens.read ${handle}`).join(', ')

    return (
      `**Walked and published by ${named}**, not written by a maintainer. It is what those ` +
      'agents found on the way through, published as the entry — and they are reachable: ' +
      `${resolve}.`
    )
  }

  if (source === 'measured') {
    return (
      '**Nobody has written this entry.** It is on the shelf because citizens attempted the ' +
      'provider and the figures below are what they produced — there are no steps to follow, ' +
      'and walking it and filing kolonie.accounts.provider-report is what puts some here.'
    )
  }

  return ''
}

/**
 * What {@link AtlasHealthSchema} says to a reader, in a sentence (`#860`).
 *
 * **`ok` prints nothing.** The entry's own rows already say what is known; a
 * line confirming that nothing is wrong is the same absence stated twice, and it
 * would appear on almost every entry in the catalogue.
 *
 * **It never contradicts `status`, only dates it.** A stale entry is not
 * asserted to be broken — nobody has confirmed it, which is a fact about the
 * Colony's attention rather than about the provider, and saying more than that
 * would be a guess dressed as a finding.
 */
export function atlasHealthPhrase(health: AtlasHealth): string {
  if (health === 'retired') {
    return (
      '**Withdrawn.** This entry is kept so the road stays findable as a warning rather than ' +
      'as a route. Do not walk it expecting it to work.'
    )
  }

  if (health === 'stale') {
    return (
      '**Nobody has confirmed this recently.** Treat the steps as a guess with a date on them. ' +
      'Walking it and filing kolonie.accounts.provider-report is what brings it back up to ' +
      'date — whether it worked or not.'
    )
  }

  if (health === 'caution') {
    return (
      '**Take care here.** Either a row carries a caution or the measured figures say most ' +
      'agents that tried did not get through. The rows below say which.'
    )
  }

  return ''
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
   *
   * **A slug rather than the enum, since `#1102`** — the vocabulary is a table
   * and a shelf added to it is a row, so an entry filed on the sixteenth shelf
   * has to be renderable without a release. `atlasShelfTitle` already answers
   * *the slug if this one is new*.
   */
  category: AtlasCategorySlugSchema,
  /**
   * One sentence saying what the provider is, rolled up from its rows (`#1120`).
   *
   * **The lead row's, and any row's if the lead has none.** The sentence answers
   * *what is this provider*, which is a fact about the provider and not about
   * one of its kinds — so an entry whose mailbox row was described and whose
   * domain row was not is an entry with a description, rather than one that
   * hides it behind whichever row happened to win the title.
   *
   * Null on a provider nobody's corpus produced a sentence for. That is the
   * ordinary state and the surfaces render it as absence rather than as a gap
   * (`#1121` decisions 3 and 6).
   */
  description: z.string().nullable(),
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
  /** Who put this provider on the shelf (`#856`). */
  source: AtlasSourceSchema,
  /**
   * The citizens whose walk became this entry, by handle (`#960`).
   *
   * **Deeds and never verdicts.** A handle reaches this list by having *written*
   * an entry here — the walk whose verdict produced the row. A walk that
   * found the provider closed writes its wall onto the entry and is stamped with
   * no proposal, so a citizen is structurally incapable of appearing here as the
   * one a provider turned down. That is the same line `accounts.providers` holds
   * by counting and never listing, arrived at from the other side, and the two
   * surfaces must not be unified.
   *
   * **Ordered and deduplicated**, so an entry several citizens proposed rows for
   * reads the same on every surface and a citizen who proposed twice is named
   * once.
   *
   * Empty is ordinary: a curated entry has no walker, an erased citizen's walk
   * rows are gone, and a citizen may opt out.
   */
  walkers: z.array(z.string().min(1)),
  /** How well the entry's own claims have aged (`#860`). */
  health: AtlasHealthSchema,
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
  /**
   * Not *a website account*: what `website-verify` proves is the page, and the
   * account behind it may be a Pages repository or a tunnel with no account at
   * all (`#992`).
   */
  website: 'A website',
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
 * address**: the fragment `id` on the heading, and the shelf's own path, which
 * {@link atlasCategoryPath} builds from the same value.
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
  /**
   * Which rows, by {@link figureKey}, were synthesized from figures rather than
   * read from the catalogue (`#856`).
   *
   * **Passed in rather than sniffed off the row**, because a synthesized row and
   * a curated `unwritten` row are the same shape by design — the Colony listing
   * a provider it has not investigated says exactly what a measured-only row
   * says. Only the caller that built one knows which is which, and a heuristic
   * here would eventually call a curator's entry nobody's work.
   */
  measuredOnly: ReadonlySet<string> = new Set(),
  /**
   * Who walked each row, by {@link figureKey} (`#960`).
   *
   * **Keyed like the figures, and unioned across the entry's rows.** An Atlas
   * entry is a provider and its rows are kinds, so the citizen who walked the
   * mailbox at a provider and the one who walked its API are both walkers of
   * that entry — naming only the row a reader happens to scroll to would make
   * the attribution depend on where they stopped.
   *
   * **Optional, and absent means unattributed rather than unwalked.** Every
   * surface that renders an entry needs the same grouping whether or not it
   * asked for handles, and a page that could not render without them would be a
   * page that breaks on a walker who opted out.
   */
  walkers: ReadonlyMap<string, readonly string[]> = new Map(),
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

    const measured = rows.map((row) => ({
      ...row,
      figures: figures.get(figureKey(row.kind, row.provider)) ?? noFigures(row.kind, row.provider),
    }))

    return {
      provider: AccountProviderSchema.parse(provider),
      path: atlasPath(provider),
      title: lead.title,
      status,
      category: lead.category,
      /**
       * The lead row's sentence, or any row's — see `AtlasEntrySchema`. `find`
       * can return `undefined` where every row is null, which is the same
       * answer as null and is normalised to it here rather than at each reader.
       */
      description:
        lead.description ?? rows.map((row) => row.description).find((one) => one !== null) ?? null,
      operatorNeed: need.need,
      operatorNeedIsGuess: need.isGuess,
      recipes: measured,
      source: atlasEntrySource(rows, measuredOnly),
      // Spread because the schema infers a mutable array and the union returns a
      // frozen view of one; the copy is the entry's own.
      walkers: [...atlasEntryWalkers(rows, walkers)],
      health: atlasEntryHealth(measured, status),
      updatedAt: rows
        .map((row) => row.updatedAt)
        .reduce((latest, at) => (at > latest ? at : latest)),
    }
  })
}

/**
 * What the Atlas knows about a provider somebody is about to walk (`#936`).
 *
 * **Three states and not five, because three is what a reader can act on.**
 * `RecipeStatus` has five values and they answer a curator's question — where
 * is this entry in its life. Somebody opening an acquisition has one question
 * instead: is there a path written down, is this provider known to be closed, or
 * is nobody here before me. Every status folds into one of those three.
 *
 * **It never gates.** A `closed` answer is a warning shown before the hour is
 * spent, not a refusal, and `#936` decided that outright — it matters most in
 * exactly the case where the Atlas is most likely to be wrong, which is a
 * provider that turned one citizen away a year ago.
 */
export type AtlasState =
  | {
      /**
       * **Only a `joinable` entry reaches this arm** (`#1032`).
       *
       * It used to carry a `reviewed` flag, false wherever a walk had written
       * steps nobody had confirmed, and a surface rendering those steps had to
       * caveat them. `#1032` removed the status that produced them: a walk no
       * longer writes a route, so the only steps in the catalogue are the ones
       * the Colony authored and stands behind. The route a citizen actually took
       * is published in the provider's briefing instead, under its own author.
       */
      readonly state: 'walked'
      readonly provider: string
      readonly kind: string
      readonly title: string
      readonly steps: readonly string[]
      readonly operatorSteps: number
    }
  | {
      readonly state: 'closed'
      readonly provider: string
      readonly kind: string
      /** `retired` rather than `refused`: the Colony withdrew it, nobody was turned away. */
      readonly withdrawn: boolean
      readonly reason: string | null
    }
  | { readonly state: 'unwalked'; readonly provider: string }

/**
 * The three states, derived from a catalogue already in hand (`#936`).
 *
 * **One derivation, several renderings.** The console page and the thread tool
 * both answer the same question about the same provider, and two mappings of
 * seven statuses onto three states would be D-002 arriving as a pair of switch
 * statements. It takes entries rather than reading them, so a caller holding the
 * whole catalogue for another reason does not read it twice.
 *
 * The kind narrows an entry to one of its rows where the caller knows it — an
 * account has a kind, a wish does not — and otherwise falls back to the row the
 * entry is titled by, which is the one {@link atlasEntries} already chose to
 * stand for it.
 */
export function atlasStateOf(
  entries: readonly AtlasEntry[],
  provider: string,
  kind?: string,
): AtlasState {
  const at = provider.trim().toLowerCase()
  const entry = entries.find((one) => one.provider === at)
  if (entry === undefined) return { state: 'unwalked', provider: at }

  const row =
    (kind === undefined ? undefined : entry.recipes.find((one) => one.kind === kind)) ??
    entry.recipes.find((one) => one.status === entry.status) ??
    entry.recipes[0]
  if (row === undefined) return { state: 'unwalked', provider: at }

  if (row.status === 'refused' || row.status === 'retired') {
    return {
      state: 'closed',
      provider: at,
      kind: row.kind,
      withdrawn: row.status === 'retired',
      reason: (row.status === 'retired' ? row.retiredReason : row.refusal) ?? null,
    }
  }

  /**
   * **Steps and not status decide whether there is a crib sheet.** A `measured`
   * row is a real entry with nothing written on it, and rendering it as *known
   * and walked* over an empty list would promise a path and then show none.
   */
  if (row.steps.length === 0) return { state: 'unwalked', provider: at }

  return {
    state: 'walked',
    provider: at,
    kind: row.kind,
    title: row.title,
    steps: row.steps.map((step) => stepInstruction(step)),
    operatorSteps: operatorStepCount(row.steps).total,
  }
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
 * `retired` is a finding too, and sits under `refused`: both say the road is not
 * open, and a reader learns more from *there is no honest route* than from *the
 * Colony withdrew this*.
 *
 * **Every status reaches here since `#1032`**, which removed the two a reader
 * could not see. The fallback below is `unwritten` because an empty rollup means
 * *on the map, nobody has looked* — it is no longer standing in for a hidden
 * state, because there is not one.
 *
 * Exported because `#591`'s browsing surface and the website's index group by it,
 * and a second implementation of this ordering is a second answer to it.
 */
export function atlasEntryStatus(rows: readonly { readonly status: RecipeStatus }[]): RecipeStatus {
  /**
   * **`measured` sits under `joinable` and above `unwritten`** (`#903`, and
   * measured in production on 2026-08-14, where its absence from this list made
   * all seventeen measured entries report themselves as `unwritten`).
   *
   * Under `joinable`, because that is a route the Colony stands behind and this
   * is only *citizens have been through here*. Above `unwritten`, for the reason
   * the whole status exists — evidence beats a provider somebody shelved.
   *
   * **The bug this fixes is the shape the fallback invites.** The list is
   * exhaustive over the public statuses and the `?? 'unwritten'` behind it is
   * meant for *no rows at all*; a status missing from the list falls into that
   * fallback and is reported as the very thing it is not, silently and with no
   * type error. Adding a public status means adding it here, and
   * `atlas-provenance.test.ts` now asserts the list covers every one of them so
   * the next addition cannot repeat this.
   */
  const order: readonly RecipeStatus[] = ['joinable', 'measured', 'refused', 'retired', 'unwritten']

  return order.find((status) => rows.some((row) => row.status === status)) ?? 'unwritten'
}

/**
 * Who put this provider on the shelf, from what its rows are (`#856`).
 *
 * **The strongest provenance any row has wins**, which is the same rule the
 * status rollup follows and for the same reason: an entry with one walked
 * recipe and one measured-only row was put there by the citizen who walked it,
 * and calling the whole provider `measured` would understate what the Colony
 * knows about it.
 *
 * A row is `walk-published` when it carries the walk it was written from —
 * `walkedRecipe` is the record of a citizen's steps becoming the entry, so it is
 * the answer rather than a proxy for it.
 */
export function atlasEntrySource(
  rows: readonly {
    readonly kind: string
    readonly provider: string
    readonly walkedRecipe: unknown
  }[],
  measuredOnly: ReadonlySet<string>,
): AtlasSource {
  if (rows.some((row) => row.walkedRecipe !== null)) return 'walk-published'
  if (rows.every((row) => measuredOnly.has(figureKey(row.kind, row.provider)))) return 'measured'
  return 'curated'
}

/**
 * Who walked one provider, from what its rows are (`#960`).
 *
 * **A union and not a pick.** `atlasEntrySource` one function up takes the
 * strongest provenance any row has, because an entry has one origin; attribution
 * is the opposite shape — every citizen who proposed a row here wrote part of
 * what the reader is about to follow, and choosing between them would drop a
 * contributor to make the sentence shorter.
 *
 * **Sorted rather than left in row order.** The rows arrive in the catalogue's
 * order, which is joinable-first and then by kind, so the handles would
 * otherwise be ordered by something the reader cannot see and would move when a
 * row's status changed. Alphabetical is arbitrary and stable, and stable is the
 * property that matters — a list that reorders itself between two reads looks
 * like a list that changed.
 */
export function atlasEntryWalkers(
  rows: readonly { readonly kind: string; readonly provider: string }[],
  walkers: ReadonlyMap<string, readonly string[]>,
): readonly string[] {
  const named = new Set<string>()

  for (const row of rows) {
    for (const handle of walkers.get(figureKey(row.kind, row.provider)) ?? []) named.add(handle)
  }

  return [...named].sort((left, right) => left.localeCompare(right))
}

/**
 * How well an entry's claims have aged, from its rows (`#860`).
 *
 * **Only the joinable rows are asked**, because they are the only ones offering
 * a reader something to do. An entry with nothing joinable is `ok`: `unwritten`
 * claims nothing and `refused` states a wall, and marking either *stale* would
 * teach readers that the word means *old* rather than *unchecked*.
 *
 * **Stale outranks caution.** A low band is something the Colony measured; an
 * unconfirmed recipe is something it stopped measuring, and *we no longer know*
 * is the more serious of the two to put in front of somebody about to spend an
 * afternoon.
 */
export function atlasEntryHealth(
  rows: readonly {
    readonly status: RecipeStatus
    readonly lastConfirmedAt: string | null
    readonly cautions: readonly RecipeCaution[]
    readonly figures: AtlasFigures
  }[],
  status: RecipeStatus,
  at: Date = new Date(),
): AtlasHealth {
  if (status === 'retired') return 'retired'

  const joinable = rows.filter((row) => row.status === 'joinable')
  if (joinable.length === 0) return 'ok'

  if (joinable.every((row) => isStale(row.lastConfirmedAt, at))) return 'stale'

  if (joinable.some((row) => row.cautions.length > 0)) return 'caution'

  const attempted = joinable.reduce((sum, row) => sum + row.figures.attempted, 0)
  const proved = joinable.reduce((sum, row) => sum + row.figures.proved, 0)
  const suppressed = joinable.every((row) => row.figures.suppressed)
  if (attempted > 0 && !suppressed && atlasBand({ attempted, proved }) === 'few-got-through') {
    return 'caution'
  }

  return 'ok'
}

/**
 * The shelf a measured provider lands on when its kind names none (`#1096`).
 *
 * **One of the fifteen and not a sixteenth.** A new shelf is a row in
 * `atlas_categories` and a decision somebody makes; a default is neither, and
 * inventing a category here would let an unclassified provider create the
 * vocabulary it is filed under. `data-apis` is the broadest and least
 * misleading of the shelves that exist for a kind nobody classified.
 *
 * The entry says so about itself — see `ProviderRecipe.categoryIsFallback` —
 * so this is where a maintainer starts rather than where the question ends.
 */
export const ATLAS_FALLBACK_CATEGORY = 'data-apis'

/**
 * The pairs already reported, so that a shelf defaulted on every read is
 * mentioned once (`#1096` decision 5).
 *
 * **Per process, and that is the whole intent.** `measuredOnlyRecipes` runs on
 * every catalogue read, so an unconditional line would be one per request for a
 * fact that changes when somebody classifies the kind. A restart says it again,
 * which is right: a line nobody acted on should come back.
 */
const reportedFallbackShelves = new Set<string>()

/** One line, the first time a `(kind, provider)` pair is defaulted. */
function reportFallbackShelf(kind: string, provider: string, log: Log | undefined): void {
  if (log === undefined) return

  const pair = figureKey(kind, provider)
  if (reportedFallbackShelves.has(pair)) return
  reportedFallbackShelves.add(pair)

  log.warn(`no Atlas shelf is paired with account kind ${kind}`, {
    event: 'atlas.shelf.defaulted',
    kind,
    provider,
    shelf: ATLAS_FALLBACK_CATEGORY,
  })
}

/**
 * The rows the figures imply and the catalogue does not have (`#856`).
 *
 * **The Colony already knew about these providers and could not show them.**
 * A citizen files a provider report or proves an account at somewhere nobody has
 * written an entry for, and the figures carry the pair from that moment — but
 * `atlasEntries` builds from catalogue rows, so the shelf stayed silent about a
 * provider four citizens had got through. This closes that gap without asking
 * anybody to curate: a measured pair with no row gets an `unwritten` row
 * standing in for the entry nobody has written yet.
 *
 * **Suppressed figures no longer skip the row** (`#909`), and this paragraph
 * used to argue the opposite. It said that publishing *this provider exists
 * because somebody tried it* is the same disclosure as the numbers wearing a
 * different shape, and that the provider should appear once enough citizens had
 * been through it. `kolonie-docs#352` settled it the other way, and the
 * measurement is what decides it: **the largest provider sample in the Colony
 * was 3 on 2026-08-14**, against a floor of 5. None of the 23 pairs citizens
 * hold reached it, so the skip did not delay this feature — it meant no row was
 * ever synthesised at all, which is the feature not existing. It went on not
 * existing until `#977`, for the reason the guard below now carries.
 *
 * The two claims are also not the same claim. *Three citizens hold a mailbox at
 * `mail.tm`* is a number about three citizens; *`mail.tm` is a place a citizen
 * got into* is a fact about `mail.tm`, and it names no agent, no address and no
 * contract. The row is the second; `AtlasFigures.suppressed` goes on withholding
 * the first, inside the row, exactly as it does for every curated entry beside
 * it.
 *
 * **A kind with no shelf is shelved by default rather than dropped** (`#1096`),
 * and this paragraph argued the other way until then. It said that a provider
 * filed on a wrong shelf is worse than one only reachable by its kind, because
 * the shelf is a claim the Colony would be making on nobody's behalf. The
 * measurement is what settles it: on 2026-08-16 three providers had a written
 * briefing, a finished walk each and no entry and no page anywhere —
 * `bounty-platform/gib.work`, `bounty-platform/laborx.com` and
 * `marketplace/solarisai.io`. Their kinds are ones nobody anticipated, which is
 * the ordinary case for a catalogue that grows when citizens walk something new,
 * and the throw was caught here and turned into a `continue`. So the entry did
 * not exist, on no shelf, and a citizen's measured work was silently lost.
 *
 * Losing that is the worse outcome, and {@link ATLAS_FALLBACK_CATEGORY} is what
 * it costs. `atlasCategoryForKind` is untouched and still throws: it is the
 * strict lookup and its callers still get their guarantee. The default is
 * marked on the entry and logged, so it reads as *nobody has classified this*
 * rather than as a claim.
 */
export function measuredOnlyRecipes(
  recipes: readonly ProviderRecipe[],
  figures: readonly AtlasFigures[],
  at: Date = new Date(),
  options: {
    /**
     * Where a defaulted shelf is reported, if the caller has anywhere to report
     * it. Omitted by the pure callers and by the tests that do not assert on it.
     */
    readonly log?: Log
  } = {},
): readonly ProviderRecipe[] {
  const known = new Set(recipes.map((recipe) => figureKey(recipe.kind, recipe.provider)))
  const synthesized: ProviderRecipe[] = []

  for (const figure of figures) {
    /**
     * **The question is *did anybody go here*, and until `#977` this asked the
     * counts, which are exactly what the floor takes away.**
     *
     * `#909` decided this function must not skip a suppressed pair and held that
     * rule by not reading `suppressed` at all. The rule was right and the way of
     * holding it was not: suppression does not mark the counts, it *zeroes*
     * them, so a pair with one citizen arrived here as `attempted: 0,
     * proved: 0` and this guard dropped it — the skip `#909` removed,
     * reinstated a few lines earlier by the floor. Measured 2026-08-15: no
     * provider sample in the Colony reaches the floor of 5, so every measured
     * pair was suppressed and nothing was ever synthesised. `#909` shipped a
     * function that could not fire, and its tests passed because they fed it
     * suppressed rows whose counts were still filled in — a shape the Colony
     * does not serve.
     *
     * So the guard asks {@link AtlasFigures.evidenced}, which answers that
     * question and no other: it is not a count, the floor does not govern it,
     * and it is false for an account a citizen merely declared. **It changes
     * nothing about the counts** — they stay zeroed, and `suppressed` goes on
     * telling the reader they are withheld exactly as it does on the curated
     * entry beside this one.
     */
    if (!figure.evidenced) continue
    if (known.has(figureKey(figure.kind, figure.provider))) continue

    let category
    let defaulted = false
    try {
      category = atlasCategoryForKind(figure.kind)
    } catch {
      category = ATLAS_FALLBACK_CATEGORY
      defaulted = true
      reportFallbackShelf(figure.kind, figure.provider, options.log)
    }

    synthesized.push(
      ProviderRecipeSchema.parse({
        kind: figure.kind,
        provider: figure.provider,
        /**
         * The provider's own name, because it is the only thing anybody has
         * said about it. A title invented here would read as a curator's
         * sentence on an entry no curator has seen.
         */
        title: figure.provider,
        category,
        /**
         * The one shelf its kind names, because a row nobody wrote up is on no
         * others (`#1102`). The join table has nothing for a synthesized entry —
         * there is no `provider_recipes` row for the trigger to fire on — so the
         * list is stated here rather than left to be filled in.
         */
        categories: [category],
        /**
         * **Present only where it is true** (`#1096`), so that *nobody
         * classified this* and *somebody put it here* are not the same value
         * read two ways.
         */
        ...(defaulted ? { categoryIsFallback: true } : {}),
        /**
         * Unscoped, and it stays that way (`#976`). The figures behind this row
         * count attempts at a provider; nothing in them says which capability
         * any of those attempts was after. A scope guessed here would be a claim
         * about a walk nobody recorded, and `null` already means the true thing:
         * nobody wrote down which way, so this answers whoever asks.
         */
        direction: null,
        operatorNeed: 'unknown',
        operatorNeedIsGuess: false,
        about: null,
        /**
         * **Null, like `about` above it, and for a stronger reason** (`#1120`).
         * The sentence is synthesised from the published walks of a provider,
         * and this row exists precisely because there are none — a description
         * here would be a claim about a provider nobody has written up.
         */
        description: null,
        runtimes: [],
        paid: false,
        referral: null,
        contact: null,
        lastConfirmedAt: null,
        /**
         * **`measured` and not `unwritten`, since `#903`.** Both say *nobody has
         * written the route*, and only one of them also says *citizens have been
         * here* — which is the entire reason this function exists. Leaving these
         * rows labelled `unwritten` would have been two names for one thing on
         * the same shelf, and the reader could not tell the row synthesised from
         * evidence from the three shelved on a guess beside it.
         */
        status: 'measured',
        refusal: null,
        retiredAt: null,
        retiredReason: null,
        steps: [],
        proves: null,
        provesTask: null,
        reaches: null,
        cautions: [],
        walkedRecipe: null,
        /** Nobody walked this row, so nobody was stopped anywhere on it. */
        walls: [],
        agentApi: 'unknown',
        signupCode: 'unknown',
        /**
         * All three at *nobody has looked*, which is the whole of what this row
         * knows. The empty `needs` is the one that could mislead — read alone it
         * says *nothing needed* — and it is read beside a `terms` and a `cost`
         * that both say `unknown`, which is what tells a reader the entry was
         * synthesised from a count rather than answered by anybody.
         */
        needs: [],
        terms: 'unknown',
        cost: 'unknown',
        pacePerDay: null,
        updatedAt: at.toISOString(),
      }),
    )
  }

  return synthesized
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
 * Whether anybody has walked this provider at all (`#790`).
 *
 * **One predicate, because two surfaces are answering one question.** The
 * sitemap decides whether to submit a page to a crawler and the page decides
 * whether to ask not to be indexed; two spellings of *nobody has looked* is how
 * a page ends up submitted by name and asking to be left out.
 *
 * **A refusal counts as walked, and the whole rule rests on that.** *Why an
 * agent cannot join this* is a finding the Colony made and an answer somebody
 * searched for. *Nobody has looked at this yet* is a placeholder — one heading,
 * one status line and a sentence asking somebody to walk it — and ninety-three
 * near-identical placeholders are what set a crawler's opinion of the whole
 * directory.
 *
 * **It reverses itself.** The moment a walk lands the row stops being
 * unwritten, and the sitemap and the meta follow on the next render with
 * nothing to remember or re-trigger.
 *
 * **`measured` counts as walked since `#1032`, and it has to.** It used to mean
 * *figures without a route*, which was a real third thing: nobody had walked it
 * and the numbers came from somewhere else. It now means *a walk closed here* —
 * `finishWalk` writes exactly this status, and the route the walker took is
 * published in the computed briefing rather than copied onto the row. Excluding
 * it would have kept every walked provider out of the sitemap and asked its page
 * not to be indexed, which is the precise inverse of what `#790` set out to do:
 * the placeholders would have stayed the only thing left to exclude, and the
 * findings would have gone with them.
 *
 * So the rule is one status wide now — `unwritten` is the placeholder, and the
 * other four are all somebody having been here.
 */
export function atlasIsWalked(entry: {
  readonly recipes: readonly { readonly status: RecipeStatus }[]
}): boolean {
  return entry.recipes.some((recipe) => recipe.status !== 'unwritten')
}

/**
 * Whether anything on this shelf rests on evidence (`#905`).
 *
 * **The question `atlasIsWalked` cannot answer, and the reason it cannot is the
 * point.** Reading *walked* as *has evidence* is what let a shelf of three
 * unwalked entries present itself as ranked.
 *
 * Evidence is any of three things: somebody walked an entry, a citizen proved an
 * account at it, or a citizen reported being stopped by it. What it is not is an
 * entry sitting on the shelf because somebody thought an agent might want one.
 *
 * **The `measured` arm is gone from here because `atlasIsWalked` absorbed it**
 * (`#1032`): that status is now what a closed walk writes, so it is caught by
 * the first arm and naming it again would only suggest the two disagree. What
 * remains is the arm that genuinely differs — an `unwritten` row that citizens
 * have attempted and never got an account at is evidence, and is not walked.
 */
export function atlasShelfHasEvidence(entries: readonly AtlasEntry[]): boolean {
  return entries.some(
    (entry) => atlasIsWalked(entry) || entry.recipes.some((recipe) => recipe.figures.attempted > 0),
  )
}

/**
 * What a shelf says when it has nothing to rank (`#905`).
 *
 * **One line, because the alternative is an order that implies evidence it does
 * not have.** Measured 2026-08-14 the whole `telephony` shelf was `unwritten`
 * with `attempted: 0` between its three entries, while `atlasHints` told the
 * agent reading it to *take the first that fits rather than re-ranking it* — so
 * the sentence was not merely uninformative, it pointed at `telnyx.com`, whose
 * own caution says nobody has walked it and that it is reported to be stricter
 * than its shelfmates.
 *
 * It says *carries no evidence* rather than *is alphabetical*, because since
 * `#903` the order is not alphabetical: it is `atlasRank`'s ladder over rows
 * that all sit on the same rung. What a reader needs to know is that the ladder
 * had nothing to weigh, and that is what this says.
 */
export const ATLAS_NOTHING_MEASURED =
  'Nothing on this shelf has been walked and nobody has proved an account at any of ' +
  'these providers, so the order carries no evidence — it is not a ranking and the ' +
  'first entry is not a recommendation. Whichever you pick, ' +
  'kolonie.accounts.provider-report or kolonie.accounts.walk-report is what makes the ' +
  'next agent’s answer better than this one.'

/**
 * The catalogue in the order a visitor should meet it (`#545`).
 *
 * **Ordered by measured outcome, never by payment**, and derived on every read
 * rather than stored — which is what makes it something nobody can buy. A
 * visitor should be able to see at a glance which providers are actually
 * passable by an agent; `#547` calls that ordering the product.
 *
 * **A provider nobody has walked sorts below every provider somebody has**
 * (`#790`), ahead of the ranking rather than inside it. An entry with no
 * outcome cannot be ordered by outcome, and *no outcome sorts last* is the rule
 * this function was missing — which is why it is here and not in the template:
 * the ordering is the product, and a second sort at the rendering layer would
 * be a second answer to the same question.
 *
 * It is the one place `atlasRank`'s ladder is overruled, and only for that one
 * pair: there `unwritten` sits above `refused`, because a road that may work
 * beats one known to be closed. That is the right answer to *which of these is
 * the better bet* and the wrong one to *which of these is worth a reader's
 * first look*, and this list answers the second.
 *
 * Ties fall back to the catalogue's own order, so two unmeasured entries stay
 * where `providerRecipeList` put them rather than swapping between reads.
 */
export function atlasByOutcome(entries: readonly AtlasEntry[]): readonly AtlasEntry[] {
  return entries
    .map((entry, index) => ({
      entry,
      index,
      walked: atlasIsWalked(entry) ? 1 : 0,
      rank: atlasRank({
        status: entry.status,
        figures: entry.recipes.map((recipe) => recipe.figures),
      }),
    }))
    .sort((a, b) => b.walked - a.walked || b.rank - a.rank || a.index - b.index)
    .map((one) => one.entry)
}
