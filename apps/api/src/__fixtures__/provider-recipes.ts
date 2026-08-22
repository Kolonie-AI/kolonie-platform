import {
  AccountKindSchema,
  ATLAS_SEEDED_CATEGORIES,
  earnFacetsOf,
  facetsFrom,
  tagsOf,
  figureKey,
  noFigures,
  operatorNeed,
  publishWalls,
  recipeStatusAllowsSteps,
  recipeStatusIsPublic,
  now as currentTime,
  type AtlasFigures,
  type AtlasProposal,
  type EntryProposal,
  type ProviderBriefing,
  type ProviderRecipe,
  type RecipeOperatorGuess,
  type ServedWalkNote,
  type ServedOperateNote,
  type ServedWalkRoute,
} from '@kolonie-ai/core'
import type { FallingRate } from '@kolonie-ai/db'
import type { ProviderRecipes } from '../provider-recipes.js'

/**
 * The catalogue's own order, in the fake (`#588`, `#604`).
 *
 * The same order `providerRecipeList` gives in SQL, spelled out rather than
 * derived: a fake that sorted a boolean would put an unwritten entry below a
 * refusal and hide the ordering half of `#588`, and one that fell through to a
 * default for `#604`'s three would sort a withdrawal above a refusal.
 */
const LIST_ORDER: readonly ProviderRecipe['status'][] = [
  'joinable',
  'measured',
  'unwritten',
  'refused',
  'retired',
]

/**
 * What a caller may narrow the figures by, taken from the port rather than
 * restated: an option added there is one this fake records without being edited.
 */
type FiguresAsk = NonNullable<Parameters<ProviderRecipes['figures']>[0]>

function listOrder(status: ProviderRecipe['status']): number {
  const at = LIST_ORDER.indexOf(status)

  return at === -1 ? LIST_ORDER.length : at
}

/**
 * The provider catalogue, in memory (`#521`).
 *
 * **Empty by default and seeded by the test that needs entries.** A fixture that
 * shipped the three real entries would make every unrelated test depend on their
 * wording, and the catalogue is content — the thing most likely to be edited.
 */
