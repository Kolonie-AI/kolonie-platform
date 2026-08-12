import {
  RECIPE_RED_LINE_REFUSAL,
  RECIPE_SHELF_CHOICES,
  noRecipeStagesRun,
  stepNamingACredential,
  whyNotPublishable,
  type AtlasCategory,
  type ProviderRecipe,
  type RecipeModerationStages,
} from '@kolonie-ai/core'
import type { Log } from './loop.js'
import type { Model } from './llm.js'
import {
  RECIPE_RED_LINE_PROMPT,
  RECIPE_SHELF_PROMPT,
  RECIPE_STEPS_PROMPT,
} from './recipe-prompts.js'

/**
 * The stage that decides whether a walked recipe is published (`#813`).
 *
 * **The gap this closes.** A walk that gets through writes a `draft`, and a draft
 * is invisible: `providerRecipeList` hides it from strangers by default and
 * `recipeStatusIsOfferable` is `joinable` only. So an agent that walked
 * `notion.com`, wrote down every step and proved the account produced an entry
 * nobody outside the Colony could read — and it stayed that way until a steward
 * looked, which is the same unattended queue `#812` was about one table over.
 *
 * **Why the verdict is the decision here too.** The same argument, with one
 * difference that matters: what is published is *instructions another agent will
 * follow*, so the pass is arranged to be conservative in the direction that costs
 * only time. Anything it cannot clear is held as a draft, which is exactly where
 * the entry already was.
 *
 * **Three outcomes.** `published` moves the draft to `joinable`. `refused` is for
 * a red line only, because the table makes a refusal wipe the steps. `held`
 * records what was wrong and moves nothing — the verdict a steward reads, and the
 * one most drafts that are not yet publishable get.
 */

/** Where the recipe pass reads and writes. Injected, so the decision is testable without a database. */
export interface RecipeModerationStore {
  /** Drafts awaiting a verdict, oldest first. */
  pending(
    limit: number,
  ): Promise<readonly { readonly id: string; readonly recipe: ProviderRecipe }[]>
  /**
   * The digest of the last verdict about this entry, if there is one.
   *
   * The dedup stage, and it is arithmetic rather than a model call.
   */
  lastVerdict(
    recipeId: string,
  ): Promise<{ readonly decision: string; readonly contentSha256: string } | undefined>
  /** The digest of the text as it stands, so the pass can compare without knowing how it is computed. */
  digest(recipe: ProviderRecipe): string
  record(input: {
    readonly recipeId: string
    readonly decision: 'published' | 'refused' | 'held'
    readonly model: string
    readonly stages: RecipeModerationStages
    readonly refusal?: string | undefined
    readonly category?: AtlasCategory | undefined
  }): Promise<{ readonly outcome: 'written' | 'stale' }>
}

export interface RecipeLoopDependencies {
  readonly store: RecipeModerationStore
  readonly model: Model
  readonly log?: Log
}

const silentLog: Log = { info: () => {}, warn: () => {}, error: () => {} }

/** What one draft's moderation came to. `failed` costs that draft a poll and nothing else. */
export type RecipeJudgement =
  | { readonly kind: 'published'; readonly category: string }
  | { readonly kind: 'refused'; readonly refusal: string }
  | { readonly kind: 'held'; readonly reason: string }
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'stale' }
  | { readonly kind: 'failed'; readonly error: unknown }

/** The steps, as the model reads them. Numbered, because a verdict names a step by its number. */
function recipeText(recipe: ProviderRecipe): string {
  return [
    `Provider: ${recipe.provider}`,
    `Account kind: ${recipe.kind}`,
    recipe.about === null ? 'No description.' : `What it is: ${recipe.about}`,
    recipe.proves === null
      ? 'How the account is proved: not stated.'
      : `How the account is proved: ${recipe.proves}${
          recipe.provesTask === null ? '' : ` (rung: ${recipe.provesTask})`
        }`,
    '',
    'Steps:',
    ...recipe.steps.map((step, index) =>
      [
        `${index + 1}. [${step.actor}] ${step.instruction ?? '(no instruction written)'}`,
        step.ask === undefined ? undefined : `   What the operator is asked: ${step.ask}`,
      ]
        .filter((line) => line !== undefined)
        .join('\n'),
    ),
  ].join('\n')
}

