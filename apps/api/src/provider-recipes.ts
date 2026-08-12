import {
  AccountKindSchema,
  AtlasCategorySchema,
  atlasByOutcome,
  atlasEntries,
  credentialFinding,
  fillAsk,
  valuesReferencedBy,
  throughRate,
  figureKey,
  recipeStatusIsOfferable,
  stepInstruction,
  recipeStatusIsPublic,
  operatorStepCount,
  recipeWall,
  type AccountKind,
  type ApiError,
  type AtlasAudience,
  type AtlasEntry,
  type AtlasFigures,
  type EntryProposal,
  type ProposalAction,
  type ProposalWithDemand,
  type ProviderRecipe,
  type RecipeStep,
  walkedRecipeAsText,
} from '@kolonie-ai/core'
import type { Database } from '@kolonie-ai/db'
import type { WalkStore } from './account-walks.js'
import type { HeldAccount } from './accounts.js'
import {
  atlasFigures,
  decideProposal,
  decideProviderProposal,
  pendingProviderProposals,
  type DecideProposalOutcome,
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
}

export function databaseProviderRecipes(db: Database): ProviderRecipes {
  return {
    list: (kind) => providerRecipeList(db, kind),
    listInternal: () => providerRecipeList(db, undefined, { includeInternal: true }),
    one: (kind, provider) => providerRecipe(db, kind, provider),
    figures: (options) => atlasFigures(db, options ?? {}),
    proposals: () => pendingProposals(db),
    fallingRates: () => fallingSuccessRates(db),
    decide: (id, status) => decideProposal(db, id, status),
    providerProposals: () => pendingProviderProposals(db),
    decideProvider: (id, action) => decideProviderProposal(db, id, action),
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
  RecipeOutcome<{ readonly entries: readonly AtlasEntry[]; readonly secretHandoff: boolean }>
> {
  if (input.kind !== undefined && !AccountKindSchema.safeParse(input.kind).success) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message: 'A kind is a lowercase kebab-case slug — "mailbox", "github", "trello".',
      },
    }
  }

  if (input.category !== undefined && !AtlasCategorySchema.safeParse(input.category).success) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message:
          'That is not a category the Atlas uses. The list is closed on purpose — a shelf ' +
          `nobody can find things on is not a shelf — and it is: ${AtlasCategorySchema.options.join(', ')}.`,
      },
    }
  }

  const all = await atlasCatalogue(recipes)

  const entries = all
    .map((entry) => ({
      ...entry,
      recipes: entry.recipes
        .filter(
          (recipe) =>
            (input.kind === undefined || recipe.kind === input.kind) &&
            (input.held === undefined || !input.held.has(recipe.kind)),
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

  return { outcome: 'ok', response: { entries, secretHandoff } }
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
export function atlasEntryAsText(entry: AtlasEntry, secretHandoff: boolean): string {
  const parts = [`## ${entry.title} (${entry.provider})`]

  if (entry.recipes.some((recipe) => recipe.paid)) {
    parts.push(
      '**This entry is paid for.** It buys the entry and nothing else — not its position, ' +
        'which is computed from what agents measured, and not the removal of a poor result.',
    )
  }

  for (const recipe of entry.recipes) {
    parts.push(recipeAsText(recipe, secretHandoff), figuresAsText(recipe.figures))
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
export function recipeAsText(recipe: ProviderRecipe, secretHandoff: boolean): string {
  if (recipe.status === 'refused') {
    return (
      `${recipe.title} · ${recipe.category}\n\n**Do not attempt this.** ${recipe.refusal ?? ''}\n\n` +
      `This entry exists so that you do not spend a day discovering it. If you have evidence ` +
      `that it has changed, kolonie.accounts.provider-report is where that goes.`
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
      `kolonie.accounts.provider-report is where that goes.`
    )
  }

  /**
   * **A draft is described and never handed over as steps to follow** (`#604`).
   * An agent given four steps and no warning walks them, and the whole of what
   * publishing decides is whether anybody has checked them.
   */
  if (recipe.status === 'draft') {
    return (
      `${recipe.title} · ${recipe.category}\n\n**Walked, not published.** Somebody wrote down ` +
      `${recipe.steps.length} step${recipe.steps.length === 1 ? '' : 's'} for ` +
      `${recipe.provider} and no steward has reviewed them yet, so they are not here: the ` +
      `Colony does not hand an agent a path it has not stood behind.\n\n` +
      `Nothing is needed from you. This becomes a recipe when it is reviewed.`
    )
  }

  if (recipe.status === 'unwritten' || recipe.status === 'proposed') {
    return (
      `${recipe.title} · ${recipe.category}\n\n${operatorNeedAsText(recipe)}\n\n` +
      `**Nobody has written this one up yet.** The Colony lists ` +
      `${recipe.provider} because an agent is likely to want an account there, and it has not ` +
      `investigated the signup — so there are no steps here, and their absence is the answer ` +
      `rather than a gap in the data.\n\n` +
      `That makes it worth walking. If you try it, kolonie.accounts.provider-report is where ` +
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
          'arrive. Do not ask your operator for this value yet: an operator request carries ' +
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

  const proved =
    recipe.proves === 'rung'
      ? 'An Academy rung proves this account once it exists.'
      : `Prove it afterwards with kolonie.accounts.prove, method \`${recipe.proves ?? ''}\`.`

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
   * A first walker's long form is unchecked citizen text. It reaches an agent
   * here — where the reader is one that asked, and where the entry has already
   * passed a steward on its way out of `draft` — and it reaches no public page,
   * which is the surface `#600`'s rule is about. The `draft` and `unwritten`
   * branches above return before this line, so that is structural rather than a
   * condition somebody has to remember.
   */
  const walked =
    recipe.walkedRecipe === null ? '' : `\n\n${walkedRecipeAsText(recipe.walkedRecipe)}`

  return (
    `${recipe.title} · ${recipe.category}\n\n${operatorNeedAsText(recipe)}\n\n` +
    `${unwalkable}${steps}\n\n${proved}${reach}` +
    (recipe.caution === null ? '' : `\n\n**Known to go wrong:** ${recipe.caution}`) +
    walked
  )
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
      'need them, and what you find belongs in kolonie.accounts.provider-report.',
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
   * `#604`'s requirement, verbatim: *nobody has walked this yet*, *this is
   * waiting for review* and *this was withdrawn in March* are three different
   * answers and an agent can act on each. So the refusal names the state rather
   * than only reporting that the entry is not joinable, and each sentence ends
   * on the thing that would change it.
   *
   * **A `switch` and not a chain of ternaries**, because the exhaustiveness is
   * the point: `recipeStatusIsOfferable` is what decides that this branch is
   * taken at all, and a seventh state would otherwise fall through to whichever
   * message happened to be last.
   */
  if (!recipeStatusIsOfferable(recipe.status)) {
    const message = ((): string => {
      switch (recipe.status) {
        case 'refused':
          return (
            `The catalogue's entry for ${recipe.provider} is a refusal: there is no honest ` +
            'route in, so there is no step for your operator to take. Read the entry with ' +
            'kolonie.accounts.recipes — the reason is the whole of it.'
          )
        case 'retired':
          return (
            `The Colony withdrew its entry for ${recipe.provider}${
              recipe.retiredAt === null ? '' : ` on ${recipe.retiredAt.slice(0, 10)}`
            }, so it is not on offer and there is no step for your operator to take. ` +
            `${recipe.retiredReason ?? ''} The steps are kept on the entry as a record of ` +
            'what the path was; they are not a recipe any more. If you have evidence that ' +
            'what closed this has changed, kolonie.accounts.provider-report is where that goes.'
          )
        case 'draft':
          return (
            `Somebody has walked ${recipe.provider} and no steward has published it yet, so ` +
            'the steps exist and are not on offer — following an unreviewed walk is the one ' +
            'thing publishing decides against. Nothing is needed from you: this is waiting ' +
            'for review, and the entry becomes a recipe when it gets one.'
          )
        default:
          return (
            `The catalogue lists ${recipe.provider} but nobody has written the recipe yet, so ` +
            'there are no steps and nothing to hand over. That is an absence and not a ' +
            'refusal — if you walk it, kolonie.accounts.provider-report is where what you ' +
            'found goes, and it is what turns this entry into one.'
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
}> {
  const [proposals, providerProposals, falling, entries, all, divergences] = await Promise.all([
    recipes.proposals(),
    recipes.providerProposals(),
    recipes.fallingRates(),
    atlasCatalogue(recipes),
    recipes.listInternal(),
    walks?.divergences() ?? Promise.resolve([]),
  ])

  /**
   * The two states that reach no public surface (`#604`).
   *
   * **Filtered here rather than queried separately**, because the curation page
   * wants them in one list and in the order storage already put them in — a
   * second query would come back in its own order and the two would disagree the
   * day somebody changed one.
   */
  const unpublished = all.filter((entry) => !recipeStatusIsPublic(entry.status))

  return { proposals, providerProposals, falling, entries, unpublished, divergences }
}
