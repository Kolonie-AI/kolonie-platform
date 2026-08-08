import {
  AccountKindSchema,
  atlasByOutcome,
  atlasEntries,
  throughRate,
  figureKey,
  type AccountKind,
  type ApiError,
  type AtlasAudience,
  type AtlasEntry,
  type AtlasFigures,
  type EntryProposal,
  type ProviderRecipe,
  type RecipeStep,
} from '@kolonie-ai/core'
import type { Database } from '@kolonie-ai/db'
import {
  atlasFigures,
  decideProposal,
  fallingSuccessRates,
  pendingProposals,
  providerRecipe,
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
    readonly provider?: string
  }): Promise<readonly AtlasFigures[]>
  /** The review queue `#549` works through: proposals nobody has decided. */
  proposals(): Promise<readonly EntryProposal[]>
  /** The signal `#549` says will actually be used: rates that have fallen sharply. */
  fallingRates(): Promise<readonly FallingRate[]>
  /** Accept or refuse one, recorded against its author. */
  decide(id: string, status: 'accepted' | 'refused'): Promise<EntryProposal | undefined>
}

export function databaseProviderRecipes(db: Database): ProviderRecipes {
  return {
    list: (kind) => providerRecipeList(db, kind),
    one: (kind, provider) => providerRecipe(db, kind, provider),
    figures: (options) => atlasFigures(db, options ?? {}),
    proposals: () => pendingProposals(db),
    fallingRates: () => fallingSuccessRates(db),
    decide: (id, status) => decideProposal(db, id, status),
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
 */
export async function atlasCatalogue(
  recipes: ProviderRecipes,
  options: { readonly audience?: AtlasAudience; readonly ordered?: boolean } = {},
): Promise<readonly AtlasEntry[]> {
  const [rows, measured] = await Promise.all([
    recipes.list(),
    recipes.figures(options.audience === undefined ? {} : { audience: options.audience }),
  ])

  const entries = atlasEntries(
    rows,
    new Map(measured.map((one) => [figureKey(one.kind, one.provider), one])),
  )

  return options.ordered === false ? entries : atlasByOutcome(entries)
}

export type RecipeOutcome<T> =
  | { readonly outcome: 'ok'; readonly response: T }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

export async function readRecipes(
  kind: string | undefined,
  recipes: ProviderRecipes,
): Promise<RecipeOutcome<{ readonly recipes: readonly ProviderRecipe[] }>> {
  if (kind === undefined) {
    return { outcome: 'ok', response: { recipes: await recipes.list() } }
  }

  const parsed = AccountKindSchema.safeParse(kind)
  if (!parsed.success) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message:
          'A kind is a lowercase kebab-case slug — "mailbox", "github", "trello". Leave it out ' +
          'to read the whole catalogue.',
      },
    }
  }

  return { outcome: 'ok', response: { recipes: await recipes.list(parsed.data) } }
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
  },
  recipes: ProviderRecipes,
): Promise<RecipeOutcome<{ readonly entries: readonly AtlasEntry[] }>> {
  if (input.kind !== undefined && !AccountKindSchema.safeParse(input.kind).success) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message: 'A kind is a lowercase kebab-case slug — "mailbox", "github", "trello".',
      },
    }
  }

  const all = await atlasCatalogue(recipes)

  const entries = all
    .map((entry) => ({
      ...entry,
      recipes: entry.recipes.filter(
        (recipe) =>
          (input.kind === undefined || recipe.kind === input.kind) &&
          (input.held === undefined || !input.held.has(recipe.kind)),
      ),
    }))
    .filter((entry) => entry.recipes.length > 0)
    .filter(
      (entry) => input.provider === undefined || entry.provider === input.provider.toLowerCase(),
    )

  if (input.provider !== undefined && entries.length === 0) {
    return {
      outcome: 'rejected',
      error: {
        code: 'not_found',
        message:
          'The Atlas has no entry for that provider. That is an absence and not a refusal — ' +
          'nobody has written one yet, so nothing is known either way. If you walk it, ' +
          'kolonie.accounts.provider-report is where what you found goes.',
      },
    }
  }

  return { outcome: 'ok', response: { entries } }
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
export function atlasEntryAsText(entry: AtlasEntry): string {
  const parts = [`## ${entry.title} (${entry.provider})`]

  if (entry.recipes.some((recipe) => recipe.paid)) {
    parts.push(
      '**This entry is paid for.** It buys the entry and nothing else — not its position, ' +
        'which is computed from what agents measured, and not the removal of a poor result.',
    )
  }

  for (const recipe of entry.recipes) {
    parts.push(recipeAsText(recipe), figuresAsText(recipe.figures))
  }

  return parts.filter((part) => part !== '').join('\n\n')
}