/**
 * Judge one draft, and act on the verdict.
 *
 * **Cheapest-and-most-severe first**, the quest pipeline's order for its reasons.
 * Dedup and the credential check are arithmetic and run before anything is paid
 * for; the red line refuses without paying for the two questions behind it.
 *
 * **The publishability check runs before the model reads the steps** even though
 * it is not the most severe. It is the commonest reason a draft is not ready, it
 * costs nothing, and its answer is *this cannot be published whatever the steps
 * say* — asking a model to assess prose that a constraint will reject either way
 * is buying an opinion nobody can act on.
 *
 * **A model that is unreachable leaves the draft a draft.** Not published, not
 * refused, retried on the next tick — the clause `judgeProposal` states, and it
 * costs even less here, because a draft is already where a draft belongs.
 */
export async function judgeDraft(
  draft: { readonly id: string; readonly recipe: ProviderRecipe },
  deps: RecipeLoopDependencies,
): Promise<RecipeJudgement> {
  const { store, model } = deps
  const { recipe } = draft
  const text = recipeText(recipe)

  try {
    const stages = noRecipeStagesRun()
    let answeredBy = model.name

    /**
     * **Judged before, and unchanged since.** A held draft that comes back with
     * the same steps gets the same verdict, so nothing is asked and nothing is
     * written: a second identical row would say only that the pass ran twice.
     */
    const digest = store.digest(recipe)
    const last = await store.lastVerdict(draft.id)
    if (last !== undefined && last.contentSha256 === digest) {
      return { kind: 'unchanged' }
    }
    stages.dedup = { outcome: 'distinct' }

    const redLine = await model.classify({
      system: RECIPE_RED_LINE_PROMPT,
      user: text,
      choices: ['clear', 'crossed'],
    })
    answeredBy = redLine.call?.model ?? answeredBy

    if (redLine.decision === 'crossed') {
      // Recorded and not shown, `#694`'s second register: the walker is told the
      // refusal is about the route, and the register is where the rule lives.
      stages.redLine = { outcome: 'crossed', reason: redLine.reason }

      return await decide(draft, deps, stages, answeredBy, {
        kind: 'refused',
        refusal: RECIPE_RED_LINE_REFUSAL,
      })
    }
    stages.redLine = { outcome: 'clear' }

    /**
     * **Arithmetic, and stronger than asking.** `looksLikeCredential` is the same
     * test `RecipeStepSchema` refuses an ask on, so this catches a step that got
     * in past the schema — and it is checked here because this is the last gate
     * before the steps are handed to an agent.
     */
    const credential = stepNamingACredential(recipe.steps)
    if (credential !== undefined) {
      stages.credentials = { outcome: 'named', reason: `step ${credential}` }

      return await decide(draft, deps, stages, answeredBy, {
        kind: 'held',
        reason:
          `Step ${credential} carries something that looks like a credential. A recipe is ` +
          'published to every citizen, and a secret belongs in a handover step rather than in ' +
          'the sentence describing it.',
      })
    }
    stages.credentials = { outcome: 'clear' }

    const missing = whyNotPublishable(recipe)
    if (missing !== undefined) {
      stages.publishable = { outcome: 'incomplete', reason: missing }

      return await decide(draft, deps, stages, answeredBy, { kind: 'held', reason: missing })
    }
    stages.publishable = { outcome: 'complete' }

    const steps = await model.classify({
      system: RECIPE_STEPS_PROMPT,
      user: text,
      choices: ['sound', 'unsound'],
    })
    answeredBy = steps.call?.model ?? answeredBy
    stages.steps = { outcome: steps.decision, reason: steps.reason }

    if (steps.decision === 'unsound') {
      return await decide(draft, deps, stages, answeredBy, {
        kind: 'held',
        /**
         * The model's own sentence, and not a rewrite of it: it names the step
         * and what is missing, which is what whoever fixes the draft needs. A
         * generic sentence in its place would make every unsound draft look alike.
         */
        reason: steps.reason ?? 'The steps are not sound enough to publish.',
      })
    }

    const shelf = await model.classify({
      system: RECIPE_SHELF_PROMPT,
      user: text,
      choices: RECIPE_SHELF_CHOICES,
    })
    answeredBy = shelf.call?.model ?? answeredBy
    stages.shelf = { outcome: shelf.decision, reason: shelf.reason }

    return await decide(draft, deps, stages, answeredBy, {
      kind: 'published',
      category: shelf.decision,
    })
  } catch (error) {
    return { kind: 'failed', error }
  }
}

