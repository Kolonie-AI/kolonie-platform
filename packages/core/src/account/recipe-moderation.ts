import { z } from 'zod'
import { looksLikeCredential } from '../operator/request.js'
import { MODERATION_STAGE_NOT_RUN, ModerationStageSchema } from '../guidance/guidance.js'
import { AtlasCategorySchema, type ProviderRecipe, type RecipeStep } from './recipe.js'

/**
 * What decided whether a walked recipe is fit to send another agent down
 * (`#813`).
 *
 * ## Why this is a second verdict and not a branch of the first
 *
 * `#812` judges whether a provider belongs on the map. This judges whether the
 * steps somebody walked are worth following. They are different questions about
 * different objects and they fail apart: a provider can pass admission and
 * produce a bad recipe — steps in the wrong order, a wall nobody described, an
 * ask that names a credential — and a good recipe cannot rescue a provider no
 * agent can hold.
 *
 * Folding them would mean a refused *recipe* reading as a refused *provider*,
 * which takes the entry off the map for a text problem. The catalogue already
 * models the two separately: the gap between `unwritten` and `draft` is
 * admission, and the gap between `draft` and `joinable` is this.
 *
 * ## Three outcomes and not two
 *
 * `#813` names publishing and refusing. There is a third, and leaving it out
 * would have made this pass destructive: **`refused` is a state that keeps no
 * steps.** `provider_recipes_unjoinable_is_empty` requires a refused entry to
 * carry none, so refusing a draft throws the walk away. That is the right
 * answer for *there is no honest route here* and the wrong one for *step three
 * has no sentence yet* — and most of what stops a draft from being published is
 * the second kind.
 *
 * So a draft that is neither publishable nor condemnable is **held**: the row
 * stays a draft, the verdict is recorded with its reason, and a steward reading
 * `#814`'s screen is told what to fix rather than shown a queue with nothing in
 * it. This is the same instinct `#812` states about a proposal it could not
 * judge — *the human was removed from before the listing, not from the Colony*.
 */

/**
 * What each stage of the recipe verdict answered.
 *
 * The **stage** shape is `ModerationStageSchema`, shared with every other
 * moderation table here; the **set** of stages is this file's, for the reason
 * `AtlasModerationStagesSchema` gives one file over: flattening vocabularies
 * would lose which question was asked, and *which question was asked* is what a
 * reader months later is trying to recover.
 *
 * **Three of the six are arithmetic**, and they are first for the reason the
 * quest pipeline orders its own stages that way: an answer a query can give is
 * an answer nobody pays a model for. It is also the stronger check where it
 * applies — whether an ask names a credential is decided by
 * {@link looksLikeCredential}, which is the same value test `RecipeStepSchema`
 * and `WalkNoteSchema` already refuse on, rather than by asking a model to
 * notice.
 */
export const RecipeModerationStagesSchema = z.object({
  /**
   * Whether this exact text has been judged before.
   *
   * **Arithmetic, and structurally first.** A walk that re-walks a provider
   * writes a new draft, and where the text is unchanged the verdict is unchanged
   * — asking again would buy a second opinion about the same sentences at the
   * price of five model calls. Its outcome is `distinct` or the verdict this
   * text already got.
   */
  dedup: ModerationStageSchema,
  /**
   * `clear` or `crossed` — a recipe that reads as a route past a provider's
   * terms.
   *
   * Cheapest exit and most severe verdict, so it is the first thing paid for.
   */
  redLine: ModerationStageSchema,
  /**
   * `clear`, or which step carries something that looks like a credential.
   *
   * Arithmetic. `RecipeStepSchema` already refuses an `ask` that trips
   * {@link looksLikeCredential}, so a draft that fails here was written past the
   * schema — by the seed, by a `psql` prompt, or by a walk whose steps were
   * assembled before the refinement existed. It is checked again because this is
   * the last gate before an agent is sent down the path.
   */
  credentials: ModerationStageSchema,
  /**
   * `named`, or what is missing before this can be published at all.
   *
   * Arithmetic, and it is the table's own constraints read forwards rather than
   * hit as an error: `joinable` requires `proves`, every step written, and at
   * least one step. A draft that fails this is **held**, not refused — nothing
   * about it says the provider has no route.
   */
  publishable: ModerationStageSchema,
  /**
   * `sound` or `unsound` — steps in order, each one doable, operator steps
   * marked and worded as asks.
   *
   * The one stage that reads the steps as prose, and the only reason this pass
   * needs a model at all.
   */
  steps: ModerationStageSchema,
  /**
   * Which shelf the entry belongs on, confirmed or corrected (`#807`).
   *
   * Runs last and only where the entry is going to be published: nothing
   * re-shelves a draft that stays a draft. A walk derives the category from
   * whatever the entry already had — `finishWalk` falls back to `data-apis` —
   * so a guess is what this is confirming.
   */
  shelf: ModerationStageSchema,
})
export type RecipeModerationStages = z.infer<typeof RecipeModerationStagesSchema>

