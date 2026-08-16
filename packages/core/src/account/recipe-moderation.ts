import { z } from 'zod'
import { looksLikeCredential } from '../operator/request.js'
import { MODERATION_STAGE_NOT_RUN, ModerationStageSchema } from '../guidance/guidance.js'
import { AccountProofMethodSchema } from './account.js'
import {
  AtlasCategorySchema,
  RECIPE_MAX_STEPS,
  RECIPE_STEP_MAX_LENGTH,
  RecipeActorSchema,
  type ProviderRecipe,
  type RecipeStep,
} from './recipe.js'

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
   * `not-needed`, `formed`, or why the sentences could not be formed (`#941`).
   *
   * **The stage that unsticks the wordless draft.** A walk records that a step
   * happened and never a sentence for it (`#517`), so `publishable` below held
   * every walked draft on wording that only a steward could supply — and four of
   * them sat that way. This stage may form the missing sentence, but only out of
   * what the walk itself recorded: the walker's own account of that step, and the
   * `did` / `broke` / `changed` narrative on the same walk. A sentence that cites
   * nothing recorded is dropped rather than published, and the step stays
   * wordless.
   *
   * **Defaulted rather than required**, so that a verdict written before this
   * stage existed still parses. Six stages became seven and the older rows say
   * nothing about the seventh, which is the honest reading of them.
   */
  wording: ModerationStageSchema.default({ outcome: MODERATION_STAGE_NOT_RUN }),
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

/**
 * What a held verdict was held on, in one sentence (`#941`).
 *
 * **The last stage carrying a reason, and not the first.** A verdict runs its
 * stages in order and stops at the one that held it, so the reason furthest down
 * is the one it stopped on; an earlier stage's reason, where one exists, is a
 * note beside a stage that nonetheless let the draft through.
 *
 * Absent where nothing recorded one — an older verdict, a stage that held without
 * saying why — which the caller prints as such rather than inventing a cause.
 */
export function whyRecipeHeld(stages: RecipeModerationStages): string | undefined {
  const inOrder = [
    stages.dedup,
    stages.redLine,
    stages.credentials,
    stages.wording,
    stages.publishable,
    stages.steps,
    stages.shelf,
  ]

  return inOrder.reduce<string | undefined>((held, stage) => stage.reason ?? held, undefined)
}