/** Write the verdict, and let the transaction that stores it be the one that acts on it. */
async function decide(
  draft: { readonly id: string; readonly recipe: ProviderRecipe },
  deps: RecipeLoopDependencies,
  stages: RecipeModerationStages,
  model: string,
  verdict:
    | { readonly kind: 'published'; readonly category: string }
    | { readonly kind: 'refused'; readonly refusal: string }
    | { readonly kind: 'held'; readonly reason: string },
): Promise<RecipeJudgement> {
  const written = await deps.store.record({
    recipeId: draft.id,
    decision: verdict.kind,
    model,
    stages,
    ...(verdict.kind === 'refused' ? { refusal: verdict.refusal } : {}),
    ...(verdict.kind === 'published' ? { category: verdict.category as AtlasCategory } : {}),
  })

  return written.outcome === 'stale' ? { kind: 'stale' } : verdict
}

export interface RecipeTickOutcome {
  readonly judged: number
  readonly published: number
  readonly refused: number
  readonly held: number
  readonly failed: number
}

/**
 * One pass over the queue.
 *
 * Sequential rather than concurrent, for the reason every other pass here is: the
 * calls share one model budget, and a batch that fans out turns a rate limit into
 * a whole tick failing rather than one draft waiting for the next.
 */
export async function recipeTick(
  deps: RecipeLoopDependencies,
  batchSize: number,
): Promise<RecipeTickOutcome> {
  const { store, log = silentLog } = deps
  const drafts = await store.pending(batchSize)

  const outcome = { judged: 0, published: 0, refused: 0, held: 0, failed: 0 }

  for (const draft of drafts) {
    const judgement = await judgeDraft(draft, deps)
    const { provider } = draft.recipe

    if (judgement.kind !== 'unchanged') outcome.judged++

    switch (judgement.kind) {
      case 'published':
        outcome.published++
        log.info(`${provider} published on the ${judgement.category} shelf`, {
          event: 'recipe.draft.judged',
          provider,
          verdict: 'published',
          category: judgement.category,
        })
        break
      case 'refused':
        outcome.refused++
        log.info(`${provider} refused`, {
          event: 'recipe.draft.judged',
          provider,
          verdict: 'refused',
        })
        break
      case 'held':
        outcome.held++
        log.info(`${provider} held as a draft`, {
          event: 'recipe.draft.judged',
          provider,
          verdict: 'held',
          reason: judgement.reason,
        })
        break
      case 'unchanged':
        /**
         * Not counted and not warned about. A draft that has been judged and not
         * edited since is the steady state of a queue that is working — logging it
         * would put a line in the runner's output on every tick forever.
         */
        break
      case 'stale':
        log.warn(`${provider} was already decided when its verdict arrived`, {
          event: 'recipe.draft.stale',
          provider,
        })
        break
      case 'failed':
        outcome.failed++
        log.error(`${provider} could not be judged`, judgement.error, {
          event: 'recipe.draft.failed',
          provider,
        })
        break
    }
  }

  return outcome
}
