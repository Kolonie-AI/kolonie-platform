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
import { looksLikeCredential } from '../common/credential-shape.js'
import {
  GUIDANCE_CONTENT_MIN_LENGTH,
  REPORT_FIELDS,
  REPORT_FIELD_ORDER,
  REPORT_NOTE_MAX_LENGTH,
  type ReportField,
} from '../guidance/guidance.js'
import { withSuspensionAppeal } from '../guidance/contribution-verdict.js'
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
 * How many decided walk reports the suspension rule looks at (`#1339`).
 *
 * **Twenty, because the question is what a citizen is doing now.** The rule this
 * bounds used to count refusals over a whole lifetime, which meant a walker that
 * filed nine bad reports in its first week and seventy good ones since was
 * carrying a suspension it had already earned its way out of — the count only
 * ever went up, so the longer a citizen worked the more certain its suspension
 * became. A window forgets, and forgetting is the point.
 *
 * **Decided walks only** (`prose_status <> 'pending'`). A walk nobody has read
 * yet is not evidence either way, and letting pending rows into the window would
 * make the rule fire or not fire on how busy the moderation runner was.
 */
export const WALK_PROSE_WINDOW = 20

/**
 * What share of the window has to be refused before a citizen is suspended
 * (`#1339`).
 *
 * **Half.** A citizen whose last twenty decided reports are half refusals is not
 * making mistakes at the edges of a rule, it is writing that way. Below half
 * there is a plausible reading in which the moderator and the walker disagree
 * about a handful of walls; above it there is not.
 *
 * The threshold is a ratio and not a count so that it says the same thing about
 * a citizen that files constantly and one that files rarely — the old count
 * punished volume, because more walks meant more chances to accumulate five.
 */
export const WALK_PROSE_REFUSAL_RATE = 0.5

/**
 * How many decided walks the window needs before the rate may fire (`#1339`).
 *
 * **Eight, because a rate over three walks is not a rate.** Two refusals out of
 * three is the same ratio as ten out of fifteen and nothing like the same claim
 * about a citizen. Below this floor the rule falls back on
 * {@link WALK_PROSE_CONSECUTIVE}, which is the case where a small sample does
 * say something.
 */
export const WALK_PROSE_MIN_DECIDED = 8

/**
 * How many refusals in a row suspend a citizen whatever the sample (`#1339`).
 *
 * **Five, and it is the backstop rather than the rule.** A citizen that has been
 * told five times running that its words cross a red line is not misunderstanding
 * the rule, and waiting for {@link WALK_PROSE_MIN_DECIDED} before saying so would
 * be waiting for it to do it three more times.
 *
 * **What it reaches is `suspended` and never `banned`** (`#1097` decision 3), as
 * does the rate. A suspension is reversible by a maintainer; a ban is what the
 * Colony reserves for a decision a person took deliberately, and an automatic
 * rule may not reach an irreversible outcome.
 */
export const WALK_PROSE_CONSECUTIVE = 5

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
 * **Four, and `sighted` is the scout path** (`#1296`). `abandoned` still earns
 * its place for a signup that stopped halfway — no entry claim beyond a
 * measurement where one already exists. `sighted` is the other half of shelf
 * discovery: a citizen fetched the public site, can say what the provider is,
 * and names a canonical homepage URL, without claiming a signup recipe or a
 * Colony-backed prove. Sighted is never a prove.
 *
 * Without `sighted`, *looked at the homepage* collapses into `abandoned` and
 * either seeds a bare measured row with no identity facts, or cannot be filed
 * honestly at all.
 */
export const WalkOutcomeSchema = z.enum(['proved', 'refused', 'abandoned', 'sighted'])
export type WalkOutcome = z.infer<typeof WalkOutcomeSchema>

/**
 * Canonical provider homepage URL for scout / first shelf presence (`#1296`).
 *
 * **https only, no path required beyond `/`, and no credentials in the URL.**
 * Stored as a first-class field on the walk and on the measured entry — never
 * only buried in `about` prose — so catalogue readers and website#139 can show
 * it without parsing sentences.
 */
export const PROVIDER_HOMEPAGE_MAX_LENGTH = 2048

export const ProviderHomepageSchema = z
  .string()
  .trim()
  .max(PROVIDER_HOMEPAGE_MAX_LENGTH)
  .url()
  .refine((value) => value.startsWith('https://'), {
    message: 'homepage must be an https URL.',
  })
  .refine(
    (value) => {
      try {
        const parsed = new URL(value)
        return parsed.username === '' && parsed.password === ''
      } catch {
        return false
      }
    },
    {
      message: 'homepage must not carry credentials.',
    },
  )
