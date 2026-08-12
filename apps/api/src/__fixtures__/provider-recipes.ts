import {
  AccountKindSchema,
  noFigures,
  operatorNeed,
  recipeStatusAllowsSteps,
  recipeStatusIsPublic,
  now as currentTime,
  type AtlasFigures,
  type AtlasProposal,
  type EntryProposal,
  type ProviderRecipe,
  type RecipeOperatorGuess,
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
  'draft',
  'unwritten',
  'refused',
  'retired',
  'proposed',
]

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
  const proposed: EntryProposal[] = []
  const providersProposed: AtlasProposal[] = []
  const falling: FallingRate[] = []

  return {
    async figures() {
      return rows.map(
        (row) =>
          measured.find((one) => one.kind === row.kind && one.provider === row.provider) ??
          noFigures(row.kind, row.provider),
      )
    },

    measure(figures) {
      measured.push(figures)
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
        operatorNeed: need.need,
        operatorNeedIsGuess: need.isGuess,
        refusal: entry.refusal ?? (status === 'refused' ? 'no honest route in' : null),
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
        caution: entry.caution ?? null,
        agentApi: entry.agentApi ?? 'unknown',
        signupCode: entry.signupCode ?? 'unknown',
        pacePerDay: entry.pacePerDay ?? null,
        updatedAt: currentTime(),
      })
    },
  }
}
