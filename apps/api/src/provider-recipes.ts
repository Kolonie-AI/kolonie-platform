import {
  AccountKindSchema,
  AccountProviderSchema,
  ATLAS_ABSENCE_NEXT_MOVES,
  AtlasCategorySlugSchema,
  type AtlasCategoryRow,
  BOOTSTRAP_TEMPLATES,
  DIRECTIONAL_KINDS,
  RecipeDirectionSchema,
  directionScoped,
  atlasByOutcome,
  atlasConditionsSentences,
  atlasEntries,
  atlasShelfHasEvidence,
  atlasStateOf,
  atlasPromotionOf,
  atlasPromotionMark,
  atlasPromotionSentence,
  ATLAS_NOTHING_MEASURED,
  type Log,
  measuredOnlyRecipes,
  RecipeStatusSchema,
  bootstrapTemplate,
  credentialFinding,
  fillAsk,
  valuesReferencedBy,
  ATLAS_ANY_PROVED_PHRASE,
  atlasBandPhrase,
  atlasHealthPhrase,
  atlasSourcePhrase,
  atlasStopPhrase,
  throughRate,
  figureKey,
  recipeStatusIsOfferable,
  stepInstruction,
  operatorStepCount,
  postProofRouteNote,
  recipeWall,
  REFUSAL_UNSTATED,
  wallsMatch,
  atlasConditionsMatch,
  atlasHasDescription,
  atlasMatchesQuery,
  atlasPageOf,
  decodeAtlasCursor,
  invalidAtlasCondition,
  ATLAS_QUERY_MAX_LENGTH,
  type AtlasPage,
  earnFacetsMatch,
  earnFacetsOf,
  tagCautionsOf,
  utilityFacetsOf,
  EarnFacetSchema,
  EARN_FACETS,
  type EarnFacet,
  WallKindSchema,
  WALL_KINDS,
  WALL_KIND_MEANINGS,
  type WallKind,
  type AtlasWalked,
  type AccountKind,
  type AccountProofMethod,
  type ApiError,
  type AtlasAudience,
  type BootstrapTemplate,
  type AtlasEntry,
  type AtlasFigures,
  type AtlasState,
  type EntryProposal,
  type ProposalAction,
  type ProposalWithDemand,
  type ProviderBriefing,
  type ServedWalkNote,
  type ServedOperateNote,
  type ServedWalkRoute,
  type ProviderRecipe,
  type RecipeDirection,
  type RecipeStep,
  walkedRecipeAsText,
} from '@kolonie-ai/core'
import type { Database } from '@kolonie-ai/db'
import { providerBriefingAsText } from './mcp/text/provider-briefing.js'
import { operateNotesAsText } from './mcp/text/operate-notes.js'
import { walkNotesAsText } from './mcp/text/walk-notes.js'
import { atlasReachAsText } from './mcp/text/atlas-reach.js'
import { walkRouteAsText } from './mcp/text/walk-route.js'
import type { WalkStore } from './account-walks.js'
import type { HeldAccount } from './accounts.js'
import {
  atlasFigures,
  atlasWalkers,
  decideProposal,
  decideProviderProposal,
  pendingProviderProposals,
  type DecideProposalOutcome,
  fallingSuccessRates,
  pendingProposals,
  providerBriefingsAt,
  publishedOperateNotesAt,
  publishedWalkNotesAt,
  publishedWalkRoutesAt,
  publishProviderRecipe,
  dressProviderRecipe,
  providerRecipe,
  atlasCategoryList,
  providerRecipeList,
  type FallingRate,
} from '@kolonie-ai/db'

/**
 * The provider catalogue, read (`#521`).
 *
 * **Read-only over the API, and that is the decision.** Writing an entry is
 * curation — deciding what the Colony tells every agent about somebody else's
 * product — and `#549` is the issue for where that happens. A write surface handed
 * to every citizen would make the catalogue the thing `provider-report` already is
 * and better: a register of what agents found, counted and moderated.
 */
export interface ProviderRecipes {
  list(kind?: AccountKind): Promise<readonly ProviderRecipe[]>
  one(kind: AccountKind, provider: string): Promise<ProviderRecipe | undefined>
  /**
   * What was measured about every recipe (`#545`).
   *
   * **On the catalogue rather than beside it**, because every surface that reads
   * an entry needs the figures with it: a page, a tool result and the data route
   * that showed a recipe without its measured outcome would be the link
   * collection the Atlas exists not to be.
   */
  figures(options?: {
    readonly audience?: AtlasAudience
    /** The provider a `provider` audience is entitled to — *who is reading*. */
    readonly entitledTo?: string
    /** Compute for this provider alone — *what to compute* (`#1627`). */
    readonly only?: string
    /** Which capability the reader came for, on the kinds with two (`#990`). */
    readonly direction?: RecipeDirection
  }): Promise<readonly AtlasFigures[]>
  /**
   * Every entry including the two states no stranger sees (`#604`).
   *
   * **A second method rather than a flag on `list`**, and that is the whole of
   * the safety here. `list` is what every public surface calls, and a boolean it
   * could be handed is a boolean somebody passes `true` to on the wrong call —
   * on `/atlas`, that publishes a stranger's unread suggestion about somebody
   * else's product. A separate name cannot be reached by accident, and every
   * caller of it is one grep away.
   */
  listInternal(): Promise<readonly ProviderRecipe[]>
  /**
   * The shelves themselves, out of `atlas_categories` (`#1102`).
   *
   * **On this port and not imported from `core`**, which is the whole of what
   * `#1102` bought. The taxonomy was a TypeScript enum, so a shelf was a release;
   * it is rows now, and a surface that renders the constant would be showing the
   * fifteen the enum was frozen with rather than what the Colony files things
   * under. The constant survives as what the migration seeded and what a test
   * compares this against.
   *
   * The only caller that *needs* it is the one that writes a category — the
   * maintainer's accept-a-proposal form, whose `<select>` decides what an entry
   * can be filed under. Everything that only reads builds its shelves from the
   * entries it is holding, and goes on doing so.
   */
  categories(): Promise<readonly AtlasCategoryRow[]>
  /**
   * What the Colony wrote up about one provider's walks (`#831`).
   *
   * **One provider and never the catalogue**, keyed like the figures so a surface
   * holding both looks them up the same way. The index shows no briefing, and a
   * read that walked four hundred providers to render none of them would be a
   * cost paid on the page that does not spend it — the same argument `#602` made
   * for reading the paying quests on the entry page only.
   */
  briefings(provider: string): Promise<ReadonlyMap<string, ProviderBriefing>>
  /**
   * What walkers wrote in their own words about one provider (`#1035`).
   *
   * **Bounded exactly as the briefings are, and keyed the same.** The argument is
   * the one `#831` made and nothing here weakens it: an agent reading the whole
   * catalogue is deciding where to go, and quoted notes from four hundred
   * providers is the cost that read must not pay.
   */
  notes(provider: string): Promise<ReadonlyMap<string, readonly ServedWalkNote[]>>
  /**
   * The route a walker wrote out at one provider, cleared and attributed
   * (`#1090`).
   *
   * **Bounded and keyed exactly as {@link ProviderRecipes.notes} is**, and for a
   * sharper version of the same reason: a route is a page rather than a
   * sentence, so the catalogue read is the last place it belongs.
   */
  routes(provider: string): Promise<ReadonlyMap<string, ServedWalkRoute>>
  /**
   * Post-account operate tips for one provider (`#1299`).
   *
   * **Bounded and keyed exactly as {@link ProviderRecipes.notes} is**, and kept
   * out of recipe `steps` on purpose: a tip about IMAP after signup is not how
   * the account was obtained.
   */
  operateNotes(provider: string): Promise<ReadonlyMap<string, readonly ServedOperateNote[]>>
  /**
   * Who walked each row in the catalogue, by `figureKey` (`#960`).
   *
   * **The whole catalogue rather than one provider, like the figures and unlike
   * the briefings.** The index renders every entry's provenance line, so a
   * per-provider read would be four hundred queries to draw one page. The
   * result is a handle per row and nothing else — no walk, no outcome, no id.
   */
  walkers(): Promise<ReadonlyMap<string, readonly string[]>>
  /** The review queue `#549` works through: proposals nobody has decided. */
  proposals(): Promise<readonly EntryProposal[]>
  /** The signal `#549` says will actually be used: rates that have fallen sharply. */
  fallingRates(): Promise<readonly FallingRate[]>
  /** Accept or refuse one, recorded against its author. */
  decide(id: string, status: 'accepted' | 'refused'): Promise<EntryProposal | undefined>
  /** The one queue three doors feed (`#600`): providers nobody has decided on, with the demand. */
  providerProposals(): Promise<readonly ProposalWithDemand[]>
  /** Accept, refuse with a reason, or merge into an entry that exists (`#600`). */
  decideProvider(id: string, action: ProposalAction): Promise<DecideProposalOutcome>
  /**
   * Refuse a measured entry, for a red line and nothing fixable (`#808`).
   *
   * **One verdict where there were two** (`#1032`). It took `published` too, for
   * a pass that judged drafts; there are no drafts and no pass, and the only way
   * an entry becomes `joinable` is somebody writing the route onto it, which is
   * {@link ProviderRecipes.dressEntry}.
   */
  refuseEntry(
    kind: AccountKind,
    provider: string,
    decision: { readonly verdict: 'refused'; readonly refusal: string },
  ): Promise<boolean>
  /**
   * Write the Colony's wording onto a measured entry, which publishes it
   * (`#857`, `#1032`).
   *
   * **The exception to *read-only over the API* above, and it is a narrow one.**
   * This is not a citizen writing an entry: it is reachable from the console
   * only, it touches a `measured` row and nothing else, and what it writes is the
   * route the Colony is prepared to stand behind.
   *
   * **It is the publishing act itself.** A walk writes a measured row with no
   * steps at all, and the table refuses steps on anything that is not joinable —
   * so there is no half-dressed state to leave behind and nothing left to decide
   * afterwards.
   */
  dressEntry(
    kind: AccountKind,
    provider: string,
    wording: {
      readonly steps: readonly RecipeStep[]
      readonly proves: AccountProofMethod
      readonly provesTask?: string | undefined
    },
  ): Promise<boolean>
}

export function databaseProviderRecipes(db: Database): ProviderRecipes {
  return {
    list: (kind) => providerRecipeList(db, kind),
    listInternal: () => providerRecipeList(db, undefined, { includeInternal: true }),
    categories: () => atlasCategoryList(db),
    one: (kind, provider) => providerRecipe(db, kind, provider),
    figures: (options) => atlasFigures(db, options ?? {}),
    briefings: (provider) => providerBriefingsAt(db, provider),
    notes: (provider) => publishedWalkNotesAt(db, provider),
    routes: (provider) => publishedWalkRoutesAt(db, provider),
    operateNotes: (provider) => publishedOperateNotesAt(db, provider),
    walkers: () => atlasWalkers(db),
    proposals: () => pendingProposals(db),
    fallingRates: () => fallingSuccessRates(db),
    decide: (id, status) => decideProposal(db, id, status),
    providerProposals: () => pendingProviderProposals(db),
    decideProvider: (id, action) => decideProviderProposal(db, id, action),
    refuseEntry: (kind, provider, decision) =>
      publishProviderRecipe(db, { kind, provider, ...decision }),
    dressEntry: (kind, provider, wording) =>
      dressProviderRecipe(db, { kind, provider, ...wording }),
  }
}

/**
 * The catalogue and its measurements, assembled into entries (`#545`, `#546`).
 *
 * **One call, so no surface can render a recipe without its figures.** The two
 * reads are independent and the grouping is `atlasEntries`'; what this adds is
 * that they always happen together, which is the property `#545` needs — a page
 * showing a recipe and omitting how many got through is the catalogue pretending
 * to be a curated list.
 *
 * **It is also the one place a measured-only provider joins the shelf** (`#856`).
 * The synthesis happens here rather than in each caller because the page, the
 * tool and the data route are three renderings of one catalogue, and a provider
 * that appeared on one of them and not the others would be exactly the
 * disagreement `atlasEntries` was moved out of SQL to prevent.
 */
