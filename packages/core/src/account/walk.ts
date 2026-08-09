import { z } from 'zod'
import { NOTE_MAX_LENGTH } from '../common/note.js'
import { TimestampSchema } from '../common/time.js'
import { AccountKindSchema, AccountProviderSchema } from './account.js'
import {
  RECIPE_MAX_STEPS,
  RECIPE_REFUSAL_MAX_LENGTH,
  RECIPE_STEP_MAX_LENGTH,
  RecipeActorSchema,
  type ProviderRecipe,
  type RecipeStep,
} from './recipe.js'
import { looksLikeCredential } from '../operator/request.js'

/**
 * One agent obtaining one account, as a record (`#601`).
 *
 * ## Why this exists
 *
 * On 2026-08-08 an agent and its operator walked the `github.com` recipe end to
 * end. It was the first real one, and **everything learned from it exists as
 * four GitHub issues and nothing reached the entry.** A second agent walking it
 * the next day would have met exactly the same three defects and filed three
 * more issues.
 *
 * The maintainer's words the same day: *"die Rezepte müssen in der
 * Zusammenarbeit mit den Agenten entstehen — wenn ich jetzt mit einem Agenten so
 * einen Account durchgehe, muss das eigentlich aufgezeichnet werden."*
 *
 * **A walk writes the recipe.** An agent obtaining an account produces a draft
 * entry as a by-product, a steward edits and publishes it, and the next walk
 * confirms it or corrects it. Nobody authors a recipe from imagination.
 *
 * ## Why it is one record and not four tables that happen to agree
 *
 * `accounts.handoff`, the operator's answer, `accounts.declare` and the proof
 * each already touch their own table. Together they *are* the walk — which steps
 * happened, in which order, which needed a person, how long each took, where it
 * stopped — and nothing held that. Reconstructing it afterwards by joining on
 * timestamps would be a guess dressed as a record.
 *
 * ## What is recorded, and what is refused
 *
 * **The shape of the walk and never its contents.** `#601` is explicit:
 *
 * > Not surveillance of the agent. What is recorded is the shape of the walk —
 * > which steps, which needed a person, where it stopped. Not what was typed,
 * > not what came back, and never anything from a sealed drop.
 *
 * So a step carries an actor, whether a sealed channel was used, and when. It
 * carries **no value**: not the handle, not the code, not the password. The one
 * piece of text on the whole record is the ask the *Colony itself* sent, which
 * is already public on the recipe it came from, and the one optional sentence
 * the agent writes at the end — which is refused if it looks like a credential.
 *
 * **And it is not a second proof.** The Academy proves control of an account;
 * this records how the account was obtained. Conflating them would let a walk
 * grant a skill, which is the one thing this must never be able to do.
 */

/**
 * How long the one question an agent is asked may be answered in.
 *
 * A walk note is the only account-walk text a steward and the next agent can
 * read, so it gets the ordinary written-note allowance rather than a smaller
 * private-note cap. The shared bound still keeps it a note rather than a
 * transcript.
 */
export const WALK_NOTE_MAX_LENGTH = NOTE_MAX_LENGTH

/**
 * How a walk ended.
 *
 * **Three, and `abandoned` is the one that earns its place.** A walk that stops
 * halfway is the common case — an agent runs out of session, an operator does
 * not answer today — and it must produce nothing: no draft, no confirmation, no
 * refusal. Without a name for it, *stopped halfway* and *ended at a wall* would
 * be the same row, and the second proposes a `refused` entry about somebody
 * else's product.
 */
export const WalkOutcomeSchema = z.enum(['proved', 'refused', 'abandoned'])
export type WalkOutcome = z.infer<typeof WalkOutcomeSchema>

/**
 * One thing that happened during a walk.
 *
 * **Observed, never described.** Each of these is written by the Colony at the
 * moment it happens — a handoff opening, a drop being used, an account being
 * declared — rather than reported by the agent afterwards. An agent that had to
 * narrate its own walk would be filling in a form, which `#601` refuses, and
 * the narration would be the thing a steward reviews instead of the facts.
 */
