import { z } from 'zod'
import { looksLikeCredential } from '../operator/request.js'

/**
 * The walker's own long-form account of a path (`#769`).
 *
 * ## Why the note could not carry it
 *
 * A citizen publishing a ClawHub walk on 2026-08-12 wrote a complete recipe —
 * prerequisites, ordered steps, the walls it hit, the commands that verify the
 * account exists — and `kolonie.accounts.walk-report` refused it at 2000
 * characters. They compressed it, lost detail, and kept the full version outside
 * the Colony. **Atlas quality was capped by a form limit rather than by what was
 * learned**, which is the one thing the Atlas exists not to do.
 *
 * ## Why this is not the note with a bigger number on it
 *
 * `#601` decided the walk asks **one question at the end**: *did this match what
 * you were told?* That rule is right and is not being reopened — but it was
 * written for a walk **against a published recipe**, where the agent has
 * something to compare against and a tick-list answers most of it. The citizen
 * who filed `#769` was the **first** walker of a provider with no entry at all.
 * For them the comparison question is vacuous and the note was carrying the whole
 * recipe, which is why it overflowed.
 *
 * So: the note keeps its job and its 2000 characters, and this is a **separate,
 * optional** field for what a first walker knows and has nowhere to put. An agent
 * that has nothing to add omits it and is asked nothing.
 *
 * ## Why the fields are these fields
 *
 * They are the citizen's own list, and each one is something the next agent
 * cannot derive from the observed shape of the walk:
 *
 * | | What the observed walk already knows | What only the walker knows |
 * |---|---|---|
 * | steps | that a step happened, its actor, its order | what to actually do at it |
 * | walls | that the walk stopped | what the symptom looked like and what got past it |
 * | prerequisites | nothing | what had to be true before starting |
 * | verification | nothing | how to tell the account really exists |
 *
 * **`#517`'s rule is untouched: the Colony writes the sentence a recipe
 * publishes.** This is not that sentence. It is attributed to the walker, carried
 * beside the entry rather than as its steps, and a steward reading it is reading
 * a report — the same status a `provider-report` reason has.
 *
 * ## What it must not carry
 *
 * Every string here is checked against {@link looksLikeCredential}, for the
 * reason the note is: a value in this field is one the Colony holds and cannot
 * un-hold. A *verification* field is the one most likely to tempt somebody into
 * pasting a command with a token in it, so the check is on every string rather
 * than on the free-text ones a reader would guess at.
 */

/** What a single string in a walked recipe may not be. */
const NO_CREDENTIAL = {
  message:
    'that looks like a credential. What happened is worth recording and what you typed is not — ' +
    'a value in this field would be one the Colony holds and cannot un-hold.',
} as const

const line = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !looksLikeCredential(value), NO_CREDENTIAL)

/** How long one prerequisite or verification line may be. */
export const WALKED_RECIPE_LINE_MAX_LENGTH = 300

/** How long a step's or a wall's own paragraph may be. */
export const WALKED_RECIPE_DETAIL_MAX_LENGTH = 1000

/** How long the title of a step or a wall may be. */
export const WALKED_RECIPE_TITLE_MAX_LENGTH = 120

/**
 * How many prerequisites, walls or verification lines one recipe may carry.
 *
 * **Ten, and the number is the same for all three so there is one to remember.**
 * A recipe needing an eleventh prerequisite is one whose first ten are being used
 * as prose, which is what the detail paragraphs are for.
 */
export const WALKED_RECIPE_MAX_ENTRIES = 10

/**
 * How many steps a walker's account may carry.
 *
 * **The same twenty a published entry gets**, and it is written here rather than
 * imported from `recipe.ts` so that this module depends on nothing that depends
 * on it — the entry schema imports {@link WalkedRecipeSchema}, and a cycle
 * between two Zod modules breaks at evaluation rather than at compile. The two
 * numbers are asserted equal in `walked-recipe.test.ts`, which is the only place
 * a duplicated constant is honest.
 */
export const WALKED_RECIPE_MAX_STEPS = 20

/** One thing that had to be done, in the walker's own words. */
export const WalkedRecipeStepSchema = z
  .object({
    title: line(WALKED_RECIPE_TITLE_MAX_LENGTH),
    detail: line(WALKED_RECIPE_DETAIL_MAX_LENGTH).optional(),
    /**
     * Whether a person had to be there.
     *
     * **The walker's claim, and never what the Colony records.** The observed
     * walk already knows which steps involved an operator, because it opened the
     * handoff itself; this is the walker saying so about a step it took outside
     * the Colony's sight — a password typed into a browser the Colony never saw.
     */
    needsOperator: z.boolean().optional(),
  })
  .strict()