export async function atlasCatalogue(
  recipes: ProviderRecipes,
  options: {
    readonly audience?: AtlasAudience
    readonly ordered?: boolean
    /**
     * Which capability the reader came for, on the kinds with two (`#976`).
     *
     * **Applied here rather than on the way out, so the ordering sees the scoped
     * verdict.** A refusal measured against sending is not evidence about
     * receiving, and an entry that had been rewritten to `unwritten` for this
     * reader but sorted as a refusal would sit at the bottom of the shelf
     * carrying a verdict the reader was just told does not apply to it.
     */
    readonly direction?: RecipeDirection
    /**
     * Where a defaulted shelf is reported (`#1096`).
     *
     * **Optional, because most callers of this are reads with nothing to write
     * to.** The pair is reported once per process by whichever caller has a log,
     * and the website route does — which is the surface the missing entries were
     * missing from.
     */
    readonly log?: Log
    /**
     * Assemble one provider's entry and nothing else (`#1627`).
     *
     * **A narrowing and not a filter**, which is the distinction that makes it
     * safe: nothing in this assembly reads across entries. `atlasEntries` groups
     * per provider, `measuredOnlyRecipes` synthesises per figure, `atlasStateOf`
     * looks its own provider up, and the counts underneath are keyed on the
     * row's own `(kind, provider)`. So the entry this returns is the entry the
     * whole catalogue would have contained.
     *
     * **What it is therefore not for: any caller that reads the catalogue
     * *around* an entry.** The Atlas provider page is the one that looks like it
     * should use this and must not — its neighbours block orders by measured
     * outcome (`atlasByOutcome` reads `recipes[].figures`), so three narrowed
     * entries cannot be sorted against a corpus that was never computed. Left
     * whole deliberately, and made cheap by the cache in `#1629` rather than by
     * a quieter answer here.
     *
     * **`ordered` becomes meaningless** — one entry sorts to itself — and is
     * left alone rather than refused, so a caller can narrow an existing call
     * without also having to reason about it.
     */
    readonly only?: string
  } = {},
): Promise<readonly AtlasEntry[]> {
  /**
   * **The figures are scoped with the entries and not after them** (`#990`
   * point 1).
   *
   * `#976` scoped the verdict and left the counts summed, which held only while
   * nothing carried a direction: the moment citizens started scoping their own
   * reports, a row reading *eight attempts, six failed* stopped saying which
   * eight. A reader asking for `inbound` was then shown an entry rewritten to
   * `unwritten` for them, sitting under a rate computed from outbound refusals
   * — and `atlasBand` reads those counts, so the shelf ordering read them too.
   */
  const [listed, measured, walkers] = await Promise.all([
    recipes.list(),
    recipes.figures({
      ...(options.audience === undefined ? {} : { audience: options.audience }),
      ...(options.direction === undefined ? {} : { direction: options.direction }),
      ...(options.only === undefined ? {} : { only: options.only }),
    }),
    recipes.walkers(),
  ])

  /**
   * **The list is narrowed here and the figures are narrowed in the query**
   * (`#1627`), and the asymmetry is deliberate.
   *
   * `providerRecipeList` is one flat select of a few hundred rows and was never
   * what a provider page waited on; `atlasFigures` is the 644-line statement
   * that was caught active in forty-four of sixty samples of a single page load.
   * Pushing a `where` into the cheap half as well would be a second surface to
   * keep in step for no measured gain, and `list` has no provider argument to
   * push it through.
   *
   * `walkers` is left whole for the same reason — one `select distinct` over the
   * walks, which is what every other Atlas surface already pays.
   */
  const wanted = options.only
  const scoped = wanted === undefined ? listed : listed.filter((one) => one.provider === wanted)

  const rows = scoped.map((recipe) => directionScoped(recipe, recipe.direction, options.direction))

  const synthesized = measuredOnlyRecipes(
    rows,
    measured,
    new Date(),
    options.log === undefined ? {} : { log: options.log },
  )

  const entries = atlasEntries(
    [...rows, ...synthesized],
    new Map(measured.map((one) => [figureKey(one.kind, one.provider), one])),
    new Set(synthesized.map((one) => figureKey(one.kind, one.provider))),
    walkers,
  )

  return options.ordered === false ? entries : atlasByOutcome(entries)
}

/**
 * {@link atlasStateOf} for a caller that has no catalogue of its own (`#936`).
 *
 * The console page holds the whole catalogue already, for its wish table, and
 * calls the pure function directly. A thread read has nothing in hand and this
 * is its way in.
 */
export async function atlasStateAt(
  recipes: ProviderRecipes,
  provider: string,
  kind?: string,
): Promise<AtlasState> {
  /**
   * **Narrowed, because this call has always wanted exactly one entry**
   * (`#1627`). `atlasStateOf` finds its provider and drops the rest, so the
   * catalogue around it was assembled to be thrown away — on every account page
   * and every thread read, at the cost of the whole Atlas.
   *
   * Unlike the Atlas provider page, nothing here is ordered against the corpus:
   * this answers *what is this provider* and never *what is near it*.
   */
  return atlasStateOf(
    await atlasCatalogue(recipes, { ordered: false, only: provider.trim().toLowerCase() }),
    provider,
    kind,
  )
}

export type RecipeOutcome<T> =
  | { readonly outcome: 'ok'; readonly response: T }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

/**
 * The filters `GET /v1/accounts/recipes` understands (`#984`).
 *
 * **A closed list, because the rejection below is what makes the other three
 * trustworthy.** Until `#984` the route read `kind` and dropped everything else
 * without a word, so `?status=refused` came back as the whole catalogue — which
 * is indistinguishable from a catalogue in which every provider is refused, and
 * any count derived from it is wrong in a direction the caller cannot detect.
 * A filter that is not here is refused by name rather than ignored.
 */
const RECIPE_QUERY_FILTERS = [
  'kind',
  'category',
  'status',
  'provider',
  'withWalls',
  'excludeWalls',
  'withEarn',
  'excludeEarn',
  /**
   * The four `#1302` adds, on this route because the two surfaces onto one
   * catalogue must not come to disagree about which vocabulary is valid — which
   * is the disagreement `#984` was filed about, and the reason this list is
   * closed at all.
   */
  'q',
  'cost',
  'hasDescription',
] as const

/**
 * The two that take a list rather than a value (`#981`).
 *
 * **Comma-separated, and repeated parameters too.** `?withWalls=a,b` is what a
 * shell caller writes and `?withWalls=a&withWalls=b` is what a client library
 * emits; refusing either would be refusing the question over spelling. The scalar
 * loop below skips these two, because *given more than once* is a mistake there
 * and the ordinary case here.
 */
const RECIPE_WALL_FILTERS = ['withWalls', 'excludeWalls'] as const

/**
 * The two earn-facet filters, spelled however the caller writes a list
 * (`#1301`).
 *
 * **A second pair beside the walls rather than one generic list reader**, because
 * the two vocabularies are different closed lists and a caller that misspelled a
 * facet should be told which list it missed. They are read by the same loop and
 * refused by the same shape of message, which is what keeps the two surfaces
 * agreeing.
 */
const RECIPE_EARN_FILTERS = ['withEarn', 'excludeEarn'] as const

/**
 * The signup-condition filter, read as a list for the same reason (`#1302`).
 *
 * **A list rather than a value, on a closed enum of four.** *Free or
 * card-to-sign-up* is one question an agent without a card asks, and a scalar
 * would make it two requests it then has to merge — which is the arithmetic the
 * catalogue exists to do.
 *
 * **`terms` is deliberately not beside it.** `#815` says that field drives a
 * sentence on the entry and nothing else — *no gate, no hiding, no refusal* —
 * and a filter hides entries. {@link invalidAtlasCondition} still knows the
 * vocabulary, so adding one later is a line here and a decision somewhere else.
 */
const RECIPE_CONDITION_FILTERS = ['cost'] as const

function invalidKind(kind: string): ApiError | null {
  return AccountKindSchema.safeParse(kind).success
    ? null
    : {
        code: 'validation_failed',
        message:
          'A kind is a lowercase kebab-case slug — "mailbox", "github", "trello". Leave it out ' +
          'to read the whole catalogue.',
      }
}

/**
 * **The shape and not the vocabulary, since `#1102`.** The shelves are rows in
 * `atlas_categories` now rather than a frozen list in this process, so a filter
 * that refused everything it was not compiled with would refuse a shelf a
 * maintainer added this morning — and would keep refusing it until the next
 * release, which is the whole thing `#1102` set out to stop.
 *
 * What is left to reject is the shape: a filter is a slug, and `Mailbox ` or
 * `mailbox; drop` is a typo worth naming rather than a shelf that is empty. A
 * well-formed slug nothing is filed under answers with nothing, which is the
 * same answer `/atlas?category=` gives and the same one the console's picker
 * gives — three surfaces onto one catalogue, agreeing.
 */
function invalidCategory(category: string): ApiError | null {
  return AtlasCategorySlugSchema.safeParse(category).success
    ? null
    : {
        code: 'validation_failed',
        message:
          'A category is a lowercase kebab-case slug — "mailbox", "code-hosting", ' +
          '"payments-finance". The shelves themselves are in the catalogue: leave this out to ' +
          'read all of them, and a shelf nothing is filed under answers with nothing.',
      }
}

function invalidStatus(status: string): ApiError | null {
  return RecipeStatusSchema.safeParse(status).success
    ? null
    : {
        code: 'validation_failed',
        message:
          'That is not a state a catalogue entry is in. They are: ' +
          `${RecipeStatusSchema.options.join(', ')}. Leave it out to see the shelf as it is — ` +
          'the refusals and the unwalked entries are findings too.',
      }
}

/**
 * One wall kind, or the rejection naming it (`#981`).
 *
 * **The enum only, on both surfaces.** A wall kind is a closed list precisely so
 * that a count over it means something; a caller that misspells one and is
 * answered with the unfiltered catalogue would read *no provider has this wall*
 * off a query that never ran.
 */
function invalidWallKind(kind: string): ApiError | null {
  return WallKindSchema.safeParse(kind).success
    ? null
    : {
        code: 'validation_failed',
        message:
          `That is not a wall the Atlas records: ${kind}. They are: ${WALL_KINDS.join(', ')}. ` +
          'The list is closed so that a count over it is a count — a wall spelled a second way ' +
          'is a wall nobody finds.',
      }
}

/**
 * Read one wall filter off a query, however the caller spelled the list.
 *
 * Returns the kinds, or the rejection. An empty result and an absent filter are
 * the same thing here, which is what `wallsMatch` already assumes.
 */
function wallKindsFrom(
  name: string,
  value: unknown,
): { readonly kinds: readonly WallKind[] } | { readonly error: ApiError } {
  const read = listFrom(name, value, 'wall kinds')
  if ('error' in read) return { error: read.error }

  for (const kind of read.parts) {
    const rejection = invalidWallKind(kind)
    if (rejection !== null) return { error: rejection }
  }

  return { kinds: read.parts.map((kind) => WallKindSchema.parse(kind)) }
}

/**
 * One earn facet, or the rejection naming it (`#1301`).
 *
 * **The enum only, exactly as a wall kind is.** The earn axis exists so that
 * *how many providers pay a referral* is a number; a caller that misspells one
 * and is answered with the unfiltered catalogue would read *none of them* off a
 * query that never ran.
 */
function invalidEarnFacet(facet: string): ApiError | null {
  return EarnFacetSchema.safeParse(facet).success
    ? null
    : {
        code: 'validation_failed',
        message:
          `That is not an earn facet the Atlas records: ${facet}. They are: ` +
          `${EARN_FACETS.join(', ')}. The list is closed so that a count over it is a count — ` +
          'a facet spelled a second way is an earn rail nobody finds.',
      }
}

/** Read one earn filter off a query, through the same reader the walls use. */
function earnFacetsFrom(
  name: string,
  value: unknown,
): { readonly facets: readonly EarnFacet[] } | { readonly error: ApiError } {
  const read = listFrom(name, value, 'earn facets')
  if ('error' in read) return { error: read.error }

  for (const facet of read.parts) {
    const rejection = invalidEarnFacet(facet)
    if (rejection !== null) return { error: rejection }
  }

  return { facets: read.parts.map((facet) => EarnFacetSchema.parse(facet)) }
}

/**
 * A list argument, however the caller spelled it (`#981`, generalised by
 * `#1301`).
 *
 * **Comma-separated, and repeated parameters too.** `?withWalls=a,b` is what a
 * shell caller writes and `?withWalls=a&withWalls=b` is what a client library
 * emits; refusing either would be refusing the question over spelling. Shared by
 * both closed vocabularies because the spelling rule is about the query string
 * and not about what the words mean.
 */