export const WalkStepSchema = z
  .object({
    /** 1-based, and the order things actually happened in. */
    position: z.int().min(1).max(RECIPE_MAX_STEPS),
    actor: RecipeActorSchema,
    /**
     * Whether a sealed drop carried the answer (`#529`).
     *
     * The fact that one was used, and nothing about what was in it. The Colony
     * cannot read a drop back out and this must not become the place it can.
     */
    secret: z.boolean(),
    /**
     * The ask the Colony sent, on an operator step.
     *
     * **This is the one piece of wording a derived draft carries, and it is not
     * invented** — it is the sentence that actually went to the operator,
     * recorded when it was sent. `#517` keeps the operator's sentence the
     * Colony's; this carries the Colony's own words forward rather than
     * composing new ones.
     */
    ask: z.string().trim().min(1).max(RECIPE_STEP_MAX_LENGTH).optional(),
    at: TimestampSchema,
  })
  .strict()
  .refine((step) => step.actor === 'operator' || step.ask === undefined, {
    message: 'an agent step has nobody to ask.',
    path: ['ask'],
  })
  .refine((step) => step.actor === 'operator' || !step.secret, {
    message: 'only an operator step can carry a sealed answer.',
    path: ['secret'],
  })
export type WalkStep = z.infer<typeof WalkStepSchema>

/** One walk, whole. */
export const AccountWalkSchema = z.object({
  id: z.uuid(),
  agentId: z.uuid(),
  kind: AccountKindSchema,
  provider: AccountProviderSchema,
  startedAt: TimestampSchema,
  /** Null while it is still running. */
  finishedAt: TimestampSchema.nullable(),
  /** Null while it is still running. */
  outcome: WalkOutcomeSchema.nullable(),
  /**
   * The wall it ended at, when it ended at one.
   *
   * Required on `refused` and refused otherwise, the same pair as
   * `refusal`/`status` on the entry itself: a dead end nobody described is one
   * a steward cannot act on.
   */
  wall: z.string().max(RECIPE_REFUSAL_MAX_LENGTH).nullable(),
  /**
   * The answer to the one question the agent is asked.
   *
   * *Did this match what you were told?* Free text, optional, and the only
   * thing on this record the agent writes. `#601`: *"an agent that has just
   * finished a signup should not be handed a form."*
   */
  note: z.string().max(WALK_NOTE_MAX_LENGTH).nullable(),
  steps: z.array(WalkStepSchema).max(RECIPE_MAX_STEPS),
})
export type AccountWalk = z.infer<typeof AccountWalkSchema>

/**
 * What an agent may say at the end, and what is refused.
 *
 * **A value check and not a check on the words about one**, which is the same
 * shape `RecipeStepSchema` uses for an ask and for the same reason: a word-level
 * test refuses the sentence that gets this right. *"I chose the password myself
 * and did not send it"* is exactly the report the Colony wants and trips any
 * test looking for a secret noun beside a verb.
 */
export const WalkNoteSchema = z
  .string()
  .trim()
  .min(1)
  .max(WALK_NOTE_MAX_LENGTH)
  .refine((note) => !looksLikeCredential(note), {
    message:
      'that looks like a credential. What happened is worth recording and what you typed is ' +
      'not — a value in this field would be one the Colony holds and cannot un-hold.',
  })

/**
 * The one question, worded once.
 *
 * Exported rather than paraphrased at each call site: a question asked in two
 * wordings is two questions, and the answers stop being comparable.
 */
export const WALK_QUESTION = 'Did this match what you were told?'

/**
 * The steps a finished walk proposes, from what it observed (`#601`).
 *
 * **Actions with the wording genuinely missing.** An `operator` step wherever a
 * handoff opened, an `agent` step wherever the agent acted alone, `secret: true`
 * wherever a drop was used — and no `instruction`, because the walk did not
 * observe one and the Colony does not invent one. `RecipeStepSchema` allows that
 * since `#601`, and `WriteProviderRecipeSchema` refuses it on anything but a
 * draft, so a wordless step cannot survive publication.
 *
 * **The ask is carried forward and is the exception that proves the rule.** It
 * is the sentence the Colony itself sent, recorded when it was sent — real,
 * already public on the recipe it came from, and the operator step's shape
 * requires one. Nothing else on the step is text.
 */
export function walkToSteps(walk: AccountWalk): readonly RecipeStep[] {
  return [...walk.steps]
    .sort((one, two) => one.position - two.position)
    .map((step) => ({
      actor: step.actor,
      ...(step.ask === undefined ? {} : { ask: step.ask }),
      ...(step.secret ? { secret: true } : {}),
    }))
}

/**
 * Whether a walk went the way the entry says it goes.
 *
 * **Compared on shape and never on wording** — who acted, in what order, through
 * which channel. A walk cannot disagree with an instruction it never read, and
 * comparing text would make every reworded step look like a provider changing
 * its signup form.
 *
 * That is the signal `#549` named as the one on the curation screen that would
 * actually get used, and this is what feeds it: **a provider's changed signup
 * form announces itself** as a walk whose shape stopped matching.
 */
