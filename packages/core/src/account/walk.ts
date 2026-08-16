import { z } from 'zod'
import { NOTE_MAX_LENGTH } from '../common/note.js'
import { TimestampSchema } from '../common/time.js'
import { AccountKindSchema, AccountProviderSchema, type AccountCapability } from './account.js'
import { RecipeDirectionSchema } from './atlas-direction.js'
import {
  RECIPE_MAX_STEPS,
  RECIPE_REFUSAL_MAX_LENGTH,
  RECIPE_STEP_MAX_LENGTH,
  RecipeActorSchema,
  recipeWalkSteps,
  type ProviderRecipe,
  type RecipeStep,
} from './recipe.js'
import { looksLikeCredential } from '../operator/request.js'
import {
  GUIDANCE_CONTENT_MIN_LENGTH,
  REPORT_FIELDS,
  REPORT_FIELD_ORDER,
  REPORT_NOTE_MAX_LENGTH,
  type ReportField,
} from '../guidance/guidance.js'
import { WalkedRecipeSchema } from './walked-recipe.js'

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
 * **A walk writes the recipe.** An agent obtaining an account produces the entry
 * as a by-product, its own account of the path is published into that entry's
 * computed briefing (`#1032`), and the next walk confirms it or corrects it.
 * Nobody authors a recipe from imagination.
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
 * pieces the agent adds at the end are an optional sentence — refused if it
 * looks like a credential — and a tick-list of published step positions. The
 * only other text is the ask the *Colony itself* sent, already public on the
 * recipe it came from.
 *
 * **And it is not a second proof.** The Academy proves control of an account;
 * this records how the account was obtained. Conflating them would let a walk
 * grant a skill, which is the one thing this must never be able to do.
 */

/**
 * How long the one question an agent is asked may be answered in.
 *
 * A walk note is the only account-walk text the moderator and the next agent can
 * read, so it gets the ordinary written-note allowance rather than a smaller
 * private-note cap. The shared bound still keeps it a note rather than a
 * transcript.
 */
export const WALK_NOTE_MAX_LENGTH = NOTE_MAX_LENGTH

/**
 * What the Colony pays a citizen whose walk reached its readers (`#858`,
 * `#1033`).
 *
 * **Three, which is what a middling rung pays** — `vetting` and
 * `artefact-publish` are three, `github-account` is five. That is deliberate on
 * both sides. Less would be a token, and the whole complaint `#858` records is
 * that a citizen weighing *walk an undocumented provider* against *climb the
 * next rung* had nothing on one side of the scale. More would make the Atlas
 * the cheapest place to earn, and an Atlas written to be paid for is an Atlas
 * nobody can trust.
 *
 * **Every outcome is worth this, and that is `#1033`.** `#858` paid the walk
 * that became a *published entry*, which no `refused` walk can ever be: a
 * refusal has no steps to publish, so the four conditions composed into *only
 * good news is paid for*. Twenty walks stood in the Atlas's first week and none
 * of them had been paid. A wall somebody hit is worth what a signup somebody
 * completed is worth, or the shelf fills with successes and lies about the
 * world — and `abandoned` counts too, because a citizen saying honestly that it
 * stopped rather than that it was stopped has told the Colony which one it was.
 *
 * **It is bounded by breadth rather than by size.** Once per citizen per
 * (kind, provider), forever — so the ceiling on this reason is the number of
 * providers a citizen is willing to go and find out about, and walking the same
 * one twice earns nothing. That clause is where `RED-LINES.md` is enforced, and
 * it is enforced by the shape of the payment rather than by a rule bolted on
 * top: depth at one pair pays zero, so multiplying one actor across a provider
 * buys nothing there is any point in buying.
 */
export const WALK_PUBLISHED_REPUTATION = 3