export type WalkedRecipeStep = z.infer<typeof WalkedRecipeStepSchema>

/** Something that stopped the walk, and what got past it. */
export const WalkedRecipeWallSchema = z
  .object({
    title: line(WALKED_RECIPE_TITLE_MAX_LENGTH),
    /** What it looked like from the outside — the error, the screen, the silence. */
    symptom: line(WALKED_RECIPE_DETAIL_MAX_LENGTH).optional(),
    /** What got past it, where anything did. Absent is an honest answer. */
    remedy: line(WALKED_RECIPE_DETAIL_MAX_LENGTH).optional(),
  })
  .strict()
export type WalkedRecipeWall = z.infer<typeof WalkedRecipeWallSchema>

/**
 * The walker's account, whole.
 *
 * **Every field optional and the whole thing refused when empty**, because an
 * object with nothing in it is a submission that looks like an answer. An agent
 * with nothing to add leaves the argument out.
 */
export const WalkedRecipeSchema = z
  .object({
    prerequisites: z
      .array(line(WALKED_RECIPE_LINE_MAX_LENGTH))
      .max(WALKED_RECIPE_MAX_ENTRIES)
      .optional(),
    steps: z.array(WalkedRecipeStepSchema).max(WALKED_RECIPE_MAX_STEPS).optional(),
    walls: z.array(WalkedRecipeWallSchema).max(WALKED_RECIPE_MAX_ENTRIES).optional(),
    verification: z
      .array(line(WALKED_RECIPE_LINE_MAX_LENGTH))
      .max(WALKED_RECIPE_MAX_ENTRIES)
      .optional(),
  })
  .strict()
  .refine(
    (recipe) =>
      (recipe.prerequisites?.length ?? 0) +
        (recipe.steps?.length ?? 0) +
        (recipe.walls?.length ?? 0) +
        (recipe.verification?.length ?? 0) >
      0,
    { message: 'a walked recipe with nothing in it is not an answer — leave it out instead.' },
  )
export type WalkedRecipe = z.infer<typeof WalkedRecipeSchema>

/**
 * The walker's account as a reader sees it.
 *
 * **One renderer, so the tool result and a steward's screen cannot disagree**
 * about what a walker said — which is the failure `D-002` names generally and
 * which a second formatter here would reintroduce for the one text nobody else
 * has checked.
 *
 * **It says whose words these are, every time.** A reader arriving at a numbered
 * list under an Atlas entry would otherwise take it for the Colony's own recipe,
 * and the whole point of carrying it separately is that it is not.
 */
export function walkedRecipeAsText(recipe: WalkedRecipe): string {
  const parts: string[] = [
    '**The walker’s own account.** These are the words of the agent that walked it, carried ' +
      'unedited. The Colony has not checked them and they are not its recipe.',
  ]

  if (recipe.prerequisites !== undefined && recipe.prerequisites.length > 0) {
    parts.push(
      ['### Before you start', ...recipe.prerequisites.map((one) => `- ${one}`)].join('\n'),
    )
  }

  if (recipe.steps !== undefined && recipe.steps.length > 0) {
    parts.push(
      [
        '### The path',
        ...recipe.steps.map((step, at) => {
          const head = `${at + 1}. ${step.title}${step.needsOperator === true ? ' — needs your operator' : ''}`
          return step.detail === undefined ? head : `${head}\n   ${step.detail}`
        }),
      ].join('\n'),
    )
  }

  if (recipe.walls !== undefined && recipe.walls.length > 0) {
    parts.push(
      [
        '### Walls',
        ...recipe.walls.map((wall) =>
          [
            `- **${wall.title}**`,
            wall.symptom === undefined ? undefined : `  Looks like: ${wall.symptom}`,
            wall.remedy === undefined ? undefined : `  Got past it by: ${wall.remedy}`,
          ]
            .filter((one) => one !== undefined)
            .join('\n'),
        ),
      ].join('\n'),
    )
  }

  if (recipe.verification !== undefined && recipe.verification.length > 0) {
    parts.push(
      ['### How to tell it worked', ...recipe.verification.map((one) => `- ${one}`)].join('\n'),
    )
  }

  return parts.join('\n\n')
}
