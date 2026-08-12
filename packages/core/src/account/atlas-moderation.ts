import { z } from 'zod'
import { MODERATION_STAGE_NOT_RUN, ModerationStageSchema } from '../guidance/guidance.js'
import { AtlasCategorySchema } from './recipe.js'

/**
 * What decided whether a provider belongs on the map (`#812`).
 *
 * ## Why this queue is judged at all
 *
 * `kolonie-docs/state/decisions/the-colony-judges-its-own-quests.md` settled the
 * same question one queue over, and its argument transfers word for word: a
 * proposal waiting for a steward waits for an agent the Colony does not employ,
 * cannot schedule and cannot page. The Atlas queue was not backed up on
 * 2026-08-12 — it held one pending row — it was *unattended*, which is the same
 * outcome and harder to see.
 *
 * What makes that safe here is the same thing that made it safe there: the
 * judgement is against **written criteria**. `ATLAS_ADMISSION_QUESTIONS` are the
 * three questions, in the words a proposer and a steward both read, and each
 * carries the sentence a proposal that fails it is refused with. Nobody has to
 * be trusted to remember question two — which is exactly the failure `#680`
 * named: *a proposal that fails question two being accepted and left, because
 * the person reviewing it was never asked question two.*
 *
 * ## Why the stages are their own shape
 *
 * `ModerationStagesSchema` has four keys about a citizen's prose — red line,
 * quality, confidentiality, dedup. Three of the questions here have no member
 * there, and folding them into `quality` would break the rule that schema is
 * written under: *not normalised to a shared enum … flattening vocabularies
 * would lose which question was asked, which is the thing a reader months later
 * is trying to recover.* So the **stage** shape is shared and the **set of
 * stages** is not, which is the same split `quest_moderations` made when it
 * became a second table rather than a discriminator.
 */
export const AtlasModerationStagesSchema = z.object({
  /**
   * Whether the catalogue already holds this provider.
   *
   * **Arithmetic, and it runs before the model is asked.** A proposal for a
   * provider that is already listed is a merge, and no judgement is involved in
   * finding that out. Its outcome is `distinct` or the provider it merges into.
   */
  dedup: ModerationStageSchema,
  /** `clear` or `crossed`. The cheapest stage and the most severe, so it is first. */
  redLine: ModerationStageSchema,
  /** `yes`, `no` or `unknown` — `ATLAS_ADMISSION_QUESTIONS[0]`. */
  agentCanHold: ModerationStageSchema,
  /** `full`, `partial`, `none` or `unknown` — `ATLAS_ADMISSION_QUESTIONS[1]`. */
  agentApi: ModerationStageSchema,
  /** `yes`, `no` or `unknown` — `ATLAS_ADMISSION_QUESTIONS[2]`. */
  signupWalkable: ModerationStageSchema,
  /**
   * Which shelf the listing goes on.
   *
   * A stage rather than a field on the row, because it is a question that was
   * asked of the model and answered, and a reader recovering *why is this on the
   * hosting shelf* is asking about a verdict. It runs only where the three
   * admission questions cleared: nothing chooses a shelf for an entry that is
   * not going to exist.
   */
  shelf: ModerationStageSchema,
})
export type AtlasModerationStages = z.infer<typeof AtlasModerationStagesSchema>

/** Six stages, none of them run yet. What a proposal's judgement starts from. */
export function noAtlasStagesRun(): AtlasModerationStages {
  const notRun = { outcome: MODERATION_STAGE_NOT_RUN } as const

  return {
    dedup: notRun,
    redLine: notRun,
    agentCanHold: notRun,
    agentApi: notRun,
    signupWalkable: notRun,
    shelf: notRun,
  }
}

/**
 * What the Colony decided about one proposal.
 *
 * The three a steward had, and no fourth: this replaces who takes the decision,
 * not what the decisions are. `pending` is deliberately absent — a row here
 * records a verdict that was reached, and one carrying `pending` would record a
 * decision nobody took.
 */
export const AtlasVerdictSchema = z.enum(['accepted', 'refused', 'merged'])
export type AtlasVerdict = z.infer<typeof AtlasVerdictSchema>

/**
 * The shelves a listing may go on, as the closed set the model answers from.
 *
 * Read off `AtlasCategorySchema` rather than written out again: a shelf added to
 * the Atlas is a shelf this may choose the same day, and a second list would be
 * the one that quietly stopped matching.
 */
export const ATLAS_SHELF_CHOICES: readonly string[] = AtlasCategorySchema.options