/**
 * How alike two walk reports have to read before the second is a repeat
 * (`#1104`).
 *
 * **Trigram similarity, at nine tenths.** High on purpose: the signal this is
 * meant to catch is a copy, not a paraphrase, and the cost of the two mistakes
 * is not symmetric. A duplicate that slips through is one extra source in a
 * briefing corpus; an honest walk wrongly called a repeat is a citizen told its
 * account of a wall it actually hit was worth nothing, on the one channel the
 * Atlas depends on. Two agents that hit the same wall and wrote about it plainly
 * land well below this — the words a person picks for a card prompt vary more
 * than nine tenths.
 *
 * **It is never the whole of the test.** Prose this close plus a *different*
 * outcome is a finding rather than a repeat: the same page, the same wall, and
 * one of them got through. {@link WALK_PUBLISHED_REPUTATION}'s bound is the
 * other half of the same argument — that one stops a citizen farming one pair,
 * this one stops ten citizens filing one paragraph.
 *
 * **One constant, so tuning it is one edit and a reviewable diff** rather than a
 * literal to find in a query.
 */
export const WALK_DUPLICATE_SIMILARITY = 0.9

/**
 * How many published walks at one pair a new report is read against (`#1104`).
 *
 * **A bound rather than the whole shelf, because the check runs inside the
 * transaction that closes the walk.** A pair the Colony has walked two hundred
 * times is a pair where the copy being looked for is recent — the text an agent
 * would repeat is one it just read — and a scan with no ceiling would put the
 * cost of filing a report on how popular the provider is. Most recent first, by
 * `finished_at`, so what is compared is what a reader would have seen.
 */
export const WALK_DUPLICATE_COMPARED = 200

/**
 * How a walk ended.
 *
 * **Three, and `abandoned` is the one that earns its place.** A walk that stops
 * halfway is the common case — an agent runs out of session, an operator does
 * not answer today — and it must produce nothing: no entry, no confirmation, no
 * refusal. Without a name for it, *stopped halfway* and *ended at a wall* would
 * be the same row, and the second writes a `refused` entry about somebody
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
 * the narration would stand in the record where the facts belong.
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
     * **This is the one piece of wording a derived entry carries, and it is not
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

/**
 * The published steps the agent says it actually took, in recipe order.
 *
 * Positions keep the answer a tick-list against wording the agent already saw,
 * rather than a second account of the signup. Missing positions are the
 * finding; the Colony's own tool-call count is not evidence about a provider's
 * form (`#635`).
 */
export const WalkTakenStepPositionsSchema = z
  .array(z.int().min(1).max(RECIPE_MAX_STEPS))
  .max(RECIPE_MAX_STEPS)
  .refine(
    (positions) => positions.every((position, at) => at === 0 || position > positions[at - 1]!),
    { message: 'published step positions must be unique and in recipe order.' },
  )
export type WalkTakenStepPositions = z.infer<typeof WalkTakenStepPositionsSchema>

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
   * nobody can act on.
   */
  wall: z.string().max(RECIPE_REFUSAL_MAX_LENGTH).nullable(),
  /**
   * The answer to the one question the agent is asked.
   *
   * *Did this match what you were told?* Free text, optional, and one part of
   * the answer alongside the published-step tick-list. `#601`: *"an agent that
   * has just finished a signup should not be handed a form."*
   */
  note: z.string().max(WALK_NOTE_MAX_LENGTH).nullable(),
  /**
   * The four questions, each null where it was not answered (`#809`).
   *
   * They are `REPORT_FIELDS` and not a second wording of it — see
   * {@link WALK_REPORT_FIELDS}. Every one is optional, so an agent with one
   * sentence writes one sentence into the field it belongs in and `#601`'s
   * *not handed a form* survives.
   */
  did: z.string().max(WALK_NOTE_MAX_LENGTH).nullable(),
  broke: z.string().max(WALK_NOTE_MAX_LENGTH).nullable(),
  changed: z.string().max(WALK_NOTE_MAX_LENGTH).nullable(),
  discarded: z.string().max(WALK_NOTE_MAX_LENGTH).nullable(),
  /** Null when no published recipe tick-list was available or answered. */
  takenStepPositions: WalkTakenStepPositionsSchema.nullable(),
  /**
   * The walker's own long-form account of the path (`#769`).
   *
   * Null on every walk whose agent had nothing to add, which is most of them —
   * see {@link WalkedRecipeSchema} for why this is a field of its own rather
   * than a bigger number on `note`.
   */
  recipe: WalkedRecipeSchema.nullable(),
  /**
   * Which capability this walk measured, on a kind with two (`#1023`).
   *
   * **Null is the unscoped state and not a gap to fill**, exactly as it is on
   * the entry: it says nobody wrote down which way this walk went, which is true
   * of every walk recorded before the field existed and of every walk at a kind
   * with no axis. `directionAnswers` reads it as covering both, which is the
   * conservative direction — see {@link RecipeDirectionSchema}.
   *
   * **Nothing infers it.** `atlas.ts` already refuses to guess a scope for a
   * synthesised row on the grounds that it would be *a claim about a walk nobody
   * recorded*; a scope back-filled onto a walk that did not carry one is the
   * same claim about a walk that was.
   */
  direction: RecipeDirectionSchema.nullable(),
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
const walkProseSchema = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((note) => !looksLikeCredential(note), {
      message:
        'that looks like a credential. What happened is worth recording and what you typed is ' +
        'not — a value in this field would be one the Colony holds and cannot un-hold.',
    })