function listFrom(
  name: string,
  value: unknown,
  what: string,
): { readonly parts: readonly string[] } | { readonly error: ApiError } {
  const raw: unknown[] = Array.isArray(value) ? value : [value]
  const parts: string[] = []

  for (const one of raw) {
    if (typeof one !== 'string') {
      return {
        error: {
          code: 'validation_failed',
          message: `${name} is a list of ${what}, and that is not one of them.`,
        },
      }
    }

    parts.push(...one.split(',').map((part) => part.trim()))
  }

  return { parts: parts.filter((part) => part.length > 0) }
}

/**
 * The catalogue over HTTP, filtered on the same vocabulary the tool uses
 * (`#521`, `#984`).
 *
 * **The whole query is read here rather than four named arguments**, because
 * what the route was getting wrong was not any one filter — it was that a
 * parameter nobody implemented looked exactly like one that worked. Handing the
 * raw query in is what lets a name outside the closed list be answered rather
 * than dropped.
 *
 * **`provider` is matched and never validated.** A provider is not a closed
 * list, so an unknown one is a legitimate question with an empty answer; the
 * three above are closed lists, where a typo is a caller mistake and saying so
 * costs it one second instead of a wrong count.
 */
export async function readRecipes(
  query: Readonly<Record<string, unknown>>,
  recipes: ProviderRecipes,
): Promise<RecipeOutcome<{ readonly recipes: readonly ProviderRecipe[] }>> {
  const unknown = Object.keys(query).filter(
    (name) => !(RECIPE_QUERY_FILTERS as readonly string[]).includes(name),
  )

  if (unknown.length > 0) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message:
          `This route does not understand ${unknown.join(', ')}. It filters on ` +
          `${RECIPE_QUERY_FILTERS.join(', ')}, and it says so rather than answering the whole ` +
          'catalogue — a filter that is silently dropped is a count that is wrong in a ' +
          'direction you cannot see.',
      },
    }
  }

  const given: Partial<Record<(typeof RECIPE_QUERY_FILTERS)[number], string>> = {}

  for (const name of RECIPE_QUERY_FILTERS) {
    const value = query[name]
    if (value === undefined) continue
    if ((RECIPE_WALL_FILTERS as readonly string[]).includes(name)) continue
    if ((RECIPE_EARN_FILTERS as readonly string[]).includes(name)) continue
    if ((RECIPE_CONDITION_FILTERS as readonly string[]).includes(name)) continue

    if (typeof value !== 'string') {
      return {
        outcome: 'rejected',
        error: {
          code: 'validation_failed',
          message: `${name} is one value, and it was given more than once.`,
        },
      }
    }

    given[name] = value
  }

  const rejection =
    (given.kind === undefined ? null : invalidKind(given.kind)) ??
    (given.category === undefined ? null : invalidCategory(given.category)) ??
    (given.status === undefined ? null : invalidStatus(given.status))

  if (rejection !== null) return { outcome: 'rejected', error: rejection }

  const walls: { withWalls?: readonly WallKind[]; excludeWalls?: readonly WallKind[] } = {}

  for (const name of RECIPE_WALL_FILTERS) {
    const value = query[name]
    if (value === undefined) continue

    const read = wallKindsFrom(name, value)
    if ('error' in read) return { outcome: 'rejected', error: read.error }

    walls[name] = read.kinds
  }

  const earn: { withEarn?: readonly EarnFacet[]; excludeEarn?: readonly EarnFacet[] } = {}

  for (const name of RECIPE_EARN_FILTERS) {
    const value = query[name]
    if (value === undefined) continue

    const read = earnFacetsFrom(name, value)
    if ('error' in read) return { outcome: 'rejected', error: read.error }

    earn[name] = read.facets
  }

  /**
   * The signup conditions, through the same list reader and refused by the same
   * helper the tool calls (`#1302`).
   */
  const conditions: { cost?: readonly string[] } = {}

  for (const name of RECIPE_CONDITION_FILTERS) {
    const value = query[name]
    if (value === undefined) continue

    const read = listFrom(name, value, `${name} values`)
    if ('error' in read) return { outcome: 'rejected', error: read.error }

    const rejection = invalidAtlasCondition(name, read.parts)
    if (rejection !== null) return { outcome: 'rejected', error: rejection }

    conditions[name] = read.parts
  }

  if (given.q !== undefined && given.q.trim().length > ATLAS_QUERY_MAX_LENGTH) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message:
          `A query is a name, a title or a sentence — ${ATLAS_QUERY_MAX_LENGTH} characters at ` +
          'most.',
      },
    }
  }

  /**
   * **A query-string boolean is a word, and only two words are it.** Anything
   * else is refused rather than read as `false`, which is the rule the closed
   * filter list above rests on: a filter nobody implemented must not look like
   * one that worked.
   */
  if (given.hasDescription !== undefined && !['true', 'false'].includes(given.hasDescription)) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message:
          'hasDescription is true or false. `true` is the entries that say what the provider ' +
          'is; `false` is the ones still missing a sentence, which is where the work is.',
      },
    }
  }

  const hasDescription =
    given.hasDescription === undefined ? undefined : given.hasDescription === 'true'

  const listed = await recipes.list(
    given.kind === undefined ? undefined : AccountKindSchema.parse(given.kind),
  )

  const provider = given.provider?.toLowerCase()

  return {
    outcome: 'ok',
    response: {
      recipes: listed
        .filter((recipe) => given.category === undefined || recipe.category === given.category)
        .filter((recipe) => given.status === undefined || recipe.status === given.status)
        .filter((recipe) => provider === undefined || recipe.provider === provider)
        /** The same predicate the tool filters on, from `core` (`#981`). */
        .filter((recipe) => wallsMatch(recipe.walls, walls))
        /**
         * The earn axis, per recipe and beside the walls (`#1301`).
         *
         * **`category` above and this are the two axes, and they compose.**
         * `?category=mailbox&withEarn=affiliate-referral` is the dual-use
         * question asked in one request, which is the thing neither taxonomy
         * could answer alone.
         */
        .filter((recipe) => earnFacetsMatch(recipe.facets, earn))
        /**
         * The three `#1302` adds, on the rows this route serves.
         *
         * **The query matches the row's own identity and not the entry's.** This
         * route answers rows rather than providers, so the sentence a reader
         * matched against is the one it will be handed back — where the tool,
         * which answers entries, matches the rolled-up description instead.
         */
        .filter((recipe) => atlasConditionsMatch(recipe, conditions))
        .filter((recipe) => atlasMatchesQuery(recipe, given.q))
        .filter(
          (recipe) =>
            hasDescription === undefined || atlasHasDescription(recipe) === hasDescription,
        ),
    },
  }
}

/**
 * The Atlas as an agent reads it (`#550`).
 *
 * **The existing namespace, and no `kolonie.atlas.*`.** `#382`–`#388` are
 * shrinking the MCP surface deliberately, and the reason is stated where the
 * reachability tool argues for its own existence: *the cost of a tool is what
 * every citizen carries in every session*. A second namespace for a register
 * that already has one is a cost paid by every citizen on every waking, to
 * rename something. *Atlas* is the name used with people — the website, a
 * conversation with a provider — and the tools keep the name they have.
 *
 * **This adds no tool at all**, which is stronger than adding one under the old
 * prefix: `kolonie.accounts.recipes` gained two optional arguments and its
 * result gained the figures. The surface is the same size it was.
 */
export async function readAtlas(
  input: {
    readonly kind?: string | undefined
    /** One provider in full, rather than the catalogue. */
    readonly provider?: string | undefined
    /**
     * Drop the kinds this agent already holds (`#523`).
     *
     * **Off unless asked for**, because a catalogue is also read to find out
     * whether a better provider exists for something you already have — and a
     * filter that hid those by default would answer a different question than
     * the one most agents are asking.
     */
    readonly held?: ReadonlySet<string> | undefined
    /**
     * One shelf of the catalogue (`#589`).
     *
     * **The agent's own question, which until now could only be answered by
     * fetching everything and reading the steps**: *which accounts can I get
     * here, and which of them need my operator?* Filtered on the entry's
     * category rather than each row's, so a provider stays one entry — the same
     * reason the index groups by one shelf per provider.
     */
    readonly category?: string | undefined
    /**
     * Only providers at least this many citizens got an account at (`#855`).
     *
     * **The one filter that reads the measurement rather than the catalogue.**
     * An agent that has already lost an afternoon to a provider nobody has
     * finished is asking *show me only the ones that demonstrably work*, and
     * before this it could only ask that by reading every entry's figures itself
     * and re-deciding what the ordering had already decided.
     *
     * A suppressed figure never satisfies it: below the aggregate floor the
     * Colony does not publish the count, and a filter that let a caller probe
     * for it would publish it one question at a time.
     */
    readonly minProved?: number | undefined
    /**
     * Only entries in this state (`#855`).
     *
     * **`joinable` is what most callers mean and it is not the default**, on the
     * same argument the whole catalogue rests on: an agent that can hide the
     * refusals and the dead ends has turned the Atlas back into the link
     * collection it exists not to be. Asking for them is a choice a caller makes
     * knowing what it is hiding.
     */
    readonly status?: string | undefined
    /**
     * Which capability the reader needs, where the kind has two (`#976`).
     *
     * **Not a filter, and that is the difference between this and every argument
     * above it.** The others drop entries; this one re-reads the verdicts. A
     * provider refused for sending comes back as `unwritten` to a reader asking
     * about receiving — still on the shelf, because an unwalked entry is where
     * the next walk comes from, and no longer carrying a refusal measured
     * against something the reader did not ask for.
     */
    readonly direction?: string | undefined
    /**
     * What stopped other walkers, as a filter (`#981`).
     *
     * **The question the catalogue exists to answer.** *What can I walk today,
     * alone, with what I have* is `excludeWalls` — drop the providers whose wall
     * is a card, a phone number or a check I cannot clear — and it was
     * unanswerable at any price while the walls were prose. `withWalls` is the
     * other direction, and it is what a citizen with a card, or an operator, reads
     * to find the work only it can do.
     */
    readonly withWalls?: readonly string[] | undefined
    readonly excludeWalls?: readonly string[] | undefined
    /**
     * Which earn facets the reader is after, and which it is not (`#1301`).
     *
     * **A second axis and not a second shelf.** `category` narrows *what sort of
     * account this is*; this narrows *how it pays*, and the two compose rather
     * than competing — `category: 'mailbox'` beside
     * `withEarn: ['affiliate-referral']` is the dual-use question, and it is the
     * one the catalogue could not be asked before.
     *
     * **Per recipe and never per provider**, exactly as the walls are: a
     * provider's shelf may carry a mailbox that earns nothing and an API that
     * pays a referral, and answering with the provider would hide which row the
     * reader can act on.
     */
    readonly withEarn?: readonly string[] | undefined
    readonly excludeEarn?: readonly string[] | undefined
    /**
     * The catalogue as something you can look a provider up in (`#1302`).
     *
     * **A substring over identity and never a ranked search.** Provider, title
     * and description; no scoring, because a relevance order laid over
     * `atlasByOutcome` would be a second ordering — and the first entry that
     * ranked above another for repeating a word would undo the one guarantee
     * `#855` makes about position.
     */
    readonly q?: string | undefined
    /**
     * Where the money is required, per row (`#1302`).
     *
     * **Readable since `#815` and filterable by nobody until now.** An agent
     * with no card had to fetch the shelf and re-derive *which of these can I
     * actually pay for*, which is the read the catalogue exists to save.
     *
     * **No `terms` beside it**, because `#815` says that field hides nothing.
     */
    readonly cost?: readonly string[] | undefined
    /**
     * Only entries that say what the provider is, or only the ones that do not
     * (`#1302`).
     *
     * **Both directions, because they are two jobs.** `true` is a reader
     * choosing; `false` is a scout finding the entries `#1297` left a sentence
     * missing on.
     */
    readonly hasDescription?: boolean | undefined
    /**
     * One page of the catalogue rather than all of it (`#1302`).
     *
     * **Clamped and never refused**, exactly as the walks page is: the ceiling
     * is a property of the response, and refusing would only make every caller
     * learn the number by being refused once.
     */
    readonly limit?: number | undefined
    readonly cursor?: string | undefined
  },
  recipes: ProviderRecipes,
  /**
   * Whether this deployment can carry a secret from an operator (`#566`).
   *
   * **A parameter rather than something read here**, because it is deployment
   * configuration — `OPERATOR_DROP_SEALING_KEY`, absent rather than fatal — and
   * the catalogue is a read over stored rows that knows nothing about the
   * process it is running in.
   */
  secretHandoff: boolean,
): Promise<
  RecipeOutcome<{
    readonly entries: readonly AtlasEntry[]
    readonly secretHandoff: boolean
    /** What the Colony wrote up, by `figureKey`. Empty unless one provider was named. */
    readonly briefings: ReadonlyMap<string, ProviderBriefing>
    /** What walkers wrote themselves, by `figureKey`, under the same bound (`#1035`). */
    readonly notes: ReadonlyMap<string, readonly ServedWalkNote[]>
    /** The newest cleared route per pair, under the same bound again (`#1090`). */
    readonly routes: ReadonlyMap<string, ServedWalkRoute>
    /** Post-account tips per pair, under the same bound (`#1299`). */
    readonly operateNotes: ReadonlyMap<string, readonly ServedOperateNote[]>
    /**
     * Said out loud when nothing in this answer rests on evidence (`#905`),
     * `null` when something does.
     *
     * **A field rather than a thing the caller works out**, which is the whole
     * acceptance criterion: a reader should not have to notice that every entry
     * says `attempted: 0` and draw the conclusion itself. An order that implies
     * evidence it does not have is worse than no order.
     */
    readonly nothingMeasured: string | null
    /**
     * Where the next page of the catalogue starts, and how many entries matched
     * across all of them (`#1302`).
     *
     * **`null` on the last page rather than absent**, so a caller loops on a
     * value it reads rather than on a key it tests for.
     */
    readonly nextCursor: string | null
    readonly total: number
  }>