export interface FakeProviderRecipes extends ProviderRecipes {
  readonly write: (
    entry: Omit<Partial<ProviderRecipe>, 'kind' | 'provider' | 'operatorNeed'> & {
      kind: string
      provider: string
      /**
       * A guess a test can set, exactly as the column allows (`#589`). The
       * derived answer is never settable here — it comes from the steps, which
       * is the property the fake exists to preserve.
       */
      operatorGuess?: RecipeOperatorGuess
    },
  ) => void
  /** Move an existing row through curation without adding a second provider entry. */
  readonly setStatus: (kind: string, provider: string, status: ProviderRecipe['status']) => void
  /**
   * What a test says was measured about an entry (`#545`).
   *
   * **Set rather than derived**, unlike the catalogue rows beside it: the
   * measurement is a query over two other tables, and reimplementing it here
   * would let a page test pass against a fake that counts differently from the
   * SQL. `packages/db/src/storage/atlas-figures.test.ts` is where the counting
   * is asserted, against a real Postgres.
   */
  readonly measure: (figures: AtlasFigures) => void
  /**
   * What each read asked the figures for (`#990`).
   *
   * **Recorded rather than applied, and that is the point.** The scoping is a
   * predicate over `provider_reports` rows, asserted against a real Postgres in
   * `packages/db/src/storage/atlas-figures.test.ts`; a fake that narrowed its
   * own counts would let an api test pass against an arithmetic the SQL does
   * not share. What no db test can see is whether the read *asks* — and a read
   * that scoped the entries and dropped the direction on the way to the figures
   * is exactly the defect `#990` names, so that is what this exposes.
   */
  readonly figuresAskedFor: () => readonly FiguresAsk[]
  /**
   * What the Colony wrote up about an entry (`#831`).
   *
   * **Set rather than derived, for the reason `measure` is.** A briefing is
   * written by a model over a corpus of walks and served under a currency rule;
   * a fake that decided which claims were current would let a page test pass
   * against an arithmetic the SQL does not share.
   * `packages/db/src/storage/provider-briefing.test.ts` is where that is
   * asserted, against a real Postgres.
   */
  readonly brief: (briefing: ProviderBriefing) => void
  /**
   * A note a walker left at this pair, as a reader receives it (`#1035`).
   *
   * **Set rather than derived, for the reason `brief` is.** Which notes are
   * published, whose handle each carries and what order they come in are three
   * decisions the SQL makes — out of `scrubbed_prose`, past `attributed`, by
   * score — and a fake that made them again could make them differently.
   * `packages/db/src/storage/walk-notes.test.ts` is where they are asserted,
   * against a real Postgres.
   */
  readonly note: (kind: string, provider: string, note: ServedWalkNote) => void
  /**
   * The route a walker wrote for this pair, as a reader receives it (`#1090`).
   *
   * **Set rather than derived, for the reason `note` is**, and with one decision
   * more: the real read serves *one* route per pair and picks the newest. A fake
   * that picked would have to know which walk finished last, which is a fact
   * about rows it does not hold. `packages/db/src/storage/walk-notes.test.ts`
   * asserts the picking against a real Postgres; setting one here says only that
   * a route exists and reaches the page.
   */
  readonly route: (kind: string, provider: string, route: ServedWalkRoute) => void
  /**
   * A post-account operate tip at this pair (`#1299`).
   *
   * **Set rather than derived, for the reason `note` is.** Moderation and
   * attribution are SQL decisions; the fake only says a tip reaches the page.
   */
  readonly operateNote: (kind: string, provider: string, note: ServedOperateNote) => void
  /**
   * A citizen who walked this pair and is named for it (`#960`).
   *
   * **Only the ones a test wants named.** The real read already applies both
   * filters — the walk was proposed as an entry, and the citizen has not opted
   * out — so a fake carrying walks that are not attributions would have to
   * reimplement that decision and could reimplement it differently.
   */
  readonly walk: (kind: string, provider: string, handle: string) => void
  /** A proposal waiting on `#549`'s queue. */
  readonly propose: (proposal: EntryProposal) => void
  /** Put a provider on the one queue three doors feed (`#600`). */
  readonly proposeProvider: (proposal: AtlasProposal) => void
  /** An entry whose measured rate has fallen, for the signal on the same screen. */
  readonly fall: (rate: FallingRate) => void
}