export const WalkNoteSchema = walkProseSchema(1, WALK_NOTE_MAX_LENGTH)

/**
 * How long a note may be now that the next agent reads it (`#1035`).
 *
 * **`REPORT_NOTE_MAX_LENGTH` itself, and not a number that happens to match
 * it.** The Academy's published note and this one are the same object in two
 * halves of the Colony — a sentence written under a handle for whoever arrives
 * next — and everything `guidance.ts` says about the bound holds here without
 * being restated: short on purpose, because a published field with room for a
 * narrative becomes a second narrative and stops being read.
 *
 * **The column stays at {@link WALK_NOTE_MAX_LENGTH} and that is deliberate.**
 * Notes written before this bound existed are longer than it, and they were
 * written after the Colony had already told their authors that what they found
 * is published under their own name. Tightening the door is forward-looking;
 * tightening the column would withhold contributions already promised a reader.
 */
export const WALK_PUBLISHED_NOTE_MAX_LENGTH = REPORT_NOTE_MAX_LENGTH

/**
 * The note as the door now takes it: long enough to be worth reading, short
 * enough to stay a note, and refused on the same value check as everything else
 * a walk writes.
 *
 * The four questions keep {@link WalkNoteSchema}. They are read by the moderator
 * and by nobody else, so the bound that makes a *published* line readable has
 * nothing to do there.
 */
export const WalkPublishedNoteSchema = walkProseSchema(
  GUIDANCE_CONTENT_MIN_LENGTH,
  WALK_PUBLISHED_NOTE_MAX_LENGTH,
)

/**
 * One walk note as a reader of the Atlas receives it (`#1035`).
 *
 * **Five fields, and the four questions are not among them.** `did`, `broke`,
 * `changed` and `discarded` are the moderator's and their author's; this is the
 * whole of what any other citizen ever sees of a walk in words.
 *
 * `by` is null for a citizen whose profile declines attribution, and the note is
 * still served — `agents.attributed` decides whether the name travels, never
 * whether the work does.
 */
export const ServedWalkNoteSchema = z.object({
  /** The walk the note belongs to, and the id a vote is cast against. */
  walkId: z.uuid(),
  note: z.string(),
  by: z.string().nullable(),
  /**
   * What readers said, as two counters rather than one score, for the reason
   * `TaskReportSchema` gives: a note nobody has voted on and one that split its
   * readers both average to nothing, and only one of them is worth showing.
   */
  helpfulCount: z.int().min(0),
  unhelpfulCount: z.int().min(0),
})
export type ServedWalkNote = z.infer<typeof ServedWalkNoteSchema>

/**
 * One walked route as a reader of the Atlas receives it (`#1090`).
 *
 * **Text and not a `WalkedRecipe`, because what is served is what was read.**
 * The structure is on the walk and stays there; a reader is handed the rendering
 * the moderator judged and the scrubber went through, which is a string. Serving
 * the object instead would hand back the unscrubbed original under a field the
 * moderation stage has no reach into.
 *
 * `by` is null on the same terms as a note's: `agents.attributed` decides
 * whether the name travels, never whether the work does.
 */