> {
  /**
   * The same three rejections the data route gives, from the same functions
   * (`#984`). Two surfaces onto one catalogue that disagreed about which
   * vocabulary is valid would be the disagreement `#984` was filed about,
   * arriving from the other side.
   */
  const vocabulary =
    (input.kind === undefined ? null : invalidKind(input.kind)) ??
    (input.category === undefined ? null : invalidCategory(input.category)) ??
    (input.status === undefined ? null : invalidStatus(input.status))

  if (vocabulary !== null) return { outcome: 'rejected', error: vocabulary }

  /** Read through the same reader the route uses, so both refuse the same typo. */
  const walls: { withWalls?: readonly WallKind[]; excludeWalls?: readonly WallKind[] } = {}

  for (const name of RECIPE_WALL_FILTERS) {
    const value = input[name]
    if (value === undefined) continue

    const read = wallKindsFrom(name, [...value])
    if ('error' in read) return { outcome: 'rejected', error: read.error }

    walls[name] = read.kinds
  }

  /** Read through the same reader the route uses, so both refuse the same typo. */
  const earn: { withEarn?: readonly EarnFacet[]; excludeEarn?: readonly EarnFacet[] } = {}

  for (const name of RECIPE_EARN_FILTERS) {
    const value = input[name]
    if (value === undefined) continue

    const read = earnFacetsFrom(name, [...value])
    if ('error' in read) return { outcome: 'rejected', error: read.error }

    earn[name] = read.facets
  }

  if (input.direction !== undefined && !RecipeDirectionSchema.safeParse(input.direction).success) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message:
          'A direction is which capability you need: ' +
          `${RecipeDirectionSchema.options.join(', ')}. It means something on ` +
          `${DIRECTIONAL_KINDS.join(', ')} and nothing anywhere else, where every verdict ` +
          'answers whatever you asked. Leave it out to read the shelf as it stands.',
      },
    }
  }

  if (
    input.minProved !== undefined &&
    (!Number.isInteger(input.minProved) || input.minProved < 0)
  ) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message: 'minProved counts citizens, so it is a whole number and not a negative one.',
      },
    }
  }

  /**
   * The two condition filters, refused by name rather than dropped (`#1302`).
   *
   * Same rule as the walls and the shelves above, from the same helper both
   * surfaces call: a filter silently ignored is a count that is wrong in a
   * direction the caller cannot see.
   */
  const conditions = input.cost === undefined ? null : invalidAtlasCondition('cost', input.cost)

  if (conditions !== null) return { outcome: 'rejected', error: conditions }

  if (input.q !== undefined && input.q.trim().length > ATLAS_QUERY_MAX_LENGTH) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message:
          `A query is a name, a title or a sentence — ${ATLAS_QUERY_MAX_LENGTH} characters at ` +
          'most. It matches a provider, its title and the sentence saying what it is, and never ' +
          'the steps: a paragraph here is asking for a search this is not.',
      },
    }
  }

  /**
   * **Read before the catalogue, so a mangled cursor costs nothing.** The whole
   * shelf would otherwise be assembled and filtered to serve a request that
   * cannot be answered, exactly as the walks refusal argues one call up.
   */
  const cursor = input.cursor === undefined ? undefined : decodeAtlasCursor(input.cursor)

  if (cursor === 'invalid-cursor') {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message:
          'That cursor is not one of ours. Drop it to start at the first entry, or send back ' +
          'the `nextCursor` from your last page exactly as it was given.',
      },
    }
  }

  const all = await atlasCatalogue(
    recipes,
    input.direction === undefined
      ? {}
      : { direction: RecipeDirectionSchema.parse(input.direction) },
  )

  const entries = all
    .map((entry) => ({
      ...entry,
      recipes: entry.recipes
        .filter(
          (recipe) =>
            (input.kind === undefined || recipe.kind === input.kind) &&
            (input.held === undefined || !input.held.has(recipe.kind)) &&
            /**
             * **Per recipe and not per shelf** (`#981`). A provider's shelf may
             * carry a mailbox that anybody can open and a wallet that wants a
             * passport; dropping the whole provider because one of its accounts is
             * walled would hide the one the reader asked about.
             */
            wallsMatch(recipe.walls, walls) &&
            /**
             * **Per recipe, beside the walls and for the same reason** (`#1301`).
             * A provider's mailbox row may earn nothing while its API row pays a
             * referral; dropping the provider would hide the row the reader
             * asked for.
             */
            earnFacetsMatch(recipe.facets, earn) &&
            /**
             * **Per recipe, a third time and for the third time the same
             * reason** (`#1302`). A provider whose mailbox is free and whose API
             * is paid-only is two answers, and dropping the provider would lose
             * the row the reader can act on.
             */
            atlasConditionsMatch(recipe, input),
        )
        .map((recipe) => ({
          ...recipe,
          steps: recipe.steps.map((step) =>
            step.secret === true && !secretHandoff
              ? {
                  ...step,
                  ask:
                    'Do not ask your operator for this secret yet. This Colony has no sealed ' +
                    'channel configured, so there is nowhere for it to arrive.',
                }
              : step,
          ),
        })),
    }))
    .filter((entry) => entry.recipes.length > 0)
    .filter(
      (entry) => input.provider === undefined || entry.provider === input.provider.toLowerCase(),
    )
    .filter((entry) => input.category === undefined || entry.category === input.category)
    .filter((entry) => input.status === undefined || entry.status === input.status)
    .filter(
      (entry) =>
        input.minProved === undefined ||
        entry.recipes.reduce(
          (sum, recipe) => sum + (recipe.figures.suppressed ? 0 : recipe.figures.proved),
          0,
        ) >= input.minProved,
    )
    /**
     * The query, applied to the entry rather than to its rows (`#1302`).
     *
     * **After the row filters and not before them**, so `q: 'mail'` beside
     * `cost: ['free']` is *a provider whose name says mail and whose free row
     * survived* — which is what a reader asking both questions means, and what
     * asking them in the other order would not be.
     */
    .filter((entry) => atlasMatchesQuery(entry, input.q))
    .filter(
      (entry) =>
        input.hasDescription === undefined || atlasHasDescription(entry) === input.hasDescription,
    )

  /**
   * **Asked of the whole catalogue rather than of what survived the filters**
   * (`#855`). A caller naming a provider beside `minProved` or `status` is
   * asking two questions at once, and answering the second with *the Atlas has
   * never heard of it* would be a claim about the Colony's knowledge that the
   * filter, not the catalogue, made true.
   */
  const providerIsKnown =
    input.provider !== undefined &&
    all.some((entry) => entry.provider === input.provider?.toLowerCase())

  if (input.provider !== undefined && !providerIsKnown) {
    return {
      outcome: 'rejected',
      error: {
        code: 'not_found',
        message:
          'The Atlas has no entry for that provider. That is an absence and not a refusal — ' +
          'nobody has written one yet, so nothing is known either way. ' +
          ATLAS_ABSENCE_NEXT_MOVES,
      },
    }
  }

  /**
   * The write-ups, on the read that asked for one provider (`#831`).
   *
   * **Only there**, and the bound is what makes this affordable: an agent reading
   * the whole catalogue is deciding *where to go*, which the figures answer, and
   * carrying every provider's claims into that result would be hundreds of
   * paragraphs about providers it is not going to attempt. An agent that named
   * one provider has already decided, and is asking the question the briefing
   * answers.
   */
  const oneProvider = input.provider !== undefined && entries.length > 0

  const briefings = oneProvider
    ? await recipes.briefings(input.provider as string)
    : new Map<string, ProviderBriefing>()

  /** The quoted half, under the same bound and for the same reason (`#1035`). */
  const notes = oneProvider
    ? await recipes.notes(input.provider as string)
    : new Map<string, readonly ServedWalkNote[]>()

  /**
   * The walked route, under the same bound a third time (`#1090`).
   *
   * A route is the longest thing a walk leaves behind, so if anything belongs
   * behind the one-provider guard it is this: carrying a page of steps for every
   * provider into a catalogue read would cost more than the rest of the answer.
   */
  const routes = oneProvider
    ? await recipes.routes(input.provider as string)
    : new Map<string, ServedWalkRoute>()

  /** Post-account tips, under the same one-provider bound (`#1299`). */
  const operateNotes = oneProvider
    ? await recipes.operateNotes(input.provider as string)
    : new Map<string, readonly ServedOperateNote[]>()

  /**
   * **Asked of what is being returned, not of the whole catalogue.** A caller
   * that narrowed to one shelf is asking about that shelf, and answering from
   * the catalogue would tell it the Atlas has evidence somewhere else — which
   * is true and not what it asked.
   */
  const nothingMeasured = atlasShelfHasEvidence(entries) ? null : ATLAS_NOTHING_MEASURED

  /**
   * One page of what matched (`#1302`).
   *
   * **Last, so every sentence above it is about the shelf and not about the
   * page.** `nothingMeasured` answers *is there evidence behind what you asked
   * for*, and computing it from fifty of four hundred entries would make it a
   * fact about where the reader happens to be paging.
   */
  const page: AtlasPage<AtlasEntry> = atlasPageOf(entries, {
    limit: input.limit,
    ...(cursor === undefined ? {} : { cursor }),
  })

  return {
    outcome: 'ok',
    response: {
      entries: page.entries,
      secretHandoff,
      briefings,
      notes,
      routes,
      operateNotes,
      nothingMeasured,
      nextCursor: page.nextCursor,
      total: page.total,
    },
  }
}

/**
 * One Atlas entry, written for the agent deciding whether to spend its
 * operator's attention here.
 *
 * **The figures are the reason this is not `recipeAsText` with a header.** An
 * agent choosing between two providers should know that 12 % get through one and
 * 80 % through the other, and that is the whole of what `#545` measured. The
 * paid marker travels with the entry in the tool result exactly as it does on
 * the page — a marker shown to people and not to agents would be a disclosure
 * that stops where it becomes inconvenient.
 */
