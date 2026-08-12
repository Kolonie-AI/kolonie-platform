import { z } from 'zod'
import { REPORT_FIELD_ORDER, REPORT_FIELDS, type ReportField } from '../guidance/guidance.js'
import { WALK_QUESTION, type AccountWalk } from './walk.js'

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
 * **One judgement over the whole page, not six.** `provider-reasons.ts` judges a
 * sentence because a citizen wrote one sentence; a walker writes its answers in
 * one sitting, about one attempt, and a reader receives them together. Judging
 * each field on its own would let a reader assemble a page half of which the
 * Colony refused, which is worse than either whole answer — and it would cost
 * six model calls where the question is the same question six times.
 *
 * **What is not here is the walked recipe.** `walk.recipe` is prose too, and it
 * gets its own verdict from the pass `#813` built: the draft it proposes is
 * judged as a draft, on the shelf question and the steps question, which are not
 * the questions asked here. Two passes over one field would be two standards for
 * it.
 */

/**
 * Every field of a walk that holds words a citizen wrote.
 *
 * **The order is the order they are read in**, and it is stable for the reason
 * `REPORT_FIELD_ORDER` is: the joined text is what a model is shown and what a
 * verdict is recorded against, so a field that moved would look like an edit.
 *
 * `wall` is last and is one of these rather than an exception to them. It is a
 * sentence a citizen wrote about a provider, going to a reader who is not its
 * author — the same question, so the same answer.
 */
export const WALK_PROSE_FIELDS = [...REPORT_FIELD_ORDER, 'note', 'wall'] as const

export const WalkProseFieldSchema = z.enum(WALK_PROSE_FIELDS)
export type WalkProseField = z.infer<typeof WalkProseFieldSchema>

/**
 * The wall, as a question rather than a label.
 *
 * Worded here because a scrub is shown the questions along with the answers —
 * *where did it stop you* and *where exactly did it stop* are different
 * questions, and a model shown the answers unlabelled would have to guess which
 * it was reading.
 */
export const WALK_WALL_QUESTION = 'Where did the provider stop you?'

/** What each field was asked, in one place, so no surface paraphrases one. */
export const WALK_PROSE_QUESTIONS: Readonly<Record<WalkProseField, string>> = {
  ...REPORT_FIELDS,
  note: WALK_QUESTION,
  wall: WALK_WALL_QUESTION,
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
 */
export function walkProse(
  walk: Partial<Pick<AccountWalk, 'note' | 'wall' | ReportField>>,
): WalkProse {
  const prose: Record<string, string> = {}

  for (const field of WALK_PROSE_FIELDS) {
    const answer = walk[field]
    if (answer !== null && answer !== undefined && answer.trim() !== '') prose[field] = answer
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