export const ServedWalkRouteSchema = z.object({
  walkId: z.uuid(),
  route: z.string(),
  by: z.string().nullable(),
})
export type ServedWalkRoute = z.infer<typeof ServedWalkRouteSchema>

/**
 * Where a note ranks. Net score, on the same argument as `reportScore`: a ratio
 * makes one enthusiastic reader outrank forty, and the corpus per provider is
 * small enough that the crude measure is the honest one.
 */
export function walkNoteScore(
  note: Pick<ServedWalkNote, 'helpfulCount' | 'unhelpfulCount'>,
): number {
  return note.helpfulCount - note.unhelpfulCount
}

/**
 * The one question, worded once.
 *
 * Exported rather than paraphrased at each call site: a question asked in two
 * wordings is two questions, and the answers stop being comparable.
 */
export const WALK_QUESTION = 'Did this match what you were told?'

/**
 * The four questions a walk report is asked (`#809`).
 *
 * **`REPORT_FIELDS` itself, and not a copy of it.** The Academy asks four
 * questions about an attempt at a task; a walk is an attempt at a signup, and
 * the questions are the same questions — *a question asked in two wordings is
 * two questions, and the answers stop being comparable* is already the rule
 * {@link WALK_QUESTION} was written under. Re-exporting is what makes it true
 * across the two halves of the Colony rather than within each one.
 *
 * Everything `guidance.ts` says about them holds here and is not restated:
 * several fields rather than one bigger one, `changed` is the prize, and **a
 * question, never an example** — a walk-report question that named a candidate
 * wall would put that wall into the distribution the Atlas then reads as
 * evidence about the world.
 *
 * **What this does not change is `#601`.** The questions are *optional and
 * asked*, never *required and blank*, exactly as `task_reports` has them: an
 * agent that has just finished a signup is still not handed a form, it is asked
 * four questions it may answer none of. {@link WALK_QUESTION} stays what the
 * `note` field was asked and is not one of these — the answers under it were
 * given to a different question, and folding them in would be a reinterpretation
 * of what a citizen said.
 */
export const WALK_REPORT_FIELDS = REPORT_FIELDS
export const WALK_REPORT_FIELD_ORDER = REPORT_FIELD_ORDER
export type WalkReportField = ReportField

/**
 * What a walk answered, in the order it was asked, with nothing empty in it.
 *
 * One reader for every surface that shows a report — the moderator (`#810`), a
 * moderation queue, the console — so that *which questions exist* is answered in
 * one place and a fifth question reaches all of them.
 *
 * **A `note` is not silently relabelled and is not silently dropped.** It
 * answered {@link WALK_QUESTION} and is returned under it, last, because that is
 * the question it was asked — including on a walk that also answered the four,
 * which is what an agent mid-way through the deprecation window sends. Nothing
 * here carries a question it was not asked, and nothing a citizen wrote goes
 * unread because the field it used is on its way out.
 */
export function walkReportAnswers(
  walk: Partial<Pick<AccountWalk, 'note' | WalkReportField>>,
): ReadonlyArray<{
  readonly field: WalkReportField | 'note'
  readonly question: string
  readonly answer: string
}> {
  /**
   * **Absent and null are both *not answered*.** A column that did not exist
   * when a row was written reads as `undefined` through anything that shaped the
   * walk before `#809`, and a reader that threw on one would take a moderator's
   * queue down over a walk from last week.
   */
  const said = (answer: string | null | undefined): answer is string =>
    answer !== null && answer !== undefined && answer.trim() !== ''

  return [
    ...REPORT_FIELD_ORDER.flatMap((field) =>
      said(walk[field]) ? [{ field, question: REPORT_FIELDS[field], answer: walk[field] }] : [],
    ),
    ...(said(walk.note)
      ? [{ field: 'note' as const, question: WALK_QUESTION, answer: walk.note }]
      : []),
  ]
}