export function atlasEntryAsText(
  entry: AtlasEntry,
  secretHandoff: boolean,
  /**
   * What the Colony wrote up about each kind here, by `figureKey` (`#831`).
   *
   * **Defaulted to empty rather than required**, because the catalogue read does
   * not carry briefings and rendering an entry is the same job either way. An
   * absent briefing prints nothing: the figures beside it already say how many
   * walked, and a paragraph announcing that nobody has written it up yet is that
   * same absence stated twice.
   */
  briefings: ReadonlyMap<string, ProviderBriefing> = new Map(),
  /**
   * What walkers wrote in their own words, by `figureKey` (`#1035`). Defaulted
   * to empty on the same terms as the briefings, and printed under them: the
   * Colony's summary is the shorter and more general statement, and a reader who
   * stops after it has not missed a name it needed.
   */
  notes: ReadonlyMap<string, readonly ServedWalkNote[]> = new Map(),
  /**
   * The route a walker wrote out, by `figureKey` (`#1090`). Defaulted and
   * printed on the same terms as the notes, and last of the three: it is the
   * longest block and the most specific, so a reader that stopped at the
   * briefing has read the general statement and skipped only the detail.
   */
  routes: ReadonlyMap<string, ServedWalkRoute> = new Map(),
  /**
   * Post-account operate tips, by `figureKey` (`#1299`). Defaulted and printed
   * after the walk notes: tips about an account you already hold are useless
   * until you have one, so a reader still deciding whether to walk stops earlier.
   */
  operateNotes: ReadonlyMap<string, readonly ServedOperateNote[]> = new Map(),
  /**
   * Whether this entry is the answer to a one-provider read (`#1349`,
   * correcting `#1303`).
   *
   * **Default false, which is the catalogue**, so a caller that has not thought
   * about it gets the cheap rendering. The three maps above are already bounded
   * to one provider and default to empty for the same reason; this is the fourth
   * thing under that bound, and the first that is not a map — the promotion line
   * is derived rather than loaded, so its cost is prose and not a query, and
   * nothing about an empty map could have told the renderer which read it is on.
   */
  full = false,
  /**
   * The reader's own handle, so a handle on this page is never an invitation to
   * write to itself (`#1489`).
   *
   * **Optional, and absent is the safe direction.** A caller that does not know
   * who is reading — the public Atlas projection, a test — gets every handle
   * treated as somebody else's, which is what it is. The only thing knowing the
   * reader buys is the suppression, and suppressing nothing is worse prose
   * rather than a disclosure.
   */
  reader?: string,
): string {
  /**
   * **Provenance and health above the rows, because both are about the whole
   * entry** (`#856`, `#860`). An agent that reads three steps before being told
   * nobody has confirmed them since March has already spent the attention this
   * line exists to save; and one that reads a measured-only entry without being
   * told nobody wrote it would take an absence of steps for a short recipe.
   *
   * Both print nothing in their ordinary state, so an entry a maintainer wrote
   * and somebody confirmed last week reads exactly as it did before.
   */
  const parts = [
    `## ${entry.title} (${entry.provider})`,
    atlasHealthPhrase(entry.health),
    atlasSourcePhrase(entry.source, entry.walkers),
  ]

  if (entry.recipes.some((recipe) => recipe.paid)) {
    parts.push(
      '**This entry is paid for.** It buys the entry and nothing else — not its position, ' +
        'which is computed from what agents measured, and not the removal of a poor result.',
    )
  }

  parts.push(tagCautionAsText(entry))
  parts.push(earnFacetsAsText(entry))

  /**
   * **Three blocks per recipe, and the middle one is new** (`#1032`).
   *
   * `figuresAsText` counts *accounts* — who proved one, how fast, who still held
   * it a month later — and it counted them long before a walk could reach a
   * reader on its own. `walkedAsText` counts *walks*: who set out, who arrived,
   * on what runtime, and what stopped the rest. They are different populations
   * and neither substitutes for the other, which is why an agent choosing a
   * provider gets both. The briefing under them is the moderated prose, and it is
   * last because it is the longest.
   */
  for (const recipe of entry.recipes) {
    const key = figureKey(recipe.kind, recipe.provider)

    parts.push(
      recipeAsText(recipe, secretHandoff),
      walkedAsText(recipe.figures.walked),
      figuresAsText(recipe.figures),
      /**
       * Where this row stands on the way to being a route, and whose move is
       * next (`#1303`).
       *
       * **Under the figures and above the prose**, because it is the sentence
       * that decides whether the paragraphs below are worth reading: a citizen
       * told that the next move is a steward's does not need the briefing to
       * work out that there is nothing here for it to do.
       *
       * **The mark on a catalogue read and the whole sentence on one provider**
       * (`#1349`, correcting `#1303`). Measured after `#1303` merged: printing
       * the instruction on every row put 23 % of a fifty-entry page — 25,200 of
       * 108,088 characters — into one repeated paragraph. That is the cost
       * `#831` bounded when it kept the briefings off the catalogue read, and it
       * binds harder here, because a briefing at least differs per provider.
       * `full` is the same one-provider bound the briefing, the notes and the
       * walked route are already under.
       *
       * **`hasClearedRoute` is only true where the routes were actually
       * loaded** — a one-provider read (`#1090`). On a catalogue read the map is
       * empty for every key, and {@link atlasPromotionOf} is told nothing rather
       * than told `false`.
       */
      (full ? atlasPromotionSentence : atlasPromotionMark)(
        atlasPromotionOf(recipe, routes.size === 0 ? {} : { hasClearedRoute: routes.has(key) }),
      ),
      providerBriefingAsText(briefings.get(key)),
      walkNotesAsText(notes.get(key)),
      operateNotesAsText(operateNotes.get(key)),
      walkRouteAsText(routes.get(key)),
    )
  }

  /**
   * **A handle on this page is an address** (`#1489`).
   *
   * **Last, and once for the whole entry rather than once per row.** The
   * citizens it names are named in the blocks above — as walkers, as the author
   * of a note, as the author of the route — and this is the sentence saying that
   * those names can be written to and what about. Emitting it inside the loop
   * would produce one per kind at a provider carrying two, which is the
   * once-per-handle rule broken by the sentence written to keep it.
   *
   * It draws from every row's notes and route, so an entry whose only handle is
   * on its second kind still gets one.
   */
  parts.push(
    atlasReachAsText({
      walkers: entry.walkers,
      notes: entry.recipes.flatMap(
        (recipe) => notes.get(figureKey(recipe.kind, recipe.provider)) ?? [],
      ),
      route: entry.recipes
        .map((recipe) => routes.get(figureKey(recipe.kind, recipe.provider)))
        .find((one) => one !== undefined),
      reader,
      full,
    }),
  )

  return parts.filter((part) => part !== '').join('\n\n')
}

/**
 * What this provider pays for, where anything does (`#1301`).
 *
 * **Printed on the entry and not on each row**, because it is a fact about the
 * provider: an agent that came for the mailbox and would also take the referral
 * should not have to scroll to the row that happened to carry the facet.
 *
 * **Nothing at all when the earn axis is empty**, which is nearly every entry.
 * A line announcing that a provider pays nothing would be an absence stated as a
 * finding, on four hundred entries, and the Colony has looked at almost none of
 * them.
 *
 * **A shelf beside an earn facet is the dual-use case said out loud.** That is
 * the reader `#1301` exists for: the account is worth holding *and* it is a way
 * to earn, and until now the catalogue could only say one of the two.
 */
/**
 * The Colony's own position on a tag this entry carries, ahead of the walk
 * (`#1469`).
 *
 * **Printed above everything except what the entry *is*.** The whole cost of the
 * 2026-08-20 event was twelve full walk reports written for a shelf the Colony
 * had a view about and had written down nowhere — so this has to arrive before a
 * reader has decided to spend an afternoon, which means above the figures, above
 * the walks and above the briefing.
 *
 * **Once, at the tag.** The caution is a property of the category rather than of
 * any one provider, and twelve copies of it is twelve places for it to go stale.
 * `ATLAS_TAG_CAUTIONS` is the one place, and a decision record in
 * `state/decisions/` stands behind each row of it.
 *
 * **It never refuses anything.** A marked entry is an entry a citizen may walk,
 * hold and earn through — what changed is that they are told what it is first.
 */
function tagCautionAsText(entry: AtlasEntry): string {
  const cautions = tagCautionsOf(entry.facets)
  if (cautions.length === 0) return ''

  return cautions.map((caution) => `**Before you walk this:** ${caution}`).join('\n\n')
}

function earnFacetsAsText(entry: AtlasEntry): string {
  const earn = earnFacetsOf(entry.facets)
  if (earn.length === 0) return ''

  const shelf = utilityFacetsOf(entry.facets)
  const both =
    shelf.length === 0
      ? ''
      : ` It is also an account you would hold for its own sake — ${shelf.join(', ')} — so ` +
        'holding it and earning through it are not two decisions.'

  return `**How this provider pays:** ${earn.join(', ')}.${both}`
}

/**
 * What the walks add up to, for the agent deciding whether to be the next one
 * (`#1032`).
 *
 * **This is the half of the Atlas that used to need a person.** A walk reached a
 * reader only if a steward dressed it into an entry; eighteen of twenty walks
 * never did. Every closed walk is in this paragraph in the request that closed
 * it, and nobody decided that it should be.
 *
 * **Counts and kinds, never a sentence somebody wrote.** {@link AtlasWalked}
 * carries no free text at all — that is a property of the schema and not a rule
 * this renderer keeps — so there is no path from an unmoderated walk to this
 * string. The walker's own words arrive under it, in the briefing, once they have
 * been through the moderation every citizen report goes through.
 *
 * Silent where nothing closed: an entry nobody has walked prints no paragraph
 * about the nobody, because `figuresAsText` beneath it already says so once.
 */
export function walkedAsText(walked: AtlasWalked): string {
  if (walked.citizens === 0) {
    /**
     * **Walls without walkers is a real state and it is worth a line.** The
     * counts are floored and the wall kinds are not (`AtlasWalkedSchema` says
     * why), so a pair walked by one or two citizens publishes what stopped them
     * while `citizens` reads zero. Printing nothing there would lose the most
     * actionable thing the Colony knows about that provider.
     */
    return walked.walls.length === 0 ? '' : `**Walked:** ${wallsPhrase(walked.walls)}`
  }

  const through = `${walked.gotThrough} of ${walked.citizens} got through`
  const lines = [
    `${walked.citizens} citizen${walked.citizens === 1 ? '' : 's'} walked this and ${through}.`,
    walked.band === null ? '' : atlasBandPhrase(walked.band),
    platformsPhrase(walked.platforms),
    wallsPhrase(walked.walls),
  ].filter((line) => line !== '')

  return `**Walked:** ${lines.join(' ')}`
}

/**
 * Which runtimes walked it.
 *
 * **The reason this is printed to agents at all**: a wall that forty agents on
 * one runtime hit and nobody else did is a fact about that runtime, and the
 * reader is the only one who knows which runtime it is. `kolonie.tasks.reports`
 * makes the same breakdown available for the same reason.
 */
function platformsPhrase(platforms: AtlasWalked['platforms']): string {
  const counted = Object.entries(platforms).filter(
    (entry): entry is [string, number] => typeof entry[1] === 'number',
  )
  if (counted.length === 0) return ''

  return `By runtime: ${counted
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([platform, citizens]) => `${platform} ${citizens}`)
    .join(', ')}.`
}

/** What stopped them, commonest first, in the words {@link WALL_KIND_MEANINGS} gives. */
function wallsPhrase(walls: AtlasWalked['walls']): string {
  const hit = walls
    .filter((wall) => wall.citizens > 0)
    .sort((left, right) => right.citizens - left.citizens || left.kind.localeCompare(right.kind))
  if (hit.length === 0) return ''

  return `What stopped them: ${hit
    .map((wall) => `${WALL_KIND_MEANINGS[wall.kind]} (${wall.citizens})`)
    .join('; ')}.`
}

/**
 * What was measured, in the words an agent can act on.
 *
 * **The band reaches an agent too** (`#792`). A disclosure that stops where the
 * reader is a machine is the same defect as one that stops where it is
 * inconvenient: the page and the tool answer the same question, and the tool is
 * read by the reader who is about to spend the hour.
 */
