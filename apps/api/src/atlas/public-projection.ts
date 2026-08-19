import type { AtlasEntry } from '@kolonie-ai/core'

/**
 * What an Atlas page may show, decided once (`#1100`).
 *
 * Two surfaces render the same catalogue row. `kolonie.accounts.recipes` renders
 * it for a citizen that asked; `/atlas/:provider` renders it for a stranger and a
 * crawler. **The public one is an extract and the citizen's one is the whole
 * thing**, and until this module the difference was wherever the two renderers
 * happened to disagree — which is not a rule, it is an accident that held.
 *
 * ## What is public, and it is most of it
 *
 * Status, category, cost, the terms verdict, whether a walker got through alone
 * or needed an operator, the wall *kinds*, the figures the floor already governs,
 * the Colony's briefing in full, the direction where a kind has one, and how many
 * prerequisites, steps and verification checks there are. A page carrying all of
 * that is a good page: it answers *can I join this, what will it cost me, who has
 * to be there and what stopped the last agent* without a single instruction on
 * it.
 *
 * ## What only a citizen reads
 *
 * The steps themselves, every title and every detail; the walker's prerequisite
 * and verification text; each wall's remedy; the walker's own account of the
 * walk. **The website never shows a step-by-step recipe, only the criteria plus a
 * findings extract.** That is the line, and it is the same one `colonyRefusal`
 * already draws one level down — *what publishes immediately is the typed half,
 * which cannot carry a sentence*.
 *
 * ## The gap is widened from this side only
 *
 * **Nothing is ever removed from `kolonie.accounts.recipes` to make joining look
 * better.** If the two surfaces are too close together, the answer is a public
 * page that says less, never a citizen's answer that says less: the second one
 * pays for the difference by making the Colony worse at the thing it exists for,
 * and a reason to join that is manufactured by degrading the membership is not a
 * reason to join. {@link ATLAS_CITIZENS_ONLY} is therefore a list of what the
 * *page* withholds and never a list of what the tool must stop returning.
 *
 * ## Fail closed
 *
 * The projection names every field it lets out rather than removing the few it
 * does not. A field added to a catalogue row tomorrow is withheld until somebody
 * decides otherwise, and `public-projection.test.ts` fails until they do — where
 * a projection written as a removal would have published it silently, which is
 * exactly how prose reaches a public page nobody meant to put it on.
 */

/** One catalogue row as it reaches the entry page, with its figures. */
type AtlasRow = AtlasEntry['recipes'][number]

/**
 * The withheld fields, named, so the test that enforces this module can be
 * mechanical rather than a second copy of the rule (`#1100` decision 6).
 *
 * Anything present on a full row and absent from the projection has to appear
 * here. **Not a list of what MCP may return** — see the note on widening above.
 */
export const ATLAS_CITIZENS_ONLY = {
  /** The steps, and the walker's unedited long form behind them. */
  recipe: ['steps', 'walkedRecipe'],
  /** The steps that reach the capability, for the same reason as the steps above. */
  reach: ['steps'],
  /** The walker's own words about a wall. The kind and the count stay. */
  wall: ['title', 'symptom', 'remedy'],
} as const satisfies Readonly<Record<string, readonly string[]>>

/**
 * A wall as a stranger reads it: what it is, what it stood in front of, how
 * often, what it costs.
 *
 * `stands` is public because leaving it out is what makes a page misleading
 * (`#1062`): a free signup with a paywall in front of the capability would read
 * as a signup that costs money.
 */
export type AtlasPublicWall = Pick<
  AtlasRow['walls'][number],
  | 'kind'
  | 'direction'
  | 'stands'
  | 'reportedBy'
  | 'lastReportedAt'
  | 'posesHumanityQuestion'
  | 'accepts'
> & { readonly amountUsd?: number | undefined }

/**
 * One catalogue row, minus the recipe.
 *
 * **The counts are named rather than the arrays being shortened to numbers.** A
 * `steps` that used to be a list and is now a length would typecheck at every
 * call site that only asked for `.length`, and quietly stop typechecking nowhere
 * — so the fields are gone and `stepCount` is new, and a renderer that still
 * wants the prose fails to compile instead of rendering `undefined`.
 */
export type AtlasPublicRecipe = Pick<
  AtlasRow,
  | 'kind'
  | 'provider'
  | 'title'
  | 'category'
  | 'categories'
  | 'categoryIsFallback'
  | 'operatorNeed'
  | 'operatorNeedIsGuess'
  | 'about'
  | 'homepage'
  | 'description'
  | 'runtimes'
  | 'paid'
  | 'referral'
  | 'contact'
  | 'lastConfirmedAt'
  | 'status'
  | 'refusal'
  | 'direction'
  | 'retiredAt'
  | 'retiredReason'
  | 'proves'
  | 'provesTask'
  | 'cautions'
  | 'agentApi'
  | 'signupCode'
  | 'needs'
  | 'terms'
  | 'cost'
  | 'pacePerDay'
  | 'updatedAt'
  | 'figures'