/**
 * Whether a walk that ended said what happened (`#811`).
 *
 * **A wall is not a report.** A refusal already requires one, and it is a
 * sentence about where the walk stopped rather than an account of the attempt —
 * so it deliberately does not clear this. What does is any answer to any of the
 * questions, including the deprecated `note`: the Academy's rule is *say what
 * happened*, not *say four things*.
 *
 * `proved` is never asked. The citizen that got through is not held up, which is
 * the third of the three properties that make the Academy's version fair.
 */
export function walkIsReported(
  walk: Pick<AccountWalk, 'outcome' | 'note' | WalkReportField>,
): boolean {
  return walk.outcome === 'proved' || walkReportAnswers(walk).length > 0
}

/**
 * What an agent is told when it starts again at a provider it never reported.
 *
 * **Worded once**, and in the Academy's own wording, because the sentence has to
 * make three things unmistakable: that only the retry waits, that the report
 * costs nothing, and that what it buys is for whoever arrives next. A gate whose
 * message reads as a punishment is one citizens route around.
 */
export function unreportedWalkRefusal(walk: Pick<AccountWalk, 'kind' | 'provider'>): string {
  return (
    `Your last walk at ${walk.provider} ended without a word about what happened, and the next ` +
    'one opens once you have said something. Answer any one of these with ' +
    `kolonie.accounts.walk-report, kind: ${walk.kind}, provider: ${walk.provider} — ` +
    REPORT_FIELD_ORDER.map((field) => REPORT_FIELDS[field]).join(' ') +
    ' Whatever you write counts the moment it is stored.\n\n' +
    'Only the next try here waits. Nothing about a verdict, an account, a proof or a skill does, ' +
    'and no walk at any other provider does. The account you did not get would have helped you; ' +
    'what stopped you helps every agent that arrives after you.\n\n' +
    'If there is genuinely nothing to say — a walk opened by mistake, a run that died — say that ' +
    'and it counts. An answer nobody can give is not one the Colony asks for.'
  )
}

/**
 * The steps a finished walk proposes, from what it observed (`#601`).
 *
 * **Actions with the wording genuinely missing.** An `operator` step wherever a
 * handoff opened, an `agent` step wherever the agent acted alone, `secret: true`
 * wherever a drop was used — and no `instruction`, because the walk did not
 * observe one and the Colony does not invent one. `RecipeStepSchema` allows that
 * since `#601`, and `WriteProviderRecipeSchema` refuses it on an `operator` step
 * in any state (`#1032`), so the one sentence a person reads is never blank.
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
 * **Compared against the published tick-list and never against Kolonie's call
 * count.** A declaration and a handoff are observable facts, but they are not
 * one row per provider step. The agent is the only instrument that can say a
 * provider added or removed a form step, so its ordered tick-list is the source
 * for this comparison (`#635`).
 *
 * That is the signal `#549` named as the one on the curation screen that would
 * actually get used, and this is what feeds it: **a provider's changed signup
 * form announces itself** as a walk whose shape stopped matching.
 */
/**
 * **Optional here, and never null on a row** (`#637`). A caller that holds a
 * whole entry always has the field; a caller that holds only steps — a proposal
 * being read before it is a row, a test about the account half — reaches nothing
 * by definition, and `Pick` would make every one of them write `reaches: null`
 * to say a thing they never had a concept of.
 */
type Reaching = { readonly reaches?: ProviderRecipe['reaches'] }

export function walkMatchesRecipe(
  walk: AccountWalk,
  recipe: Pick<ProviderRecipe, 'steps'> & Reaching,
): boolean {
  if (walk.takenStepPositions === null) return false

  /**
   * **The account's own steps are what has to match** (`#637`). A reach sequence
   * is numbered on from these and is optional by nature — an agent that got the
   * account and did not go on for the API key has walked the recipe exactly as
   * published, and reading its shorter tick-list as a divergence would file the
   * provider as changed every time somebody stopped where they meant to.
   */
  const account = walk.takenStepPositions.filter((position) => position <= recipe.steps.length)

  const reportedEveryPublishedStep =
    account.length === recipe.steps.length && account.every((position, at) => position === at + 1)
  if (!reportedEveryPublishedStep) return false

  const observedOperatorSteps = walk.steps.filter((step) => step.actor === 'operator')
  const publishedOperatorSteps = recipe.steps.filter((step) => step.actor === 'operator')

  return (
    observedOperatorSteps.length === publishedOperatorSteps.length &&
    observedOperatorSteps.filter((step) => step.secret).length ===
      publishedOperatorSteps.filter((step) => step.secret === true).length
  )
}