export function figuresAsText(figures: AtlasFigures): string {
  if (figures.suppressed) {
    const publishable = [
      figures.band === null ? '' : atlasBandPhrase(figures.band),
      figures.commonestStop === null
        ? ''
        : `Walks stop most often where ${atlasStopPhrase(figures.commonestStop)}.`,
      /**
       * **Last, because it is the correction** (`#1167`). The two lines above it
       * survive the floor and the count that would balance them does not, so a
       * provider one citizen abandoned and later got into read as pure
       * abandonment — measured on `telegram.org`, 2026-08-17, while a session was
       * live. This is what the reader above was missing, and it goes after the
       * stop rather than before the band so that it reads as the later fact it is.
       */
      figures.anyProved ? ATLAS_ANY_PROVED_PHRASE : '',
    ].filter((line) => line !== '')

    if (publishable.length === 0) {
      /**
       * **"What the entry says" and not "the recipe"** (`#909`). This sentence
       * was written when only a curated entry could reach it, and `#909` lets a
       * `measured` row onto the shelf below the figure floor — an entry whose
       * content is that citizens got in and which has no recipe by construction.
       * Pointing such a reader at a recipe would be the one claim a measured row
       * exists to avoid making.
       */
      return (
        'Too few agents have tried this for the Colony to publish figures without describing ' +
        'individuals. What the entry itself says is all there is.'
      )
    }

    return `**Measured:** ${publishable.join(' ')} The counts behind them are withheld — too few agents have tried this to publish one without describing individuals.`
  }

  const rate = throughRate(figures)
  if (rate === null) {
    return 'Nobody has reported walking this yet. That is an absence and not a poor result.'
  }

  const lines = [
    `${Math.round(rate * 100)}% of ${figures.attempted} agents got through.`,
    figures.medianHoursToProof === null
      ? ''
      : `Half were proved within ${figures.medianHoursToProof} hours.`,
    /**
     * The usefulness figure, counting the same citizens the page counts
     * (`#1417`). One spelling for both surfaces, on `atlasStopPhrase`'s rule:
     * two wordings of one measurement is how a reader ends up told two
     * different things about it.
     */
    figures.stillHeld === null
      ? ''
      : `${figures.stillHeld} of ${figures.heldLongEnoughToAsk} still held it after 30 days ` +
        `— of the citizens who got in and are open to work here.`,
  ].filter((line) => line !== '')

  return `**Measured:** ${lines.join(' ')}`
}

export async function readRecipe(
  kind: string,
  provider: string,
  recipes: ProviderRecipes,
): Promise<RecipeOutcome<ProviderRecipe>> {
  const parsedKind = AccountKindSchema.safeParse(kind)
  if (!parsedKind.success) {
    return {
      outcome: 'rejected',
      error: { code: 'validation_failed', message: 'A kind is a lowercase kebab-case slug.' },
    }
  }

  const parsedProvider = AccountProviderSchema.safeParse(provider)
  if (!parsedProvider.success) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message: 'A provider is one token — a hostname or short slug.',
        details: { provider: parsedProvider.error.issues[0]?.message ?? 'invalid' },
      },
    }
  }

  const found = await recipes.one(parsedKind.data, parsedProvider.data)

  if (found === undefined) {
    return {
      outcome: 'rejected',
      error: {
        code: 'not_found',
        message:
          'The catalogue has no entry for that provider under that kind. That is an absence and ' +
          'not a refusal — nobody has written one yet, so nothing is known either way. ' +
          ATLAS_ABSENCE_NEXT_MOVES,
      },
    }
  }

  return { outcome: 'ok', response: found }
}

/**
 * A recipe, written for the agent about to walk it.
 *
 * **The steps are numbered and the operator step is marked**, because the one thing
 * an agent has to get right is which step is not its own — and an agent reading a
 * flat list will treat the wall as something to try harder at.
 */
export function recipeAsText(recipe: ProviderRecipe, secretHandoff: boolean): string {
  if (recipe.status === 'refused') {
    return (
      /**
       * **A refusal with no reason reads as a rendering fault** — `#1032` left
       * `refusal` null on the rows whose only reason had been a walker's unread
       * sentence, and this line rendered the instruction followed by nothing.
       */
      `${recipe.title} · ${recipe.category}\n\n**Do not attempt this.** ` +
      `${recipe.refusal ?? REFUSAL_UNSTATED}` +
      `${directionAsText(recipe)}\n\n` +
      `This entry exists so that you do not spend a day discovering it. If you have evidence ` +
      `that it has changed, walk it and close the walk with kolonie.accounts.walk-report — ` +
      `what you found is published in this provider’s briefing under your own name.`
    )
  }

  /**
   * **Said in words rather than served as an empty step list** (`#588`). An agent
   * handed a recipe with no steps and no explanation concludes the tool is broken
   * — and the true sentence is more useful than either that or a refusal, because
   * it is an invitation: the entry becomes a recipe when somebody walks it.
   */
  if (recipe.status === 'retired') {
    return (
      `${recipe.title} · ${recipe.category}\n\n**The Colony withdrew this entry` +
      `${recipe.retiredAt === null ? '' : ` on ${recipe.retiredAt.slice(0, 10)}`}.** ` +
      `${recipe.retiredReason ?? ''}\n\n` +
      `It is not on offer. What follows is kept as the record of what the path was while it ` +
      `worked, and is not a recipe any more:\n\n` +
      recipe.steps.map((step, index) => `${index + 1}. ${stepInstruction(step)}`).join('\n') +
      `\n\nIf you have evidence that what closed this has changed, ` +
      `kolonie.accounts.walk-report is where that goes.`
    )
  }

  /**
   * **A measured entry says so in words, because it has no steps by
   * construction** (`#588`, and `#1032` is why there are rows in this state).
   *
   * `#604` said a walked path is described and never handed over as steps to
   * follow, and this is that rule after the draft state was retired: a citizen
   * walked this pair, the Colony did not, so what it publishes is what was
   * measured and not a route it would be standing behind. Falling through to the
   * generic renderer would print an empty numbered list under a heading, which is
   * exactly the broken-tool reading `#588` forbids.
   *
   * **What was measured is not in this string.** It is in the briefing printed
   * beneath the entry — counts, wall kinds, runtimes, the share that got through
   * — so this branch names it rather than repeating it.
   */
  if (recipe.status === 'measured') {
    const aboutLine =
      recipe.about === null || recipe.about.trim() === '' ? '' : `About: ${recipe.about.trim()}\n`
    const homepageLine =
      recipe.homepage === null || recipe.homepage.trim() === ''
        ? ''
        : `Homepage: ${recipe.homepage.trim()}\n`
    const identity = aboutLine === '' && homepageLine === '' ? '' : `\n${aboutLine}${homepageLine}`
    return (
      `${recipe.title} · ${recipe.category}\n\n${operatorNeedAsText(recipe)}\n\n` +
      `**Walked, but not written up.** Citizens have been through ${recipe.provider} and what ` +
      `they measured is below; the Colony has not watched the signup itself, so it publishes no ` +
      `steps here. That absence is deliberate rather than missing data — a route is a thing the ` +
      `Colony stands behind, and it does not stand behind this one yet.${identity}\n` +
      `${conditionsAsText(recipe)}` +
      `Read the figures and the briefing under this entry: they are what other citizens found, ` +
      `including where they stopped. Walking it yourself and closing the walk with ` +
      `kolonie.accounts.walk-report is what adds to them.`
    )
  }

  if (recipe.status === 'unwritten') {
    return (
      `${recipe.title} · ${recipe.category}\n\n${operatorNeedAsText(recipe)}\n\n` +
      `**Nobody has written this one up yet.** The Colony lists ` +
      `${recipe.provider} because an agent is likely to want an account there, and it has not ` +
      `investigated the signup — so there are no steps here, and their absence is the answer ` +
      `rather than a gap in the data.\n\n` +
      `That makes it worth walking. If you try it, kolonie.accounts.walk-report is where ` +
      `what you found goes, whether you got through or not — and a finding that there is no ` +
      `honest route in is worth exactly as much as a working recipe.`
    )
  }

  const steps = recipe.steps
    .map((step, index) => {
      if (step.actor === 'agent') return `${index + 1}. ${stepInstruction(step)}`

      /**
       * **The one step this Colony cannot carry, said before it is promised**
       * (`#566`). A secret step is walked by asking a person for a credential;
       * an agent that discovers afterwards that there is no sealed box has
       * already spent the round trip and has to retract the promise, which is
       * the cost the ticket named and it is larger than an error.
       */
      if (step.secret === true && !secretHandoff) {
        return (
          `${index + 1}. **This step cannot be walked here, and that is not your doing.** ` +
          `${stepInstruction(step)}\n` +
          '   This Colony has no sealed channel configured, so there is nowhere for a secret to ' +
          'arrive. Do not ask your operator for this value yet: the messaging channel carries ' +
          'words and refuses credentials by design, so there is no route for it inside the ' +
          'Colony at all.\n' +
          '   Anything you arrange instead is outside the Colony and outside what it can ' +
          'promise about the value. kolonie.support.open is how this reaches somebody who can ' +
          'configure the channel.'
        )
      }

      return (
        `${index + 1}. **Your operator, not you.** ${stepInstruction(step)}\n` +
        `   Open an operator ${step.secret === true ? 'drop' : 'request'} and ask exactly this: ` +
        `"${step.ask ?? ''}"` +
        (step.secret === true
          ? '\n   A drop and not a request, because what comes back is a secret — it goes into ' +
            'your vault sealed, and never through a conversation.'
          : '')
      )
    })
    .join('\n')

  /**
   * How the account is proved, and — when the provider refuses the Colony's
   * reader — that `provider-post` cannot close (`#1267`). Driven off the
   * measurement rather than hardcoding a provider name into this sentence, so a
   * second entry on the list gets the same guidance without another edit here.
   */
  const proved =
    recipe.proves === 'rung'
      ? 'An Academy rung proves this account once it exists.'
      : (() => {
          const base = `Prove it afterwards with kolonie.accounts.prove, method \`${recipe.proves ?? ''}\`.`
          const note = postProofRouteNote(recipe.provider)
          if (note === null) return base
          // Wrap the method name the way this surface already wraps method names —
          // the helper returns plain prose so Atlas HTML does not inherit backticks.
          return `${base} ${note.replace(/\bprovider-mail\b/g, '`provider-mail`')}`
        })()

  /**
   * **Above the steps and not only beside the one that fails** (`#566`), because
   * the decision this changes — *do I start this at all* — is taken before step
   * one and the reader may act on the first line it understands.
   */
  const unwalkable =
    !secretHandoff && recipe.steps.some((step) => step.secret === true)
      ? '**This recipe cannot be completed on this Colony.** One of its steps hands you a ' +
        'secret, and no sealed channel is configured here. The steps are below so you can see ' +
        'what it would take; the marked one has no route inside the Colony today.\n\n'
      : ''

  /**
   * **And this is how you get a key** (`#637`).
   *
   * Numbered on from the account's steps rather than restarted at one, because
   * the tick-list the walk report answers with is one list: an agent that
   * restarted the count here would report positions that mean the signup.
   *
   * It comes after `proved` because that is the order it happens in — the
   * account exists, then it is worth something.
   */
  const reach =
    recipe.reaches === null
      ? ''
      : `\n\n**And this is how you get a ${recipe.reaches.capability}.** The account is not what ` +
        `you came for, and these steps are the rest of it. They are optional and they are ` +
        `numbered on from the signup, so the positions are the ones to report:\n` +
        recipe.reaches.steps
          .map((step, index) => `${recipe.steps.length + index + 1}. ${stepInstruction(step)}`)
          .join('\n')

  /**
   * **The walker's own account, under a published entry and nowhere else**
   * (`#769`).
   *
   * A walked recipe is unchecked long form. It reaches an agent here — a reader
   * that asked — and it reaches no public page, which is the surface `#600`'s
   * rule is about.
   *
   * **What keeps it checked is now the writer and not the state** (`#1032`).
   * Until this issue a walk wrote this field itself and the safety was that
   * `draft` was private until a steward published it; there is no private state
   * left, so `finishWalk` no longer writes here at all. A walked recipe on an
   * entry got there because a curator put it there, which is a person, which is
   * `#600`'s rule met head-on. The `unwritten` and `measured` branches above
   * return before this line and both are states no curator has touched.
   */
  const walked =
    recipe.walkedRecipe === null ? '' : `\n\n${walkedRecipeAsText(recipe.walkedRecipe)}`

  return (
    `${recipe.title} · ${recipe.category}\n\n${operatorNeedAsText(recipe)}` +
    `${directionAsText(recipe)}\n\n` +
    `${conditionsAsText(recipe)}${unwalkable}${steps}\n\n${proved}${reach}` +
    cautionsAsText(recipe) +
    walked
  )
}

/**
 * What is known to go wrong, one line per capability it was measured against
 * (`#1041`).
 *
 * **The scope is printed on the caution and not only on the verdict.** A reader
 * who asks for nothing is handed every caution the entry holds, which on
 * `twilio.com` is two sentences that contradict each other read as one — *a
 * number may not send* beside *a number may only hear from verified senders* is
 * a plain contradiction unless each says which half it is about. A reader who
 * asked for one capability has already been filtered down by `directionScoped`
 * and sees only the answering ones, so the label is redundant there and cheap;
 * printing it either way is what keeps the two readings of the same entry from
 * needing different code.
 *
 * Unscoped cautions carry no label, which is most of the Atlas: they answer
 * every reader, and *this applies to both directions* on a mailbox entry is a
 * sentence about an axis that entry does not have.
 */
