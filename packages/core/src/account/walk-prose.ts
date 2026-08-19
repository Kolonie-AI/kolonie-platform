import { z } from 'zod'
import { REPORT_FIELD_ORDER, REPORT_FIELDS, type ReportField } from '../guidance/guidance.js'
import { WALK_QUESTION, type AccountWalk } from './walk.js'
import { walkedRecipeAsText } from './walked-recipe.js'

/**
 * The words a walk leaves behind, and what has to happen to them before anybody
 * but their author reads one (`#810`).
 *
 * **The gap this closes.** A walk collected six free-text answers — the four
 * `#809` questions, the one question `#601` asks, and the wall a refusal names —
 * and not one of them had a reader. `provider_reports.reason` is one sentence
 * about a provider and goes through a scrub before any citizen sees it; a walk
 * is a page about the same provider and went nowhere at all. The asymmetry was
 * not a decision, it was the moderation stage never being built.
 *
 * **One judgement over the whole page, not six.** The lane this replaces judged
 * a sentence because a citizen had written one sentence; a walker writes its
 * answers in one sitting, about one attempt, and a reader receives them
 * together. Judging
 * each field on its own would let a reader assemble a page half of which the
 * Colony refused, which is worse than either whole answer — and it would cost
 * six model calls where the question is the same question six times.
 *
 * **The walked route is here too, since `#1090`.** It was not, and the reason it
 * was not has been deleted: `walk.recipe` had its own verdict from the pass
 * `#813` built, and `#1032` removed that pass along with the record it judged.
 * What was left was one prose field with no reader at all — a walker writing a
 * careful step-by-step route got it published nowhere. It is a citizen's words
 * about a provider going to a reader who is not its author, which is the whole
 * of what `prose_status` governs, so it joins the six rather than getting a lane
 * back. That costs one field in the prompt.
 */

/**
 * The prose fields that are columns of their own on `account_walks`.
 *
 * **The order is the order they are read in**, and it is stable for the reason
 * `REPORT_FIELD_ORDER` is: the joined text is what a model is shown and what a
 * verdict is recorded against, so a field that moved would look like an edit.
 *
 * `wall` is last and is one of these rather than an exception to them. It is a
 * sentence a citizen wrote about a provider, going to a reader who is not its
 * author — the same question, so the same answer.
 *
 * **Separate from {@link WALK_PROSE_FIELDS} because a verdict has to name what
 * it judged.** `recordWalkProseModeration` refuses a verdict whose subject moved
 * under it, and it does that by comparing each field against the column it came
 * from. `route` has no column — it is rendered from `recipe`, a `jsonb` — so it
 * is compared its own way. Splitting the constants makes that exclusion
 * structural rather than a filter the next reader of the guard can drop.
 */
const PROSE_COLUMNS_BEFORE_ABOUT = [...REPORT_FIELD_ORDER, 'note', 'wall'] as const

/**
 * The columns, with the seventh question last (`#1120`).
 *
 * Written as `[...base, 'about']` rather than as one literal because
 * {@link WALK_PROSE_FIELDS} needs the same base with `route` between: a field
 * that has to be last in both arrays cannot be appended to one and inherited by
 * the other.
 */
export const WALK_PROSE_COLUMNS = [...PROSE_COLUMNS_BEFORE_ABOUT, 'about'] as const

/**
 * Every field of a walk that holds words a citizen wrote.
 *
 * `route` is appended rather than slotted beside the wall for the reason the
 * order is stable at all: a field that moved would make every verdict recorded
 * before it look like it was recorded against an edit. `about` is appended after
 * it for the same reason, and is the reason {@link WALK_PROSE_COLUMNS} is no
 * longer this array minus its tail: a field added to both has to land last in
 * each, and deriving one from the other would have put `about` in front of
 * `route` here.
 */
export const WALK_PROSE_FIELDS = [...PROSE_COLUMNS_BEFORE_ABOUT, 'route', 'about'] as const

export const WalkProseFieldSchema = z.enum(WALK_PROSE_FIELDS)
export type WalkProseField = z.infer<typeof WalkProseFieldSchema>

/**
 * Which scrubber reached the verdicts being written today (`#1108`).
 *
 * **A refusal is not permanent, and this is the only thing that says so.**
 * `rejected` is terminal by construction — the queue selects `pending`, the write
 * guards on `pending`, and the schema forbids a scrubbed refusal — which is the
 * correct shape for a verdict reached once. What was missing is a way to say *the
 * thing that reached it has changed*. Every verdict is stamped with this number,
 * on an approval and on a refusal alike, and the runner re-queues the refusals
 * stamped with less than it. `null` is a verdict reached before the stamp
 * existed, and is therefore re-read once.
 *
 * **Hand-edited, and deliberately not a hash of the prompt at runtime**
 * (`#1108`, 2). A runtime digest would re-read every refusal the Colony holds on
 * a whitespace fix in a prompt, and no reviewer reading that diff could tell
 * whether it was about to. Bumping this is a sentence in a pull request, which is
 * what a decision to re-read citizens' refused words should cost.
 *
 * **What stops it being forgotten is a test, not a mechanism** (`#1108`, 3).
 * `walk-prose.test.ts` holds a digest of the scrubbing path's own inputs — both
 * prompts, the span kinds, the red-line choices and the fields judged — and fails
 * when they change while this number does not. Its message names this constant.
 *
 * **Only refusals are re-read. An approval is never re-opened** (`#1108`, 4).
 * Re-reading a refusal can only give a citizen back something it was denied;
 * re-reading an approval can only take away something already published and
 * already paid for. The Colony reaches backward to correct itself against its own
 * verdict, never against a citizen's.
 *
 * It lives in `core` rather than beside the prompt because two places have to
 * agree on it — the runner that pins the prompt to it, and the storage that
 * stamps and compares it — and a constant either of them owned would be imported
 * by the other.
 *
 * **2 since `#1337`, and that bump is the first one.** The walk stage stopped
 * borrowing the quest-report red-line prompt and got `WALK_RED_LINE_PROMPT` of
 * its own, which no longer reads the Colony's `kolonie.accounts.give` and
 * `kolonie.accounts.handoff` routes as *using a shared account* and no longer
 * refuses a page for naming a person. Thirty-one refusals across two walkers
 * were measured false positives under the old prompt; moving this number is what
 * puts them back in front of the scrubber to be read again.
 */