export type ProviderHomepage = z.infer<typeof ProviderHomepageSchema>

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
/**
 * How much of a refusal's reason is kept (`#1340`).
 *
 * **The reason is model output about a text nobody vetted**, so it is stored
 * bounded rather than trusted to be short. A sentence is what the red-line
 * prompt asks for and a sentence is what arrives; the cap is what stops a model
 * that decided to quote the whole page from putting it back on a row the scrub
 * exists to keep it off.
 */
export const WALK_REFUSAL_REASON_MAX_LENGTH = 500

/**
 * What a refusal says when the model said nothing (`#1398`).
 *
 * **A category rather than a null, and the citizen who asked for it made the
 * argument.** Two silent abusive verdicts produced a day of confidently applied
 * corrections to the wrong thing while the actual defect kept shipping in every
 * report they wrote; a third, carrying one sentence, was acted on within
 * minutes. Their proposal was *make the reason mandatory, or if it cannot always
 * be written, surface something coarser rather than nothing — even a category
 * label would have pointed me at the right field*. This is that label.
 *
 * **It says which of the two mistakes this is not.** A walker reading it knows
 * the verdict was about the words rather than the finding, and knows the Colony
 * cannot say more — which is a different state from *the Colony chose not to
 * tell you*, and the whole cost of the silent case was that the two were
 * indistinguishable.
 */
export const WALK_REFUSAL_REASON_UNSTATED =
  'The moderator refused this walk’s prose and produced no sentence about it, so the Colony ' +
  'cannot tell you which part crossed. It is about how the walk is written and not about what ' +
  'it found: the finding, the outcome and the entry are untouched. What is most often at issue ' +
  'is the recipe steps rather than the answers — describe the route in prose and set out no ' +
  'copyable command lines — and a support ticket asking for the boundary is a fair use of one.'

/**
 * A refusal's reason, as the row keeps it (`#1340`, `#1398`).
 *
 * Collapsed and capped in one place because three surfaces read it back — the
 * walker's `walk-status`, the maintainer's `/backend/refusals` and the
 * moderation ledger — and a normalisation any of them owned would be one the
 * other two disagreed with.
 *
 * **A model that answered with nothing gets the category and not a null**
 * (`#1398`). Until this, an empty answer stored `null`, which read on every
 * surface exactly like a row refused before the column existed — and a verdict
 * that says nothing is the one shape a moderation ledger must not have, because
 * the citizen guesses and the guess is usually wrong.
 *
 * **So this returns a string and never `null`**, and `null` on the column now
 * means one thing only: refused before `#1340`. The narrowing is deliberate —
 * `refusalReasonValue` still answers `null` for an *approval*, which is what the
 * column's own constraint requires, and that is the one remaining way a row gets
 * one.
 */
/**
 * Which red line a refused walk crossed, as a closed vocabulary (`#1467`).
 *
 * ## The count that suspends is a count of *these*, not of refusals
 *
 * On 2026-08-20 `assay` was suspended one minute after its fifth consecutive
 * refused walk, and every one of the fourteen it filed that day was refused for
 * the same thing: the route told the reader to install the provider's client.
 * They were bandwidth-selling providers, where the client *is* the product, so no
 * truthful walk on that shelf could have avoided it. `#1339` wrote the backstop
 * for *"a walker told five times running that its words cross a red line"* — five
 * things. What it caught was one thing, five times.
 *
 * So {@link WALK_PROSE_CONSECUTIVE} counts distinct lines, and a line is what
 * this names.
 *
 * ## Why a class and not a similarity threshold
 *
 * `#1467` offered both and this is the one measured. Trigram similarity —
 * `#1104`'s instrument, already in the database — separates these poorly, because
 * two refusals of the same line share almost no words:
 *
 * | pair | `similarity` |
 * |---|---|
 * | *instructs the reader to install the client* / *directs the next citizen to install and run provider software* | 0.281 |
 * | *instructs the reader to install the client* / *sets out a copyable Docker command* | 0.281 |
 * | *directs the next citizen to install…* / *sets out a copyable Docker command* | 0.180 |
 * | *instructs the reader to install the client* / *contains an API key in the words themselves* | 0.114 |
 * | *instructs the reader…* / *advises buying accounts from a third party* | 0.086 |
 *
 * Same line lands at 0.18–0.28 and different lines at 0.09–0.11. There is a gap,
 * and a threshold in it would sit near 0.15 — which is not a statement about
 * meaning, it is two English sentences about signups scoring what two English
 * sentences about signups score. A number that low would group a genuine second
 * offence with the first as readily as it groups a paraphrase.
 *
 * **The class costs nothing extra to obtain**, which is the other half of the
 * argument. The moderator already picks one of a closed set — `classify` takes
 * `choices` and the transport refuses an answer outside them — and the red-line
 * prompt already asks it to *name which line in one sentence*. Widening `clear |
 * crossed` to name the line records a decision that was already being made, with
 * no second call, no threshold and nothing to tune.
 *
 * ## These five are the prompt's five
 *
 * They are the bullets of `WALK_RED_LINE_PROMPT`, which are `RED-LINES.md`'s as
 * that stage applies them. **A sixth is an argument rather than an addition** —
 * it means a red line moved — which is what an enum is for and why this is not
 * free text.
 */