/** Six stages, none of them run yet. What a draft's judgement starts from. */
export function noRecipeStagesRun(): RecipeModerationStages {
  const notRun = { outcome: MODERATION_STAGE_NOT_RUN } as const

  return {
    dedup: notRun,
    redLine: notRun,
    credentials: notRun,
    publishable: notRun,
    steps: notRun,
    shelf: notRun,
  }
}

/**
 * What the Colony decided about one walked recipe.
 *
 * `published` and `refused` move the entry. **`held` moves nothing** and is not
 * a failure to decide: it is the verdict *this walk is not publishable as it
 * stands, and here is what is missing*, which is a decision a steward can act on
 * and a walker can read. A draft nobody could judge — an unreachable model —
 * records no row at all and is retried, exactly as `#812` leaves a proposal
 * pending.
 */
export const RecipeVerdictSchema = z.enum(['published', 'refused', 'held'])
export type RecipeVerdict = z.infer<typeof RecipeVerdictSchema>

/**
 * The shelves an entry may be moved to, as the closed set the model answers
 * from. Read off `AtlasCategorySchema`, never written out again.
 */
export const RECIPE_SHELF_CHOICES: readonly string[] = AtlasCategorySchema.options

/**
 * The step that carries something that looks like a credential, if one does.
 *
 * **Both fields, and the instruction as well as the ask.** The ask is what an
 * operator is shown and is the field `RecipeStepSchema` already refuses on; the
 * instruction is what the *agent* is shown, and a password written into it
 * reaches a reader just as surely. Returns the 1-based position, because that is
 * how a recipe's steps are numbered everywhere a person reads them.
 */
export function stepNamingACredential(steps: readonly RecipeStep[]): number | undefined {
  const position = steps.findIndex(
    (step) =>
      (step.ask !== undefined && looksLikeCredential(step.ask)) ||
      (step.instruction !== undefined && looksLikeCredential(step.instruction)),
  )

  return position === -1 ? undefined : position + 1
}

/**
 * Why this draft cannot become `joinable` yet, in one sentence, or `undefined`
 * when nothing stands in the way.
 *
 * **The table's own constraints, read forwards.** `provider_recipes` refuses a
 * `joinable` row with no steps, with no `proves`, or with a step that has no
 * instruction. Hitting those as a failed `UPDATE` would tell the runner *this
 * write is invalid* and tell the walker nothing; asking first turns each of them
 * into a sentence naming what is missing.
 *
 * **Every one of these is fixable and none of them is a refusal.** A walk that
 * got an account and did not establish how to prove it is a real outcome and a
 * reviewable one — `#601`'s argument for storing a wordless step in the first
 * place — so what this produces is the reason a draft is held.
 */
export function whyNotPublishable(
  draft: Pick<ProviderRecipe, 'steps' | 'proves' | 'provesTask'>,
): string | undefined {
  if (draft.steps.length === 0) {
    return 'This walk recorded no steps, so there is no path to publish. A recipe is the steps.'
  }

  const wordless = draft.steps.findIndex((step) => step.instruction === undefined)
  if (wordless !== -1) {
    return (
      `Step ${wordless + 1} has no instruction. A walk records that a step happened and who it ` +
      'needed; the sentence describing it is still the Colony’s to write, and an entry ' +
      'published with a blank step would be handed to an agent as a path to follow.'
    )
  }

  const unasked = draft.steps.findIndex(
    (step) => step.actor === 'operator' && step.ask === undefined,
  )
  if (unasked !== -1) {
    return (
      `Step ${unasked + 1} needs an operator and carries no ask. The recipe carries the sentence ` +
      'the operator is shown, so that the agent does not compose it — an agent composing the ' +
      'ask is how an operator ends up executing the signup.'
    )
  }

  if (draft.proves === null || draft.proves === undefined) {
    return (
      'No proof method is named. An entry the Colony stands behind says how the account it ' +
      'produces is proved, and this walk did not establish one.'
    )
  }

  if (draft.proves === 'rung' && (draft.provesTask === null || draft.provesTask === undefined)) {
    return 'The proof method is a rung, and which rung is not named.'
  }

  return undefined
}

/**
 * The red-line refusal, which names no rule and no phrase.
 *
 * `#694`'s second register, for the reason `ATLAS_RED_LINE_REFUSAL` gives: every
 * specific refusal teaches somebody probing where the boundary is. What is
 * different here is who reads it — a walker who took the trouble to write the
 * walk down — so it says plainly that the refusal is about the route and not
 * about them, and it points at the register rather than paraphrasing it.
 */
export const RECIPE_RED_LINE_REFUSAL =
  'The Colony will not publish this recipe. It reads as a route around a provider’s own ' +
  'terms, and the Colony does not instruct anyone around those — a citizen may still hold ' +
  'such an account, obtained together with its operator. This is not about the quality of the ' +
  'walk, and there is nothing here to reword: see governance/red-lines.md for the register ' +
  'this refusal comes from.'