> & {
  /** How long the path is. The numbering a reader sees is built from this. */
  readonly stepCount: number
  /** How many of those steps a person has to take. Zero is a fact worth printing. */
  readonly operatorStepCount: number
  /** How many things the walker had to have in hand before the first step. */
  readonly prerequisiteCount: number
  /** How many checks the walker used to tell the account really existed. */
  readonly verificationCount: number
  /** What an account here reaches, and how much further it is. */
  readonly reaches: {
    readonly capability: NonNullable<AtlasRow['reaches']>['capability']
    readonly stepCount: number
  } | null
  readonly walls: readonly AtlasPublicWall[]
}

/** One provider's entry, as a page written for a stranger may render it. */
export type AtlasPublicEntry = Pick<
  AtlasEntry,
  | 'provider'
  | 'path'
  | 'title'
  | 'status'
  | 'category'
  | 'description'
  | 'operatorNeed'
  | 'operatorNeedIsGuess'
  | 'source'
  | 'walkers'
  | 'health'
  | 'updatedAt'
> & { readonly recipes: readonly AtlasPublicRecipe[] }

/**
 * The one door an entry goes through on its way to HTML.
 *
 * Called by {@link atlasEntryPage} and {@link atlasIndexPage} on their own first
 * line rather than by their callers: a projection a caller has to remember is one
 * a caller forgets, and the forgetting is silent and public.
 */
export function atlasPublicEntry(entry: AtlasEntry): AtlasPublicEntry {
  return {
    provider: entry.provider,
    path: entry.path,
    title: entry.title,
    status: entry.status,
    category: entry.category,
    description: entry.description,
    operatorNeed: entry.operatorNeed,
    operatorNeedIsGuess: entry.operatorNeedIsGuess,
    source: entry.source,
    walkers: entry.walkers,
    health: entry.health,
    updatedAt: entry.updatedAt,
    recipes: entry.recipes.map(publicRecipe),
  }
}

/** Every entry in a list, on the way to the index. */
export function atlasPublicEntries(entries: readonly AtlasEntry[]): readonly AtlasPublicEntry[] {
  return entries.map(atlasPublicEntry)
}

function publicRecipe(recipe: AtlasRow): AtlasPublicRecipe {
  return {
    kind: recipe.kind,
    provider: recipe.provider,
    title: recipe.title,
    category: recipe.category,
    categories: recipe.categories,
    categoryIsFallback: recipe.categoryIsFallback,
    operatorNeed: recipe.operatorNeed,
    operatorNeedIsGuess: recipe.operatorNeedIsGuess,
    about: recipe.about,
    homepage: recipe.homepage,
    description: recipe.description,
    runtimes: recipe.runtimes,
    paid: recipe.paid,
    referral: recipe.referral,
    contact: recipe.contact,
    lastConfirmedAt: recipe.lastConfirmedAt,
    status: recipe.status,
    refusal: recipe.refusal,
    direction: recipe.direction,
    retiredAt: recipe.retiredAt,
    retiredReason: recipe.retiredReason,
    proves: recipe.proves,
    provesTask: recipe.provesTask,
    cautions: recipe.cautions,
    agentApi: recipe.agentApi,
    signupCode: recipe.signupCode,
    needs: recipe.needs,
    terms: recipe.terms,
    cost: recipe.cost,
    pacePerDay: recipe.pacePerDay,
    updatedAt: recipe.updatedAt,
    figures: recipe.figures,
    stepCount: recipe.steps.length,
    operatorStepCount: recipe.steps.filter((step) => step.actor === 'operator').length,
    /**
     * **Counted off the walker's long form, which is where the two lists live.**
     * A row nobody walked has neither, and `0` is the honest answer to *how many
     * things do I need in hand* on an entry with no account of the walk: the page
     * prints the count only where there is a walk behind it.
     */
    prerequisiteCount: recipe.walkedRecipe?.prerequisites?.length ?? 0,
    verificationCount: recipe.walkedRecipe?.verification?.length ?? 0,
    reaches:
      recipe.reaches === null
        ? null
        : { capability: recipe.reaches.capability, stepCount: recipe.reaches.steps.length },
    walls: recipe.walls.map(publicWall),
  }
}

function publicWall(wall: AtlasRow['walls'][number]): AtlasPublicWall {
  return {
    kind: wall.kind,
    direction: wall.direction,
    stands: wall.stands,
    reportedBy: wall.reportedBy,
    lastReportedAt: wall.lastReportedAt,
    posesHumanityQuestion: wall.posesHumanityQuestion,
    accepts: wall.accepts,
    amountUsd: wall.amountUsd,
  }
}