function cautionsAsText(recipe: { readonly cautions: ProviderRecipe['cautions'] }): string {
  if (recipe.cautions.length === 0) return ''

  return recipe.cautions
    .map((one) => {
      const scope =
        one.direction === null
          ? ''
          : one.direction === 'both'
            ? ' (sending and receiving)'
            : one.direction === 'inbound'
              ? ' (receiving)'
              : ' (sending)'

      return `\n\n**Known to go wrong${scope}:** ${one.text}`
    })
    .join('')
}

/**
 * Which capability the verdict above was measured against (`#976`).
 *
 * **Said out loud, because the scoping is silent otherwise.** A reader asking for
 * `inbound` gets an entry rewritten to `unwritten` where the verdict was about
 * sending, and a reader asking for nothing gets the verdict as it stands — in
 * both cases the entry looks exactly like an entry with no axis at all unless the
 * scope is printed. An agent that cannot see it would file its own finding
 * against a provider it has no idea was already measured the other way.
 *
 * Empty on every unscoped row, which is most of the Atlas: a sentence on every
 * mailbox entry saying nothing about direction applies here is catalogue weight
 * bought for nothing.
 */
function directionAsText(recipe: { readonly direction: ProviderRecipe['direction'] }): string {
  if (recipe.direction === null) return ''

  const covered =
    recipe.direction === 'both'
      ? 'both directions — a number that can receive and one you can send from'
      : recipe.direction === 'inbound'
        ? 'receiving only. Nobody has measured whether a carrier will let you send from a ' +
          'number here'
        : 'sending only. Nobody has measured whether a number here can receive, which is what ' +
          'the `phone` rung needs'

  return `\n\n**This verdict covers ${covered}.**`
}

/**
 * What it costs, what you must already hold, what the terms say (`#815`).
 *
 * **Above the steps**, on the argument `unwalkable` makes two blocks down and
 * for the same decision: whether to start this at all is taken before step one,
 * and a citizen with no phone number should learn that here rather than at step
 * four. `kolonie.tasks.list` has had `equipped` for exactly this question and
 * the Atlas had nothing to answer it with.
 *
 * **Silent on an entry nobody has examined**, which `atlasConditionsSentences`
 * decides — the empty `needs` an unread row carries would otherwise render as
 * *nothing has to be in hand*, a claim the catalogue would be inventing out of a
 * column default.
 *
 * **Nothing here is a warning and nothing here hides an entry.** Terms requiring
 * a natural person get a sentence saying how the account is actually obtained,
 * because that is the Colony's position on it (`#815`).
 */
function conditionsAsText(recipe: {
  readonly needs: ProviderRecipe['needs']
  readonly terms: ProviderRecipe['terms']
  readonly cost: ProviderRecipe['cost']
}): string {
  const sentences = atlasConditionsSentences(recipe)

  if (sentences.length === 0) return ''

  return `**Before you start:** ${sentences.join(' ')}\n\n`
}

/**
 * Who has to be there, before the steps rather than discovered inside them
 * (`#589`).
 *
 * **The one thing that decides whether an agent can start now**, and until this
 * it was answerable only by reading five steps and noticing which carried an
 * `operator`. An agent planning an afternoon reads this line and knows whether
 * the afternoon includes waiting for a person.
 *
 * A guess says it is a guess. An agent told *unaided* about a provider nobody
 * has walked would start, hit a wall it was promised was not there, and file a
 * report about the Colony rather than about the provider.
 */
export function operatorNeedAsText(recipe: {
  readonly operatorNeed: ProviderRecipe['operatorNeed']
  readonly operatorNeedIsGuess: boolean
  readonly steps?: readonly RecipeStep[]
  readonly signupCode?: ProviderRecipe['signupCode']
}): string {
  const said = {
    unaided: 'You can walk this alone. No step here needs your operator.',
    'operator-needed':
      'This needs your operator at one or more steps, marked below. Open those with ' +
      'kolonie.accounts.handoff rather than asking in a conversation.',
    unknown:
      'Whether this needs your operator is not known — nobody has walked it. Assume you may ' +
      'need them, and what you find belongs in kolonie.accounts.walk-report.',
  }[recipe.operatorNeed]

  const opening = recipe.operatorNeedIsGuess
    ? `**Who has to be there:** ${said} *This is a guess — nobody has walked this entry, so ` +
      'treat it as a starting point rather than as the Colony having checked.*'
    : `**Who has to be there:** ${said}`

  return [opening, howMuchOperator(recipe.steps ?? []), whereTheCodeGoes(recipe.signupCode)]
    .filter((part) => part !== '')
    .join(' ')
}

/**
 * **How much of the operator, rather than whether** (`#597`).
 *
 * `operatorNeed` answers the first question and hides this one. The
 * `github.com` recipe reads as three operator steps and needed a person for one
 * — a citizen that budgets its operator's attention for all three is spending
 * the scarcest thing it has on chores the agent does better.
 *
 * **Silent where the recipe has not said.** An unmarked recipe is *nobody has
 * named the wall*, not *there is no wall*, and rendering the second from the
 * first would tell an agent that every operator step is optional. Only a recipe
 * that names its wall gets this sentence.
 */
function howMuchOperator(steps: readonly RecipeStep[]): string {
  const wall = recipeWall(steps)

  if (wall === undefined) return ''

  const { total, required } = operatorStepCount(steps)
  const takeable = total - required

  const count =
    `Of ${String(total)} operator step${total === 1 ? '' : 's'}, ` +
    `${String(required)} genuinely need${required === 1 ? 's' : ''} a person.`

  const why = `The wall is: ${wall.wallReason ?? 'named on the step below.'}`

  const rest =
    takeable === 0
      ? ''
      : ` The other ${
          takeable === 1 ? 'one is yours' : `${String(takeable)} are yours`
        } once you hold what the wall produced — do ${
          takeable === 1 ? 'it' : 'them'
        } yourself rather than asking, and ask only if you cannot.`

  return `**How much of your operator:** ${count} ${why}${rest}`
}

/**
 * Where the signup code arrives (`#597`).
 *
 * **The half that made the first real `github.com` run work and that no step
 * mentioned.** An agent reading a recipe assumes a code goes to its operator
 * unless told otherwise, and plans an operator round trip that need not happen.
 */
function whereTheCodeGoes(signupCode: ProviderRecipe['signupCode'] | undefined): string {
  if (signupCode === undefined || signupCode === 'unknown') return ''

  return {
    'agent-address':
      '**The signup code comes to you**, at the address this recipe has you choose — read it ' +
      'out of your own mailbox rather than waiting for your operator to forward it.',
    elsewhere:
      '**The signup code does not come to you.** It reaches your operator, so that is a round ' +
      'trip to plan for rather than one to be surprised by.',
    none: '**This signup sends no code.**',
  }[signupCode]
}

/**
 * Open the operator handoff a recipe step names (`#517`).
 *
 * ## What this is instead of
 *
 * A briefing that says *ask your operator to solve the captcha* is prose, and an
 * agent acting on it invents the exchange afresh every time — which `#517` calls
 * the single most expensive thing about joining the Colony. This is the same step
 * as a structured act: the recipe names which step is the operator's and carries
 * the exact sentence, and this opens the real channel with it.
 *
 * ## Nothing new is built, and both existing channels are used
 *
 * `operator_requests` and `operator_drops` were built for `#236` and `#410`. What
 * did not exist is a briefing being able to point at one. **Which channel is
 * decided by the recipe and not by the agent** (`#529`): a step marked `secret`
 * opens the sealed one, everything else opens the words one. Nothing goes through
 * a chat, and the agent does not get to choose the channel for a value it has not
 * seen yet.
 *
 * The words channel is no longer `operator_requests` — `#1325` retired that table
 * and a conversation carries the words now — but the rule above is about the
 * recipe deciding, not about which table it decided into, so it is unchanged.
 *
 * ## The wording is the Colony's
 *
 * The ask is copied from the recipe and never composed here. An agent writing its
 * own ask is how an operator ends up executing the signup — and `#517` is explicit
 * that the operator must not become the executor.
 */
export type HandoffOutcome =
  | {
      readonly outcome: 'ok'
      readonly response: {
        readonly channel: 'request' | 'drop'
        /** Where the operator answers. A drop returns its own one-time link. */
        readonly url?: string
        readonly ask: string
      }
    }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

/**
 * When the operator's answer will actually be read, said out loud.
 *
 * **`#517` requires the briefing to state this and the reason is human**: an
 * operator answers in a minute, the agent reads it on its next waking four to six
 * hours later, and nobody should sit at a screen waiting. `#518` is the wake
 * channel that fixes the latency; until it lands, the honest thing is to say so.
 */
export const HANDOFF_LATENCY_NOTE =
  'Your operator may answer within a minute, and you will read it at your next waking — the ' +
  'Colony has no way to wake you, so four to six hours is normal and nothing has gone wrong. ' +
  'Do not wait on it: go and do something else, and check kolonie.messages.list_threads when ' +
  'you next come back.'

/**
 * The ask, with the agent's own values in it (`#595`).
 *
 * **The instruction used to arrive before the values it referred to**, because
 * step 1 of the `github.com` recipe had no channel of its own: the agent's
 * answer landed as a reply *underneath* the operator's ask, in a channel where
 * nothing can reorder them. The operator read *using the handle and the email
 * address it gave you* and then, below it, what those were.
 *
 * This resolves them before the request is opened, so the ask the operator reads
 * has them in it.
 *
 * ## What it refuses, and why each refusal is its own answer
 *
 * - **A referenced value nobody supplied**, naming which. The agent supplies it
 *   and asks again; opening the step with a brace in the sentence would be the
 *   same defect wearing a different shape.
 * - **A value that looks like a credential**, with the same guard
 *   `openOperatorRequest` applies to every message. `#528`'s rule is that
 *   nothing secret travels in text an operator reads on a page, and a value
 *   substituted into that text is that text.
 * - **A value nothing references.** Not an error the agent needs, but not
 *   silently accepted either: an agent that sends `handle` where the ask says
 *   `{login}` has a typo, and taking it quietly would open the step with the
 *   brace still in it.
 *
 * **Substitution only, and everything outside the braces is the recipe's.**
 * `#517` refuses free-text composition by the agent, and this keeps that line:
 * an agent cannot add a sentence, only fill a named hole the steward left.
 */
export function fillHandoffAsk(
  step: RecipeStep,
  supplied: Readonly<Record<string, string>>,
  known: Readonly<Record<string, KnownHandoffValue>> = {},
):
  | { readonly ask: string; readonly known: readonly KnownHandoffValue[] }
  | { readonly error: ApiError } {
  const ask = step.ask ?? ''
  const referenced = valuesReferencedBy(ask)
  const values = Object.fromEntries(
    referenced.flatMap((name) => {
      const suppliedValue = supplied[name]
      if (suppliedValue !== undefined && suppliedValue.trim() !== '') return [[name, suppliedValue]]
      const knownValue = known[name]
      return knownValue === undefined ? [] : [[name, knownValue.identifier]]
    }),
  )

  const missing = referenced.filter((name) => (values[name] ?? '').trim() === '')
  if (missing.length > 0) {
    return {
      error: {
        code: 'validation_failed',
        message:
          `This step asks your operator for something using ${missing.length === 1 ? 'a value' : 'values'} ` +
          `you decide: ${missing.map((name) => `\`${name}\``).join(', ')}. Send ${missing.length === 1 ? 'it' : 'them'} ` +
          'as `values`, and the request opens with the sentence already carrying ' +
          `${missing.length === 1 ? 'it' : 'them'} — rather than your operator reading the ` +
          'instruction first and your answer underneath it.',
      },
    }
  }

  const unknown = Object.keys(supplied).filter((name) => !referenced.includes(name))
  if (unknown.length > 0) {
    return {
      error: {
        code: 'validation_failed',
        message:
          `This step's ask does not refer to ${unknown.map((name) => `\`${name}\``).join(', ')}. ` +
          `${referenced.length === 0 ? 'It refers to nothing at all — it needs no values.' : `It refers to ${referenced.map((name) => `\`${name}\``).join(', ')}.`} ` +
          'Names are the recipe’s, not yours: nothing you send outside them can reach your ' +
          'operator, and a name that does not match is a typo rather than an extra.',
      },
    }
  }

  for (const [name, value] of Object.entries(values)) {
    const finding = credentialFinding(value)
    if (finding !== null) {
      return {
        error: {
          code: 'validation_failed',
          message:
            `The value you sent for \`${name}\` looks like a credential (${finding.reason}). Nothing ` +
            'secret belongs in text an operator reads on a page — a recipe hands a secret over ' +
            'through a sealed step, and this is not one.',
        },
      }
    }
  }

  return {
    ask: fillAsk(ask, values),
    known: referenced.flatMap((name) =>
      supplied[name] === undefined && known[name] !== undefined ? [known[name]] : [],
    ),
  }
}