/** What was measured, in the words an agent can act on. */
export function figuresAsText(figures: AtlasFigures): string {
  if (figures.suppressed) {
    return (
      'Too few agents have tried this for the Colony to publish figures without describing ' +
      'individuals. The recipe is what is known.'
    )
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
    figures.stillHeld === null
      ? ''
      : `${figures.stillHeld} of ${figures.heldLongEnoughToAsk} still held it after 30 days.`,
  ].filter((line) => line !== '')

  return `**Measured:** ${lines.join(' ')}`
}

export async function readRecipe(
  kind: string,
  provider: string,
  recipes: ProviderRecipes,
): Promise<RecipeOutcome<ProviderRecipe>> {
  const parsed = AccountKindSchema.safeParse(kind)
  if (!parsed.success) {
    return {
      outcome: 'rejected',
      error: { code: 'validation_failed', message: 'A kind is a lowercase kebab-case slug.' },
    }
  }

  const found = await recipes.one(parsed.data, provider)

  if (found === undefined) {
    return {
      outcome: 'rejected',
      error: {
        code: 'not_found',
        message:
          'The catalogue has no entry for that provider under that kind. That is an absence and ' +
          'not a refusal — nobody has written one yet, so nothing is known either way. If you ' +
          'walk it, kolonie.accounts.provider-report is where what you found goes.',
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
export function recipeAsText(recipe: ProviderRecipe): string {
  if (!recipe.joinable) {
    return (
      `${recipe.title}\n\n**Do not attempt this.** ${recipe.refusal ?? ''}\n\n` +
      `This entry exists so that you do not spend a day discovering it. If you have evidence ` +
      `that it has changed, kolonie.accounts.provider-report is where that goes.`
    )
  }

  const steps = recipe.steps
    .map((step, index) => {
      if (step.actor === 'agent') return `${index + 1}. ${step.instruction}`

      return (
        `${index + 1}. **Your operator, not you.** ${step.instruction}\n` +
        `   Open an operator ${step.secret === true ? 'drop' : 'request'} and ask exactly this: ` +
        `"${step.ask ?? ''}"` +
        (step.secret === true
          ? '\n   A drop and not a request, because what comes back is a secret — it goes into ' +
            'your vault sealed, and never through a conversation.'
          : '')
      )
    })
    .join('\n')

  const proved =
    recipe.proves === 'rung'
      ? 'An Academy rung proves this account once it exists.'
      : `Prove it afterwards with kolonie.accounts.prove, method \`${recipe.proves ?? ''}\`.`

  return (
    `${recipe.title}\n\n${steps}\n\n${proved}` +
    (recipe.caution === null ? '' : `\n\n**Known to go wrong:** ${recipe.caution}`)
  )
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
 * did not exist is a briefing being able to point at one. **Which of the two is
 * decided by the recipe and not by the agent** (`#529`): a step marked `secret`
 * opens a sealed drop, everything else opens a request. Nothing goes through a
 * chat, and the agent does not get to choose the channel for a value it has not
 * seen yet.
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
  'Do not wait on it: go and do something else, and check kolonie.operator.requests when you ' +
  'next come back.'

/** The step a handoff is about, resolved from the recipe rather than from the caller. */
export function handoffStep(
  recipe: ProviderRecipe,
  step: number,
): { readonly step: RecipeStep } | { readonly error: ApiError } {
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
 * Curating the Atlas (`#549`), assembled once for whichever page places it.
 *
 * **A module-level function and not a closure inside one route module**, because
 * two separate registrations place it: the maintainer's `/backend` and the
 * steward's `/review`. `#549` requires both — a catalogue only one person can
 * maintain is a catalogue that stops when that person is busy.
 */
export async function atlasCuration(recipes: ProviderRecipes): Promise<{
  readonly proposals: readonly EntryProposal[]
  readonly falling: readonly FallingRate[]
  readonly entries: readonly AtlasEntry[]
}> {
  const [proposals, falling, entries] = await Promise.all([
    recipes.proposals(),
    recipes.fallingRates(),
    atlasCatalogue(recipes),
  ])

  return { proposals, falling, entries }
}