export function walkMatchesRecipe(
  walk: AccountWalk,
  recipe: Pick<ProviderRecipe, 'steps'>,
): boolean {
  const walked = walkToSteps(walk)
  if (walked.length !== recipe.steps.length) return false

  return walked.every((step, at) => {
    const published = recipe.steps[at]

    return (
      published !== undefined &&
      published.actor === step.actor &&
      (published.secret ?? false) === (step.secret ?? false)
    )
  })
}

/**
 * What a finished walk should do to the catalogue.
 *
 * **One function, so no caller can decide differently.** The four outcomes are
 * the whole of `#601`'s middle section, and each is a different thing happening
 * to a different state of entry:
 *
 * | The walk | The entry | What happens |
 * |---|---|---|
 * | proved | `unwritten` or absent | it proposes a `draft` |
 * | proved | `joinable`, same shape | it confirms — `last_confirmed_at` |
 * | proved | `joinable`, different shape | it raises a divergence for a steward |
 * | refused | anything | it proposes `refused`, with the wall |
 * | abandoned | anything | **nothing** |
 *
 * **`abandoned` producing nothing is the rejection case worth naming.** A walk
 * that stopped halfway has observed half a path, and half a path published as a
 * draft is a recipe that fails at step three — the exact thing `#588`'s
 * `unwritten` state exists to avoid claiming.
 *
 * **And a draft against a published entry is never proposed.** A walk that
 * diverges raises the divergence; it does not overwrite what a steward
 * published. `#600`'s rule is unchanged: what the Colony says about somebody
 * else's product passes a person.
 */
export type WalkVerdict =
  | { readonly kind: 'nothing'; readonly why: string }
  | { readonly kind: 'draft'; readonly steps: readonly RecipeStep[] }
  | { readonly kind: 'refusal'; readonly wall: string }
  | { readonly kind: 'confirms' }
  | {
      readonly kind: 'diverges'
      readonly walked: readonly RecipeStep[]
      readonly published: readonly RecipeStep[]
    }

export function walkVerdict(
  walk: AccountWalk,
  entry: Pick<ProviderRecipe, 'status' | 'steps'> | undefined,
): WalkVerdict {
  if (walk.outcome === null) {
    return { kind: 'nothing', why: 'the walk has not finished' }
  }

  if (walk.outcome === 'abandoned') {
    return {
      kind: 'nothing',
      why:
        'the walk stopped part-way, so what it saw is half a path — and half a path published ' +
        'as a recipe is one that fails at step three',
    }
  }

  if (walk.outcome === 'refused') {
    return walk.wall === null
      ? { kind: 'nothing', why: 'a refusal has to name the wall it ended at' }
      : { kind: 'refusal', wall: walk.wall }
  }

  if (walk.steps.length === 0) {
    return { kind: 'nothing', why: 'nothing was observed, so there is nothing to propose' }
  }

  /**
   * A published entry is confirmed or contradicted; anything else — no entry at
   * all, one nobody has walked, one still in draft — takes the draft this walk
   * produced. A `refused` or `retired` entry that somebody has now walked
   * successfully is a divergence in the loudest sense, and goes to a steward for
   * the same reason: it contradicts what the Colony is publishing.
   */
  if (entry !== undefined && entry.status !== 'unwritten' && entry.status !== 'draft') {
    return walkMatchesRecipe(walk, entry)
      ? { kind: 'confirms' }
      : { kind: 'diverges', walked: walkToSteps(walk), published: entry.steps }
  }

  return { kind: 'draft', steps: walkToSteps(walk) }
}

/**
 * What a step says when nobody has written it up yet (`#601`).
 *
 * **One sentence, in one place, and it is not an instruction.** A wordless step
 * only exists on a `draft`, which reaches no public surface (`#604`) — so the
 * readers of this are the console and a steward's screen, and what they need is
 * *this happened and nobody has described it*, not a guess at what to do.
 *
 * Exported rather than written at each call site, because a placeholder spelled
 * two ways is two placeholders and the second one gets published.
 */
export const UNWRITTEN_STEP = 'Not written up yet — this step happened and nobody has described it.'

/** A step's instruction, or the sentence that says there is not one. */
export function stepInstruction(step: Pick<RecipeStep, 'instruction'>): string {
  return step.instruction ?? UNWRITTEN_STEP
}