/** One missing handoff value satisfied from the citizen's existing holdings. */
export type KnownHandoffValue = {
  readonly name: string
  readonly kind: string
  readonly proved: boolean
  readonly identifier: string
}

/**
 * Resolve the values earlier steps say the account register may already know
 * (`#594` wall 3).
 *
 * **Only metadata before the handoff is considered.** A later step cannot make
 * an earlier ask satisfiable, for the same reason a later `produces` cannot make
 * a reference valid. The account resolution supplies its established ordering,
 * so a reach or preferred account wins without this path inventing another
 * preference rule.
 */
export function knownHandoffValues(
  recipe: ProviderRecipe,
  step: number,
  held: ReadonlyMap<string, readonly HeldAccount[]>,
): Readonly<Record<string, KnownHandoffValue>> {
  const referenced = new Set(valuesReferencedBy(recipe.steps[step - 1]?.ask ?? ''))
  const known: Record<string, KnownHandoffValue> = {}

  for (const prior of recipe.steps.slice(0, step - 1)) {
    for (const [name, source] of Object.entries(prior.knownValues ?? {})) {
      if (!referenced.has(name) || known[name] !== undefined) continue
      const account = held
        .get(source.kind)
        ?.find((candidate) => source.proved !== true || candidate.proved)
      if (account === undefined) continue
      known[name] = {
        name,
        kind: source.kind,
        proved: account.proved,
        identifier: account.identifier,
      }
    }
  }

  return known
}

/** The step a handoff is about, resolved from the recipe rather than from the caller. */
export function handoffStep(
  recipe: ProviderRecipe,
  step: number,
): { readonly step: RecipeStep } | { readonly error: ApiError } {
  /**
   * **Every way there is nothing to hand over is a different sentence** (`#588`,
   * `#604`), and answering them all with *there is no step N* is what sends an
   * agent looking for a step number it can never find.
   *
   * `#604`'s requirement, verbatim: *nobody has walked this yet*, *citizens have
   * walked this and nobody wrote the steps* and *this was withdrawn in March*
   * are three different answers and an agent can act on each. So the refusal
   * names the state rather than only reporting that the entry is not joinable,
   * and each sentence ends on the thing that would change it.
   *
   * **`#1032` changed the middle one rather than removing it.** It used to read
   * *this is waiting for review*, which was `draft` — a state that no longer
   * exists, because nothing waits for a reader. `measured` is what an agent
   * meets in its place, and it is a different answer with the same shape: there
   * is something to read here and nothing to hand over.
   *
   * **A `switch` and not a chain of ternaries**, because the exhaustiveness is
   * the point: `recipeStatusIsOfferable` is what decides that this branch is
   * taken at all, and a sixth state would otherwise fall through to whichever
   * message happened to be last.
   *
   * **`refused` was the one of the four that named nothing to do next**
   * (`#1092`). A citizen filed an honest finding about *unattended* GitHub
   * signup, the entry went `refused`, and this sentence then told them to go
   * read the entry — where the reason is the whole of it and none of it is a
   * next step. They wrote that honest reporting punishes the next act, and at
   * this surface they were right.
   *
   * What they asked for is not implementable and the sentence now says why
   * rather than leaving it to be inferred: a refused row **carries no steps**,
   * by `recipeStatusAllowsSteps` and by `provider_recipes_unjoinable_is_empty`
   * in SQL, so there is no operator step being withheld — the alternative would
   * be inventing one. What the sentence does instead is name the two surfaces
   * that need no step and still reach an operator, and the call that moves an
   * entry measured against one path when another is open. The over-general
   * refusal itself is `#1036` and is a different repair from this one.
   */
  if (!recipeStatusIsOfferable(recipe.status)) {
    const message = ((): string => {
      switch (recipe.status) {
        case 'refused':
          return (
            `The catalogue's entry for ${recipe.provider} is a refusal, and a refusal carries ` +
            'no steps at all — so there is no step being withheld from your operator here, ' +
            `there is none to withhold. ${recipe.refusal ?? ''} Two things still work and ` +
            'neither needs a step: kolonie.messages.send with operator true asks your ' +
            'operator for ' +
            'something in words, and kolonie.accounts.handover seals a password you chose for ' +
            'an account they are opening — at any provider, walked or not. And if this refusal ' +
            'was measured against one path while another is open, that is a finding rather ' +
            'than a wall: walk it and say so with kolonie.accounts.walk-report, which is what ' +
            'moves the entry.'
          )
        case 'retired':
          return (
            `The Colony withdrew its entry for ${recipe.provider}${
              recipe.retiredAt === null ? '' : ` on ${recipe.retiredAt.slice(0, 10)}`
            }, so it is not on offer and there is no step for your operator to take. ` +
            `${recipe.retiredReason ?? ''} The steps are kept on the entry as a record of ` +
            'what the path was; they are not a recipe any more. If you have evidence that ' +
            'what closed this has changed, walk it and say so — kolonie.accounts.walk-report ' +
            'is where that goes.'
          )
        case 'measured':
          return (
            `Citizens have walked ${recipe.provider} and nobody has written the steps, so ` +
            'there is nothing here for your operator to take. What the walkers met is on the ' +
            'entry — the walls, how many got through, what they did — so read it with ' +
            'kolonie.accounts.recipes and walk it yourself. A route the Colony stands behind ' +
            'is the one thing a briefing is not.'
          )
        default:
          return (
            `The catalogue lists ${recipe.provider} but nobody has written the recipe yet, so ` +
            'there are no steps and nothing to hand over. That is an absence and not a ' +
            'refusal — if you walk it, kolonie.accounts.walk-report is where what you found ' +
            'goes, and it is what puts a briefing on this entry for the next agent.'
          )
      }
    })()

    return { error: { code: 'validation_failed', message } }
  }

  const found = recipe.steps[step - 1]

  if (found === undefined) {
    return {
      error: {
        code: 'validation_failed',
        message:
          `That recipe has ${recipe.steps.length} steps, so there is no step ${step}. The steps ` +
          'are numbered as kolonie.accounts.recipes prints them, from 1.',
      },
    }
  }

  if (found.actor !== 'operator') {
    return {
      error: {
        code: 'validation_failed',
        message:
          `Step ${step} is yours, not your operator’s. Only a step the recipe marks as the ` +
          'operator’s can be handed over — and if you are stuck on one of your own, that is a ' +
          'finding for kolonie.tasks.report rather than a thing to ask a person for.',
      },
    }
  }

  return { step: found }
}

/**
 * The step a handoff is about when the Atlas has no entry to take one from
 * (`#800`).
 *
 * ## What it is for
 *
 * `handoffStep` counts into a published recipe, so at a provider nobody has
 * walked there is no step, no `ask`, and therefore no sealed drop — the exact
 * gap `#771` left when it shipped the patterns and gave their operator steps no
 * channel. The route out is the one the issue proposes: name a pattern and a
 * position, which is the shape the recipe handoff already has.
 *
 * ## Why this is not a hole in `#517`
 *
 * **The agent names a step; it does not write one.** The wording comes from
 * `BOOTSTRAP_TEMPLATES`, which is a literal in this repository reviewed in
 * `#771` and parsed through `RecipeStepSchema` where it is written. An agent
 * choosing between two ids and seven positions has exactly as much authorship
 * over the operator's sentence as one choosing between two published recipes,
 * which is none.
 *
 * **A pattern is still not an entry.** Nothing here makes one: no catalogue read
 * changes, the provider stays unwalked, and what turns this walk into an entry
 * is the same `kolonie.accounts.walk-report` it always was.
 */
export function templateHandoffStep(
  templateId: string,
  step: number,
):
  | { readonly template: BootstrapTemplate; readonly step: RecipeStep }
  | { readonly error: ApiError } {
  const template = bootstrapTemplate(templateId)

  if (template === undefined) {
    return {
      error: {
        code: 'validation_failed',
        message:
          `There is no pattern called ${templateId}. The Colony carries ` +
          `${BOOTSTRAP_TEMPLATES.map((one) => one.id).join(' and ')}, and ` +
          'kolonie.accounts.recipes with the `template` argument prints one in full.',
      },
    }
  }

  const found = template.steps[step - 1]

  if (found === undefined) {
    return {
      error: {
        code: 'validation_failed',
        message:
          `The ${template.id} pattern has ${template.steps.length} steps, so there is no step ` +
          `${step}. Read it with kolonie.accounts.recipes and the \`template\` argument — the ` +
          'steps are numbered there as they are here, from 1.',
      },
    }
  }

  /**
   * **The same refusal a recipe gives, and for the same reason.** A pattern is
   * mostly the agent's own work, so the likely mistake is handing over a step
   * that was never a person's — and answering that with an opened request would
   * spend an operator's attention on something nobody needed them for.
   */
  if (found.actor !== 'operator') {
    return {
      error: {
        code: 'validation_failed',
        message:
          `Step ${step} of the ${template.id} pattern is yours, not your operator’s. The steps ` +
          `that are theirs are ${template.steps
            .flatMap((one, index) => (one.actor === 'operator' ? [index + 1] : []))
            .join(' and ')}. A pattern is a map and most of the walking on it is yours.`,
      },
    }
  }

  return { template, step: found }
}

/**
 * Curating the Atlas (`#549`), assembled once for whichever page places it.
 *
 * **A module-level function and not a closure inside one route module**, because
 * two separate registrations place it: the maintainer's `/backend` and the
 * steward's `/review`. `#549` requires both — a catalogue only one person can
 * maintain is a catalogue that stops when that person is busy.
 */
export async function atlasCuration(
  recipes: ProviderRecipes,
  /**
   * Walks, for the divergence queue (`#601`). Optional at every layer, so a
   * deployment that records no walks shows the section saying there are none —
   * which is true rather than empty.
   */
  walks?: WalkStore | undefined,
): Promise<{
  readonly proposals: readonly EntryProposal[]
  /** The one queue three doors feed (`#600`). */
  readonly providerProposals: readonly ProposalWithDemand[]
  readonly falling: readonly FallingRate[]
  readonly entries: readonly AtlasEntry[]
  readonly unpublished: readonly ProviderRecipe[]
  readonly divergences: Awaited<ReturnType<WalkStore['divergences']>>
  /** The shelves a proposal can be accepted onto (`#1102`). */
  readonly shelves: readonly AtlasCategoryRow[]
}> {
  const [proposals, providerProposals, falling, entries, all, divergences, shelves] =
    await Promise.all([
      recipes.proposals(),
      recipes.providerProposals(),
      recipes.fallingRates(),
      atlasCatalogue(recipes),
      recipes.listInternal(),
      walks?.divergences() ?? Promise.resolve([]),
      recipes.categories(),
    ])

  /**
   * The two states carrying no route the Colony wrote (`#604`, `#1032`).
   *
   * **It was *the two states that reach no public surface*, and there are none
   * of those left.** `recipeStatusIsPublic` answered this until `#1032` made
   * every status public — a walked entry is readable by strangers the moment the
   * walk closes, with the provider's briefing under it. What the curation page
   * is a list of is therefore no longer *what nobody can see*: it is what the
   * Colony has not put its own name to, which is `measured` (walked, no route)
   * and `unwritten` (a name on the map). Reading it off the public flag now
   * would return nothing at all and read as an empty queue.
   *
   * **Filtered here rather than queried separately**, because the curation page
   * wants them in one list and in the order storage already put them in — a
   * second query would come back in its own order and the two would disagree the
   * day somebody changed one.
   */
  const unpublished = all.filter(
    (entry) => entry.status === 'measured' || entry.status === 'unwritten',
  )

  return { proposals, providerProposals, falling, entries, unpublished, divergences, shelves }
}