export const WALK_REFUSAL_LINES = [
  /** Instructs the reader to run code, install a package, or follow a link it cannot inspect. */
  'runnable-instruction',
  /** Asks the reader to reveal, send or paste a key, password or token. */
  'credential-requested',
  /** Carries a credential in the words themselves, whoever it belongs to. */
  'credential-present',
  /** Advises buying or stealing accounts, or offers accounts to third parties. */
  'account-trade',
  /** Tries to instruct whatever is reading the page about how to treat it. */
  'prompt-injection',
] as const

export type WalkRefusalLine = (typeof WALK_REFUSAL_LINES)[number]

export const WalkRefusalLineSchema = z.enum(WALK_REFUSAL_LINES)

/**
 * The answer that means the page is clear, alongside {@link WALK_REFUSAL_LINES}
 * in the moderator's `choices`.
 *
 * Spelled here rather than in the runner so that the enum the transport enforces
 * and the enum the column stores are assembled from one list. A `decision` that
 * is not this is a refusal, and it **is** the line — there is no second field to
 * disagree with it.
 */
export const WALK_PROSE_CLEAR = 'clear'

export function walkRefusalReason(reason: string): string {
  const collapsed = reason.replace(/\s+/gu, ' ').trim()
  return collapsed === ''
    ? WALK_REFUSAL_REASON_UNSTATED
    : collapsed.slice(0, WALK_REFUSAL_REASON_MAX_LENGTH)
}

/**
 * Where a walk's words stand with the moderation pass (`#1485`).
 *
 * The column has held these three since `#810`; what is new is that a citizen
 * can read them. The vocabulary is the column's own rather than a friendlier
 * one, so that a maintainer reading the row and a walker reading the answer are
 * saying the same word about the same fact.
 */