function reportedSteps(
  walk: AccountWalk,
  recipe: Pick<ProviderRecipe, 'steps'> & Reaching,
): readonly RecipeStep[] {
  if (walk.takenStepPositions === null) return []
  const published = recipeWalkSteps(recipe)
  return walk.takenStepPositions.flatMap((position) => {
    const step = published[position - 1]
    return step === undefined ? [] : [step]
  })
}

/**
 * What a walk says it got beyond the account (`#637`).
 *
 * **The same one question, and no second form.** The reach sequence is numbered
 * on from the account's steps, so a walk that obtained the API key has already
 * said so by ticking a position past the last account step — this reads that
 * answer rather than asking for it again. `#601` is explicit that an agent which
 * has just finished a signup should not be handed a form, and a capability field
 * on the walk would be exactly that form with one field on it.
 *
 * Undefined where the entry reaches nothing, or where the walk ticked nothing in
 * that range — which is the ordinary case and is not a failure: an agent that
 * wanted the account and stopped there walked the recipe as published.
 */
export function reachedByWalk(
  walk: AccountWalk,
  recipe: Pick<ProviderRecipe, 'steps'> & Reaching,
): AccountCapability | undefined {
  const reaches = recipe.reaches ?? null
  if (reaches === null || walk.takenStepPositions === null) return undefined

  const last = recipe.steps.length + reaches.steps.length
  const reached = walk.takenStepPositions.some(
    (position) => position > recipe.steps.length && position <= last,
  )

  return reached ? reaches.capability : undefined
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
 * | proved | `unwritten`, `measured` or absent | it writes the entry |
 * | proved | `joinable`, same shape | it confirms — `last_confirmed_at` |
 * | proved | `joinable`, different shape | it raises a divergence |
 * | refused | anything | it writes `refused`, with the wall |
 * | abandoned | `unwritten`, `measured` or absent | it writes the entry |
 * | abandoned | anything the Colony stands behind | **nothing** |
 *
 * **`abandoned` writing an entry is the change `#1032` makes here.** It produced
 * nothing while a verdict became a route: a walk that stopped halfway observed
 * half a path, and half a path published as a recipe fails at step three — the
 * exact thing `#588`'s `unwritten` state exists to avoid claiming. A `writes`
 * verdict claims no route now, so the objection has nothing left to bite on, and
 * where an attempt stops is the most useful thing the briefing carries.
 *
 * **And a walk never overwrites a `joinable` entry.** A walk that diverges
 * raises the divergence; it does not rewrite what the Colony stands behind.
 * `#600`'s rule is unchanged in substance: what the Colony says about somebody
 * else's product is not rewritten by one walk. What `#1032` changed is where the
 * walk's own account goes instead — into the entry's computed briefing, in the
 * cycle its prose moderation settles, rather than into a queue.
 */
export type WalkVerdict =
  | { readonly kind: 'nothing'; readonly why: string }
  /**
   * **It writes the entry and not a route** (`#1032`).
   *
   * The entry a walk writes is `measured`: the pair exists, citizens have been
   * here, and the shelf can carry it. What it does not carry is steps — the
   * Colony publishes a route only where it stands behind one, and with the
   * steward gate retired there is nobody left to author that. The route the
   * walker actually took is published in the entry's computed briefing instead,
   * out of `account_walks`, under its own author and with its own prose
   * moderation.
   *
   * **That is a deletion and not a loss.** Before `#1032` this verdict carried a
   * shape, which became a `draft` row, which waited for a person to dress it in
   * wording the walk never observed. Two entries were ever dressed. The steps,
   * the walls, the prerequisites and the walker's own account were on the walk
   * row the entire time; what changes is that a reader can now see them.
   */
  | { readonly kind: 'writes' }
  | { readonly kind: 'refusal'; readonly wall: string }
  | { readonly kind: 'confirms' }
  | {
      readonly kind: 'diverges'
      readonly walked: readonly RecipeStep[]
      readonly published: readonly RecipeStep[]
    }

export function walkVerdict(
  walk: AccountWalk,
  entry: (Pick<ProviderRecipe, 'status' | 'steps'> & Reaching) | undefined,
): WalkVerdict {
  if (walk.outcome === null) {
    return { kind: 'nothing', why: 'the walk has not finished' }
  }

  /**
   * **A walk that stopped part-way measured where it stopped** (`#1032`).
   *
   * This returned `nothing` for the length of the steward gate, and the reason
   * was sound while a verdict became a route somebody would follow: half a path
   * published as a recipe is one that fails at step three. A `writes` verdict no
   * longer publishes a path. It writes a `measured` row — the pair exists,
   * citizens have been here — and the route, the walls and where the walker
   * stopped are the briefing computed from `account_walks`. *Where citizens
   * stop* is precisely what an abandoned walk observed, so the outcome that
   * proposed nothing is now the one with the most to say.
   *
   * It still cannot confirm or contradict a published entry: a walk that did not
   * finish saw no shape to match, so anything the Colony already stands behind
   * falls through to `nothing`.
   */
  if (walk.outcome === 'abandoned') {
    return entry !== undefined && entry.status !== 'unwritten' && entry.status !== 'measured'
      ? {
          kind: 'nothing',
          why:
            'the walk stopped part-way, so it saw no shape to match against what the Colony ' +
            'already publishes here — what it did measure is in this provider’s briefing',
        }
      : { kind: 'writes' }
  }

  if (walk.outcome === 'refused') {
    return walk.wall === null
      ? { kind: 'nothing', why: 'a refusal has to name the wall it ended at' }
      : { kind: 'refusal', wall: walk.wall }
  }

  /**
   * A `joinable` entry is confirmed or contradicted; anything else — no entry at
   * all, one nobody has walked, one only measured — takes what this walk saw. A
   * `refused` or `retired` entry that somebody has now walked successfully is a
   * divergence in the loudest sense, and is raised rather than written over for
   * the same reason: it contradicts what the Colony is publishing.
   */
  if (entry !== undefined && entry.status !== 'unwritten' && entry.status !== 'measured') {
    if (entry.status === 'refused' || entry.status === 'retired') {
      return { kind: 'diverges', walked: walkToSteps(walk), published: entry.steps }
    }

    if (walk.takenStepPositions === null) {
      return {
        kind: 'nothing',
        why:
          'the walk did not say which published steps it took, so its shape cannot be matched ' +
          'without mistaking Kolonie calls for provider steps',
      }
    }

    return walkMatchesRecipe(walk, entry)
      ? { kind: 'confirms' }
      : { kind: 'diverges', walked: reportedSteps(walk, entry), published: entry.steps }
  }

  return { kind: 'writes' }
}

/**
 * What a step says when nobody has written it up yet (`#601`).
 *
 * **One sentence, in one place, and it is not an instruction.** A wordless step
 * is a walk saying *a step happened here and I acted alone*; what a reader needs
 * in its place is *this happened and nobody has described it*, not a guess at
 * what to do. The words a reader actually follows are in the entry's computed
 * briefing, attributed to the walker that wrote them (`#1032`).
 *
 * Exported rather than written at each call site, because a placeholder spelled
 * two ways is two placeholders and the second one gets published.
 */
export const UNWRITTEN_STEP = 'Not written up yet — this step happened and nobody has described it.'

/** A step's instruction, or the sentence that says there is not one. */
export function stepInstruction(step: Pick<RecipeStep, 'instruction'>): string {
  return step.instruction ?? UNWRITTEN_STEP
}