/** Seven stages, none of them run yet. What a draft's judgement starts from. */
export function noRecipeStagesRun(): RecipeModerationStages {
  const notRun = { outcome: MODERATION_STAGE_NOT_RUN } as const

  return {
    dedup: notRun,
    redLine: notRun,
    credentials: notRun,
    wording: notRun,
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
    /**
     * **Held on a steward, and said as that** (`#986`). This sentence used to
     * say the wording is the Colony's to write and then read, in a list called
     * `requiredChanges`, as an instruction to the walker to write it. A citizen
     * did — eight steps of it — and found no call that would take them. One of
     * the two halves had to go, and `#517` decides which: the entry's wording is
     * the Colony's, so what is missing here is the Colony's own outstanding
     * work.
     */
    return (
      `Step ${wordless + 1} is waiting for its wording. A walk records that a step happened and ` +
      'who it needed; the sentence an agent would follow is the Colony’s to write, and an entry ' +
      'published with a blank step would be handed to an agent as a path to follow. Nothing here ' +
      'is owed by the walker.'
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

/**
 * How long a draft the pass could not complete stays a draft (`#941`).
 *
 * **A fortnight, measured from the last time anything touched the row.** A
 * steward's edit, a second walk, a re-judged verdict — each restarts it, because
 * each is somebody working on the entry and the window exists for the drafts
 * nobody is. What it ends is not a backlog but a silence: `#812` found the Atlas
 * queue unattended rather than slow, and an unattended draft and an abandoned one
 * are indistinguishable from outside until one of them expires.
 */
export const RECIPE_DRAFT_EXPIRY_DAYS = 14

/**
 * Why a draft expired, written for the walker who will read it (`#941`).
 *
 * **It carries the reason the pass last gave**, because *the window ran out* is
 * not why the entry failed — it is only when the Colony stopped waiting. The
 * walker needs the first to know whether walking it again would help.
 *
 * **Withdrawn and not refused**, which is the difference the text makes plain:
 * the steps are kept, the provider is not condemned, and walking it again is the
 * ordinary next move rather than an appeal.
 */
export function recipeDraftExpired(lastHeldOn: string | undefined): string {
  return (
    `The Colony waited ${String(RECIPE_DRAFT_EXPIRY_DAYS)} days for this draft to become ` +
    'publishable and it did not, so the entry has been withdrawn rather than published. ' +
    (lastHeldOn === undefined
      ? 'No verdict recorded what it was waiting on.'
      : `What it was held on: ${lastHeldOn}`) +
    ' Nothing about this says the provider cannot be joined — the steps are kept and the ' +
    'entry is readable, and a fresh walk that describes each step it took would replace it.'
  )
}

/**
 * The route a curator writes onto a measured entry so it can be published
 * (`#857`, rewritten by `#1032`).
 *
 * ## What changed, and why the walk is no longer the skeleton
 *
 * `#857` called this a *wording*, and the noun was exact: a walk produced a
 * `draft` carrying the shape it observed — who acted, in what order, through
 * which channel — and a steward supplied only the sentences, positionally, one
 * per observed step. `actor` was deliberately not settable, because retyping it
 * would have been editing the record of what happened rather than describing it.
 *
 * `#1032` retired the draft. A walk now writes a `measured` row with **no steps
 * at all**, and its own account of the path is published beside the entry in the
 * provider's computed briefing, attributed to the walker and moderated as prose.
 * So there is no observed shape left here to dress, and the positional rule it
 * enforced has nothing to be positional against.
 *
 * **What replaces it is the whole route, written by whoever publishes it.** That
 * is the sharper reading of `#517` rather than a loosening of it: the entry is
 * what the Colony stands behind, so its shape and its sentences have one author
 * and that author is not a transcription of one agent's afternoon. A walk
 * disagreeing with the published route is not a lost edit — it is a divergence,
 * raised as one.
 *
 * ## Why this is still separate from the verdict
 *
 * It no longer is, and that is the point: writing the route **is** publishing it
 * (`dressEntry`), because a `measured` row cannot hold steps and a `joinable` one
 * cannot exist without them. There is no half-dressed state to leave behind and
 * nothing left to decide afterwards.
 */
export const EntryWordingSchema = z
  .object({
    /**
     * The route, in the order an agent would walk it.
     *
     * **Every step carries its own actor**, which is what `#1032` moved here from
     * the walk. An `ask` belongs to an `operator` step and is refused on an
     * `agent` one — {@link routeFromWording} is where that is enforced, so the
     * refusal can name the position.
     */
    steps: z
      .array(
        z
          .object({
            actor: RecipeActorSchema,
            instruction: z.string().trim().min(1).max(RECIPE_STEP_MAX_LENGTH),
            ask: z.string().trim().min(1).max(RECIPE_STEP_MAX_LENGTH).optional(),
            secret: z.boolean().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(RECIPE_MAX_STEPS),
    proves: AccountProofMethodSchema,
    provesTask: z.string().trim().min(1).max(64).optional(),
  })
  .strict()
export type EntryWording = z.infer<typeof EntryWordingSchema>

/** A route, or the one sentence saying why these steps are not one. */
export type DressedSteps =
  | { readonly ok: true; readonly steps: readonly RecipeStep[] }
  | { readonly ok: false; readonly why: string }

/**
 * Turn what a curator wrote into the steps an entry publishes.
 *
 * Pure, so the screen and the write agree about what a published route is, and so
 * the rejection cases are testable without a database. Every refusal names the
 * position it is about, because that is how a curator finds the field to fix.
 *
 * **It takes no observed shape** since `#1032`. It used to be handed the steps a
 * walk recorded and asked to dress them one for one; a `measured` entry carries
 * no steps by construction, so there is nothing to line up against and the whole
 * route arrives here at once.
 */
export function routeFromWording(wording: EntryWording['steps']): DressedSteps {
  const steps: RecipeStep[] = []

  for (const [at, written] of wording.entries()) {
    if (written.actor === 'agent' && written.ask !== undefined) {
      return {
        ok: false,
        why:
          `Step ${String(at + 1)} is the agent acting alone and carries an ask. An ask is what an ` +
          'operator is shown, and a step with both would put a question in front of nobody.',
      }
    }

    if (written.actor === 'operator' && written.ask === undefined) {
      return {
        ok: false,
        why:
          `Step ${String(at + 1)} needs an operator and carries no ask. The recipe carries the ` +
          'sentence the operator is shown, so that the agent does not compose it.',
      }
    }

    steps.push({
      actor: written.actor,
      instruction: written.instruction,
      ...(written.ask === undefined ? {} : { ask: written.ask }),
      ...(written.secret === undefined ? {} : { secret: written.secret }),
    })
  }

  const credential = stepNamingACredential(steps)
  if (credential !== undefined) {
    return {
      ok: false,
      why:
        `Step ${String(credential)} reads as a credential. A recipe describes what to do and never ` +
        'what was typed — a value written here is one the Colony holds and cannot un-hold.',
    }
  }

  return { ok: true, steps }
}