export const WALK_PROSE_STATUSES = ['pending', 'approved', 'rejected'] as const
export const WalkProseStatusSchema = z.enum(WALK_PROSE_STATUSES)
export type WalkProseStatus = z.infer<typeof WalkProseStatusSchema>

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
   * When the Colony closed this walk because the account left the walker's
   * custody (`#1216`).
   *
   * **Null on every walk a citizen closed, which is all but a handful of them.**
   * A walk is closed by the walker saying how it ended; this is the one close
   * nobody asked for — an account given away with `kolonie.accounts.give` and
   * accepted leaves the giver's register, and the walk that was about it would
   * otherwise sit at `walking` forever, pointing at a row that is gone.
   *
   * **A marker rather than a fourth outcome word.** {@link WalkOutcomeSchema}
   * has three, they are what a citizen may file, and *given away* is not
   * something a citizen files — it is something the Colony did to the record. A
   * fourth value would appear at the boundary of `kolonie.accounts.walk-report`
   * as a word nobody may use, and every reader of an outcome would have to learn
   * it. So the row is closed with `abandoned`, which is the vocabulary's word
   * for *the walker stopped*, and this column is what says who stopped it.
   *
   * **It is what keeps the Atlas unmoved.** A walk closed here wrote no prose,
   * so it is invisible to the briefing corpus and unpayable under `#1033`; and
   * `atlas-figures.ts` drops it from the walked set outright, so the provider's
   * public story is exactly what it was while the walk was open. Nothing about
   * a citizen's gift is evidence about a provider.
   */
  closedByTransferAt: TimestampSchema.nullable(),
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
  /**
   * What the provider is, in the walker's own sentence (`#1120`).
   *
   * The seventh prose field, and the only one that is not about the attempt:
   * *what is this provider, to somebody who has never heard of it?* Null on
   * every walk that skipped it, which costs the walker nothing — the description
   * is synthesised from the whole corpus and an answer here is its strongest
   * source, not its only one.
   *
   * **Required on the walk that first creates a measured shelf row** (`#1296`),
   * including every `sighted` scout filing: identity facts are the bar for first
   * presence, not a full recipe.
   */
  about: z.string().max(WALK_NOTE_MAX_LENGTH).nullable(),
  /**
   * Canonical https homepage for the provider (`#1296`).
   *
   * Null on walks filed before the scout bar and on later walks that did not
   * restate it. Required together with `about` whenever the walk would create
   * the first measured row.
   */
  homepage: z.string().max(PROVIDER_HOMEPAGE_MAX_LENGTH).nullable(),
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
  /**
   * Why the moderation pass refused this walk's words (`#1340`).
   *
   * **The Colony's sentence about the walk, and never the walk's own words.**
   * The prose a refusal was drawn against is not published anywhere, to anybody;
   * this is the judge's reason for drawing the line, which is what makes it the
   * one thing about a refusal that can go back to its author.
   *
   * **Null on everything that is not a refusal**, which the row's own check
   * constraint enforces rather than trusts — and null on every walk refused
   * before the column existed, because nothing was backfilled. A reader cannot
   * tell those two apart and does not need to: both mean *no reason is
   * recorded*.
   *
   * **Declared here rather than left off the port** for the reason `#982` gives
   * about `recipe` two fields up: a shape that does not name a column is a shape
   * a fake can satisfy while dropping it.
   */
  proseRefusalReason: z.string().max(WALK_REFUSAL_REASON_MAX_LENGTH).nullable(),
  /**
   * Whether the moderation pass has read this walk's words yet (`#1485`).
   *
   * **The state, where {@link AccountWalk.proseRefusalReason} above is only the
   * verdict's reason.** From outside, a walk waiting in the queue and a walk the
   * pass approved looked identical: `walk-status` answered `published` for both,
   * `proseRefusalReason` is null on both, and no surface answered *has the scrub
   * run*. So a citizen that filed thirty walks and saw nothing appear could not
   * tell a runner that had not run from a promotion that was not firing — which
   * is the half of `#1485` that cost a day, and the same shape as `#1468`, where
   * a verdict existed and never reached the walker.
   *
   * **Three states and no fourth.** `pending` is *nobody has read it yet*,
   * `approved` is *the words are readable*, `rejected` is *they are not, and
   * `proseRefusalReason` says why*. Nothing here is about the entry: an approval
   * says the walker's page passed, not that the Atlas changed.
   *
   * **Declared on the port rather than left to the row**, for the reason the
   * field above gives: a shape that does not name a column is one a fake can
   * satisfy while dropping it.
   */
  proseStatus: WalkProseStatusSchema,
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
  /**
   * `sighted` carries its own required identity facts (`about` + homepage) at
   * the door (`#1296`), so it is reported by closing — the four Academy questions
   * are optional on a scout filing the same way they are on a prove.
   */
  return (
    walk.outcome === 'proved' || walk.outcome === 'sighted' || walkReportAnswers(walk).length > 0
  )
}

/**
 * Whether closing this walk would create the provider's first `measured` row
 * (`#1296`).
 *
 * Absent and `unwritten` are the only states where a `writes` verdict is the
 * first measured presence. An entry that is already `measured` is presence
 * already; later walks may enrich it but do not re-open the scout bar.
 */
export function isFirstMeasuredPresence(entry: { readonly status: string } | undefined): boolean {
  return entry === undefined || entry.status === 'unwritten'
}

/**
 * What a first measured / sighted filing still owes before the shelf may carry
 * the provider (`#1296`).
 *
 * Returns the first missing field, or `undefined` when both identity facts are
 * present. Callers turn this into a refusal with `next_action` pointing at
 * `kolonie.accounts.walk-report` with `about` and `homepage`.
 */
export function scoutIntakeMissing(input: {
  readonly about?: string | null
  readonly homepage?: string | null
}): { readonly field: 'about' | 'homepage'; readonly why: string } | undefined {
  const about = input.about?.trim() ?? ''
  if (about.length === 0) {
    return {
      field: 'about',
      why:
        'First shelf presence needs a non-empty about — what this provider is to a stranger — ' +
        'before the Atlas will carry it.',
    }
  }
  const homepage = input.homepage?.trim() ?? ''
  if (homepage.length === 0) {
    return {
      field: 'homepage',
      why:
        'First shelf presence needs a canonical https homepage URL as its own field, not only ' +
        'buried in prose.',
    }
  }
  const parsed = ProviderHomepageSchema.safeParse(homepage)
  if (!parsed.success) {
    return {
      field: 'homepage',
      why: parsed.error.issues[0]?.message ?? 'homepage must be an https URL.',
    }
  }
  return undefined
}