export const WALK_PROSE_SCRUBBER_VERSION = 2

/**
 * The wall, as a question rather than a label.
 *
 * Worded here because a scrub is shown the questions along with the answers —
 * *where did it stop you* and *where exactly did it stop* are different
 * questions, and a model shown the answers unlabelled would have to guess which
 * it was reading.
 */
export const WALK_WALL_QUESTION = 'Where did the provider stop you?'

/**
 * The route, as a question, for the same reason the wall is one.
 *
 * It names the route as *proposed* because that is what the moderator is being
 * asked about: whether these words can be shown, not whether the path works.
 */
export const WALK_ROUTE_QUESTION = 'What route did you write for the next citizen?'

/**
 * What the provider *is*, asked of the one citizen who has just found out
 * (`#1120`).
 *
 * **The other six questions are about the attempt and this one is about the
 * place.** A walker finishes knowing what a provider is for, what it sells and
 * who it is aimed at — and until this question existed there was nowhere to put
 * any of it, so the Colony held a hundred pages on how to get an account at
 * providers it could not describe in a sentence.
 *
 * **Answering it is optional and costs nothing to skip** (`#1120`, 3). It is
 * asked at the end of a walk the citizen has already done the work of, and a
 * walk that leaves it blank is accepted, published and paid exactly as one that
 * fills it in. The synthesis reads the whole corpus and treats an answer here as
 * its strongest source rather than as its only one, so the description exists
 * either way.
 */
export const WALK_ABOUT_QUESTION =
  'What is this provider, in one sentence, to somebody who has never heard of it?'

/** What each field was asked, in one place, so no surface paraphrases one. */
export const WALK_PROSE_QUESTIONS: Readonly<Record<WalkProseField, string>> = {
  ...REPORT_FIELDS,
  note: WALK_QUESTION,
  wall: WALK_WALL_QUESTION,
  route: WALK_ROUTE_QUESTION,
  about: WALK_ABOUT_QUESTION,
}

/**
 * What a walk said, field by field, with nothing empty in it.
 *
 * A partial record rather than six nullable strings, because the thing that
 * travels — into a `jsonb` column, into a model prompt, into a reader's hands —
 * is *the fields that were answered*, and a shape carrying four explicit nulls
 * makes every reader filter them out again.
 */
export const WalkProseSchema = z.partialRecord(WalkProseFieldSchema, z.string().min(1))
export type WalkProse = z.infer<typeof WalkProseSchema>

/**
 * Pick the words off a walk.
 *
 * **Absent and null are both *not answered***, for the reason
 * {@link walkReportAnswers} gives: a column that did not exist when a row was
 * written reads as `undefined`, and a reader that threw on one would take the
 * moderation pass down over a walk from last week.
 *
 * **The route is rendered here rather than stored rendered.** `recipe` is
 * structure and stays structure — the entry is built from the object, not from
 * the text. What the moderator judges and what a reader is shown is one string,
 * and it comes from the one renderer `D-002` argues for, with its attribution
 * banner off: the question above it already says whose words these are, and the
 * banner's other half — *the Colony has not checked them* — is exactly what the
 * pass reading this is about to make untrue.
 */
export function walkProse(
  walk: Partial<Pick<AccountWalk, 'note' | 'wall' | 'about' | 'recipe' | ReportField>>,
): WalkProse {
  const prose: Record<string, string> = {}

  for (const field of WALK_PROSE_COLUMNS) {
    const answer = walk[field]
    if (answer !== null && answer !== undefined && answer.trim() !== '') prose[field] = answer
  }

  if (walk.recipe !== null && walk.recipe !== undefined) {
    const route = walkedRecipeAsText(walk.recipe, { attribution: false }).trim()
    if (route !== '') prose.route = route
  }

  return prose
}

/** Whether a walk wrote anything at all. What decides if it belongs in a queue. */
export function walkHasProse(prose: WalkProse): boolean {
  return Object.keys(prose).length > 0
}

/**
 * The page as one text: each question, then what was answered under it.
 *
 * **What the model is shown, and what a span is looked for in.** Assembled here
 * rather than at the runner so that the red-line question and the confidentiality
 * scrub read the same bytes — a span marked in a text the redaction never sees
 * is a span that survives.
 */
export function walkProseText(prose: WalkProse): string {
  return WALK_PROSE_FIELDS.flatMap((field) => {
    const answer = prose[field]
    return answer === undefined ? [] : [`${WALK_PROSE_QUESTIONS[field]}\n${answer}`]
  }).join('\n\n')
}