export function fakeProviderRecipes(): FakeProviderRecipes {
  const rows: ProviderRecipe[] = []
  const measured: AtlasFigures[] = []
  const briefed: ProviderBriefing[] = []
  const noted: { kind: string; provider: string; note: ServedWalkNote }[] = []
  const routed: { kind: string; provider: string; route: ServedWalkRoute }[] = []
  const operated: { kind: string; provider: string; note: ServedOperateNote }[] = []
  const proposed: EntryProposal[] = []
  const providersProposed: AtlasProposal[] = []
  const falling: FallingRate[] = []
  const walked: { kind: string; provider: string; handle: string }[] = []
  const asked: FiguresAsk[] = []

  return {
    /**
     * **Measured pairs first, and a catalogue row is not required for one**
     * (`#856`). The real query counts `accounts` and `provider_reports` joined
     * on `(kind, provider)` and never reads the catalogue, so a provider four
     * citizens got through carries figures whether or not anybody has written it
     * up — which is the exact case `measuredOnlyRecipes` exists to surface. A
     * fake that could only answer for rows it already had would have made that
     * case untestable and looked correct doing it.
     */
    async figures(options) {
      asked.push(options ?? {})

      const seen = new Map<string, AtlasFigures>()

      for (const one of measured) {
        const key = figureKey(one.kind, one.provider)
        if (!seen.has(key)) seen.set(key, one)
      }

      for (const row of rows) {
        const key = figureKey(row.kind, row.provider)
        if (!seen.has(key)) seen.set(key, noFigures(row.kind, row.provider))
      }

      /**
       * **`only` is honoured here rather than left to the caller** (`#1627`).
       * The real query narrows its own CTEs, so a fake that answered for the
       * whole catalogue would let a caller pass `only` and still be handed every
       * provider's figures — which `measuredOnlyRecipes` would then synthesise
       * rows from. The test would pass on a fake that is doing the thing the
       * issue is about.
       */
      const wanted = options?.only
      const all = [...seen.values()]

      return wanted === undefined ? all : all.filter((one) => one.provider === wanted)
    },

    measure(figures) {
      measured.push(figures)
    },

    figuresAskedFor() {
      return [...asked]
    },

    /**
     * **Keyed the way the figures are, and answered for one provider only**
     * (`#831`). The real reading is a table lookup on the entry page; a fake
     * that answered for the whole catalogue would let a test pass over an index
     * that quietly paid for every briefing in the Colony.
     */
    async briefings(provider) {
      return new Map(
        briefed
          .filter((one) => one.provider.toLowerCase() === provider.toLowerCase())
          .map((one) => [figureKey(one.kind, one.provider), one]),
      )
    },

    brief(briefing) {
      briefed.push(briefing)
    },

    /** The quoted half of the same answer, on the same terms (`#1035`). */
    async notes(provider) {
      const found = new Map<string, ServedWalkNote[]>()
      for (const one of noted) {
        if (one.provider.toLowerCase() !== provider.toLowerCase()) continue
        const key = figureKey(one.kind, one.provider)
        found.set(key, [...(found.get(key) ?? []), one.note])
      }

      return found
    },

    note(kind, provider, note) {
      noted.push({ kind, provider, note })
    },

    /** The longest block of the same answer, on the same terms (`#1090`). */
    async routes(provider) {
      const found = new Map<string, ServedWalkRoute>()
      for (const one of routed) {
        if (one.provider.toLowerCase() !== provider.toLowerCase()) continue
        const key = figureKey(one.kind, one.provider)
        if (!found.has(key)) found.set(key, one.route)
      }

      return found
    },

    route(kind, provider, route) {
      routed.push({ kind, provider, route })
    },

    async operateNotes(provider) {
      const found = new Map<string, ServedOperateNote[]>()
      for (const one of operated) {
        if (one.provider.toLowerCase() !== provider.toLowerCase()) continue
        const key = figureKey(one.kind, one.provider)
        found.set(key, [...(found.get(key) ?? []), one.note])
      }

      return found
    },

    operateNote(kind, provider, note) {
      operated.push({ kind, provider, note })
    },

    /**
     * **The whole catalogue, unlike the briefings above** (`#960`). The real
     * read is one query over `account_walks` for every entry a page might
     * render, because an Atlas listing renders many; answering per provider
     * here would let a test pass over a query the listing never makes.
     */
    async walkers() {
      const named = new Map<string, string[]>()

      for (const one of walked) {
        const key = figureKey(one.kind, one.provider)
        const held = named.get(key)
        if (held === undefined) named.set(key, [one.handle])
        else if (!held.includes(one.handle)) held.push(one.handle)
      }

      return named
    },

    walk(kind, provider, handle) {
      walked.push({ kind, provider, handle })
    },

    async proposals() {
      return proposed.filter((one) => one.status === 'pending')
    },

    async fallingRates() {
      return falling
    },

    async decide(id, status) {
      const found = proposed.find((one) => one.id === id && one.status === 'pending')
      if (found === undefined) return undefined

      const decided = { ...found, status, decidedAt: currentTime() }
      proposed[proposed.indexOf(found)] = decided

      return decided
    },

    async providerProposals() {
      return providersProposed
        .filter((one) => one.status === 'pending')
        .map((proposal) => ({ proposal, citizens: 0, operators: 0 }))
    },

    async decideProvider(id, action) {
      const found = providersProposed.find((one) => one.id === id && one.status === 'pending')
      if (found === undefined) return { outcome: 'not-pending' as const }

      const decided: AtlasProposal = {
        ...found,
        status:
          action.action === 'accept'
            ? 'accepted'
            : action.action === 'refuse'
              ? 'refused'
              : 'merged',
        decidedReason: action.action === 'refuse' ? action.reason : null,
        mergedInto: action.action === 'merge' ? action.into : null,
        decidedAt: currentTime(),
      }
      providersProposed[providersProposed.indexOf(found)] = decided

      return { outcome: 'decided' as const, proposal: decided }
    },

    // @mirrors packages/db/src/storage/provider-recipes.ts publishProviderRecipe 33d2c756
    async refuseEntry(kind, provider, decision) {
      const at = rows.findIndex(
        (row) =>
          row.kind === kind &&
          row.provider.toLowerCase() === provider.toLowerCase() &&
          row.status === 'measured',
      )
      const found = rows[at]
      if (found === undefined) return false

      /**
       * **Refusing empties the row, because the table will not hold it
       * otherwise.** `provider_recipes_unjoinable_is_empty` refuses steps or a
       * proof on anything that is not joinable, so a fake that kept them would
       * let a test pass against a row Postgres would reject.
       */
      rows[at] = {
        ...found,
        status: 'refused',
        refusal: decision.refusal,
        steps: [],
        proves: null,
        provesTask: null,
        reaches: null,
        updatedAt: currentTime(),
      }

      return true
    },

    // @mirrors packages/db/src/storage/provider-recipes.ts dressProviderRecipe 1faf9547
    async dressEntry(kind, provider, wording) {
      const at = rows.findIndex(
        (row) =>
          row.kind === kind &&
          row.provider.toLowerCase() === provider.toLowerCase() &&
          row.status === 'measured',
      )
      const found = rows[at]
      if (found === undefined) return false

      /** Writing the route is the publishing act since `#1032`, so the status moves here. */
      rows[at] = {
        ...found,
        status: 'joinable',
        steps: [...wording.steps],
        proves: wording.proves,
        provesTask: wording.proves === 'rung' ? (wording.provesTask ?? null) : null,
        updatedAt: currentTime(),
      }

      return true
    },

    proposeProvider(proposal) {
      providersProposed.push(proposal)
    },

    propose(proposal) {
      proposed.push(proposal)
    },

    fall(rate) {
      falling.push(rate)
    },

    /**
     * **The public reading, and the fake has to hide the same two states the SQL
     * hides** (`#604`). A fake that returned everything would let a page test
     * pass while `/atlas` published an unread suggestion about somebody else's
     * product — which is the one failure this state is for.
     */
    async list(kind) {
      return rows
        .filter((row) => kind === undefined || row.kind === kind)
        .filter((row) => recipeStatusIsPublic(row.status))
        .sort((a, b) => listOrder(a.status) - listOrder(b.status))
    },

    async listInternal() {
      return [...rows].sort((a, b) => listOrder(a.status) - listOrder(b.status))
    },

    /**
     * The seeded taxonomy, which is what `0279` put in the table (`#1102`).
     *
     * **The constant and not a copy of it.** A fake that listed its own fifteen
     * shelves would be a second vocabulary to keep in step, and the migration
     * seeds this array verbatim — so a test rendering the maintainer's shelf
     * picker sees the shelves a fresh database has.
     */
    async categories() {
      return ATLAS_SEEDED_CATEGORIES
    },

    async one(kind, provider) {
      return rows.find(
        (row) => row.kind === kind && row.provider.toLowerCase() === provider.toLowerCase(),
      )
    },

    setStatus(kind, provider, status) {
      const at = rows.findIndex(
        (row) => row.kind === kind && row.provider.toLowerCase() === provider.toLowerCase(),
      )
      const existing = rows[at]
      if (existing === undefined) throw new Error('cannot change a recipe that does not exist')

      rows[at] = {
        ...existing,
        status,
        refusal: status === 'refused' ? (existing.refusal ?? 'no honest route in') : null,
        retiredAt: status === 'retired' ? currentTime() : null,
        retiredReason: status === 'retired' ? 'the entry was withdrawn' : null,
        updatedAt: currentTime(),
      }
    },

    write(entry) {
      const status = entry.status ?? 'joinable'
      const steps =
        entry.steps ??
        (recipeStatusAllowsSteps(status) && status !== 'retired'
          ? [{ actor: 'agent' as const, instruction: 'sign up' }]
          : [])
      const need = operatorNeed({ steps, operatorGuess: entry.operatorGuess })
      rows.push({
        kind: AccountKindSchema.parse(entry.kind),
        provider: entry.provider as ProviderRecipe['provider'],
        title: entry.title ?? `${entry.provider}`,
        about: entry.about ?? null,
        homepage: entry.homepage ?? null,
        /**
         * **Null unless a test asks for it** (`#1120`, rendered by `#1121`). The
         * live column is filled by the moderation runner and by no write path,
         * so the fake's default is the state most rows are actually in — and a
         * test that wants the sentence rendered says so in one word.
         */
        description: entry.description ?? null,
        runtimes: entry.runtimes ?? [],
        paid: entry.paid ?? false,
        referral: entry.referral ?? null,
        contact: entry.contact ?? null,
        /**
         * **`??` would swallow an explicit `null`**, which is the value that
         * means *nobody has ever confirmed this* — a case a page has to be able
         * to render and a test therefore has to be able to write. The key being
         * absent is what defaults; passing `null` says something.
         */
        lastConfirmedAt:
          'lastConfirmedAt' in entry ? (entry.lastConfirmedAt ?? null) : currentTime(),
        status,
        category: entry.category ?? 'code-hosting',
        /**
         * **One shelf unless a test says otherwise, and it is the primary one**
         * (`#1102`). That is the invariant `provider_recipes_keep_primary_shelf`
         * holds in the database: every entry has a join row for the column it
         * carries, so a fake whose `categories` could be empty would let a test
         * pass over a row that cannot exist.
         */
        categories: entry.categories ?? [entry.category ?? 'code-hosting'],
        /**
         * **Built from the shelf and whatever earn facets the test set** (`#1301`).
         *
         * A fixture that let a caller write `facets` freely could produce an entry
         * whose shelf and whose utility facet disagree, which is a row storage
         * cannot make: `toRecipe` derives both from the same shelf list. So the
         * utility axis follows `categories` here too, and a test that wants an earn
         * facet passes one — which is the only half a writer actually chooses.
         */
        facets: [
          ...facetsFrom(
            entry.categories ?? [entry.category ?? 'code-hosting'],
            earnFacetsOf(entry.facets ?? []),
            // Tags, on the same terms as the earn axis: whatever the test set
            // and nothing derived (`#1406`).
            tagsOf(entry.facets ?? []),
          ),
        ],
        operatorNeed: need.need,
        operatorNeedIsGuess: need.isGuess,
        refusal: entry.refusal ?? (status === 'refused' ? 'no honest route in' : null),
        /**
         * Unscoped unless a test says which way (`#976`) — the state every entry
         * written before the axis existed is in, and the one `directionAnswers`
         * reads as answering whatever a reader asks.
         */
        direction: entry.direction ?? null,
        /**
         * A withdrawal carries both or neither, exactly as the column does
         * (`#604`) — a fake that let one through would let a page test pass over
         * a row the database would refuse.
         */
        retiredAt: entry.retiredAt ?? (status === 'retired' ? currentTime() : null),
        retiredReason:
          entry.retiredReason ??
          (status === 'retired' ? 'the provider stopped taking agents' : null),
        steps,
        proves: entry.proves ?? (status === 'joinable' ? 'provider-post' : null),
        provesTask: entry.provesTask ?? null,
        reaches: entry.reaches ?? null,
        cautions: entry.cautions ?? [],
        walkedRecipe: entry.walkedRecipe ?? null,
        /**
         * **Derived from the walk unless the caller says otherwise** (`#981`).
         *
         * `#982` derived it and nothing else, because the entry's walls *were* one
         * walker's walls and a fixture that set them without a walk could assert on
         * a row no database can hold. They are an aggregate now, computed where a
         * walk finishes and stored — and the thirteen backfilled entries carry one
         * with no walk under it at all, so a fake that refuses that refuses a row
         * production has. The derivation stays as the default, which is what keeps
         * a test that only means *this entry was walked* honest.
         */
        walls: entry.walls ?? [...publishWalls([], entry.walkedRecipe?.walls ?? [])],
        agentApi: entry.agentApi ?? 'unknown',
        signupCode: entry.signupCode ?? 'unknown',
        needs: entry.needs ?? [],
        terms: entry.terms ?? 'unknown',
        cost: entry.cost ?? 'unknown',
        pacePerDay: entry.pacePerDay ?? null,
        updatedAt: currentTime(),
      })
    },
  }
}