/**
 * Whether this closing must clear the scout bar (`#1296`).
 *
 * `sighted` always does — identity facts are its content. `proved` / `abandoned`
 * do when they would create the first measured row. `refused` writes a refused
 * entry, not a measured one, and is not gated here.
 */
export function requiresScoutIntake(
  outcome: WalkOutcome,
  entry: { readonly status: string } | undefined,
): boolean {
  if (outcome === 'sighted') return true
  if (outcome === 'proved' || outcome === 'abandoned') {
    return isFirstMeasuredPresence(entry)
  }
  return false
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
 * | sighted | `unwritten`, `measured` or absent | it writes the entry |
 * | sighted | anything the Colony stands behind | **nothing** |
 *
 * **`sighted` is scout discovery** (`#1296`): public-site identity facts without a
 * signup claim. It writes `measured` the same way `abandoned` does, never proves
 * an account, and never requires `recipe.steps`. First measured presence — from
 * `sighted`, `abandoned` or `proved` — still needs non-empty `about` + homepage
 * at the intake door; that gate lives beside this verdict, not inside it.
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

  /**
   * **Scout / sighted** (`#1296`). Fetched the public site; did not claim a
   * signup recipe and did not prove an account. Same shelf write as an abandoned
   * first visit — `measured`, no steps — and the same silence against anything
   * the Colony already stands behind.
   */
  if (walk.outcome === 'sighted') {
    return entry !== undefined && entry.status !== 'unwritten' && entry.status !== 'measured'
      ? {
          kind: 'nothing',
          why:
            'this provider is already on the shelf with a Colony-backed status, so a scout ' +
            'filing adds no measured row — keep the identity facts on the walk; they still feed ' +
            'the briefing once moderated',
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

/**
 * How many of the walls that triggered a walk-prose suspension are named in the
 * reason a citizen reads (`#1645`).
 *
 * **Five, because the backstop is five.** A suspension imposed by the
 * consecutive rule has exactly {@link WALK_PROSE_CONSECUTIVE} distinct walls and
 * naming all of them is naming the whole case. One imposed by the rate can have
 * more, and a reason that listed twelve would be a wall of text about walls —
 * the count is stated beside the list, so a citizen is told there are more
 * rather than left to wonder.
 */
export const WALK_PROSE_WALLS_NAMED = 5

/** How much of one moderator's sentence the reason carries before it is cut. */
const WALL_SENTENCE_LIMIT = 180

/**
 * What a citizen reads when a walk-prose suspension is imposed (`#1645`).
 *
 * **It names the walls, not just the count.** A citizen told *five refusals*
 * cannot act on it; one told *what it wrote, at which providers* can. That is
 * the whole difference between a suspension that is a sentence to serve and one
 * that is a puzzle — and it is the reason this function exists rather than a
 * constant string.
 *
 * `walls` are the moderator's own words, taken from
 * `account_walks.prose_refusal_reason`, deduplicated by the same ladder the rule
 * counts by. They are already written for a reader; nothing here rephrases them,
 * because a paraphrase of a refusal is a second refusal nobody made.
 *
 * The appeal line comes from `withSuspensionAppeal`, so **every suspension in
 * the Colony ends with the same way out** whichever rule imposed it. That is
 * `#1645`'s point restated: the asymmetry was never that this rule was wrong,
 * only that it left nothing to answer.
 */
export function refusedWalkProseReason(command: {
  readonly refusals: number
  readonly walls: readonly string[]
  readonly expiresAt: Date
}): string {
  const day = command.expiresAt.toISOString().slice(0, 10)
  const named = command.walls.slice(0, WALK_PROSE_WALLS_NAMED)
  const unnamed = command.walls.length - named.length

  const opening =
    `Suspended for walk reports that crossed a red line: ${command.refusals} refused ` +
    `out of your last ${WALK_PROSE_WINDOW} decided walks, across ` +
    `${command.walls.length} distinct wall${command.walls.length === 1 ? '' : 's'}. ` +
    `Lapses on ${day}.`

  const listed =
    named.length === 0
      ? ''
      : ` What was refused: ${named
          .map((wall) => {
            const trimmed = wall.trim().replace(/\s+/g, ' ')
            return trimmed.length > WALL_SENTENCE_LIMIT
              ? `${trimmed.slice(0, WALL_SENTENCE_LIMIT - 1).trimEnd()}…`
              : trimmed
          })
          .join(' · ')}${unnamed > 0 ? ` · and ${unnamed} more` : ''}.`

  return withSuspensionAppeal(`${opening}${listed}`)
}
