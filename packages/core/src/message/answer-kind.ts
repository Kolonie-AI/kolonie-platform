import { z } from 'zod'

/**
 * What an operator declared one message to be (`#1093`, relocated by `#1319`).
 *
 * ## Why it lives beside messaging rather than beside the request module
 *
 * It was written for `operator_requests`, and it was never *about* them. It says
 * what a person meant by the words they sent — which is a property of a message,
 * and messaging is the surface that will still exist when the request tables are
 * deleted (epic `#1318`, slice G). Moving it here first is what lets that
 * deletion be a deletion rather than a rewrite. Nothing imported these three
 * names by path — every caller takes them off the package barrel, which is why
 * the move is a move and not a deprecation.
 *
 * ## A property of one message, not a status on the exchange
 *
 * It says what a person meant at 09:14. A later message may declare something
 * else, and that is a correction rather than a state change — both threads it
 * can appear on are append-only, so the sequence is the record and the last
 * declaration is what a reader acts on.
 *
 * **The defect it closes.** A page offering *Allow* and *Refuse* put the word
 * itself in the body, and a citizen that had asked its operator to create a
 * machine account could not tell *"you may go ahead and do it"* from *"I have
 * done it"* — the two answers a handoff most needs kept apart.
 *
 * **Nullable everywhere it is not declared, and that is the honest value**: for
 * free text, for a reply typed somewhere else, for every message the citizen
 * wrote, and for every row written before this existed. Inferring one from the
 * words would be the guesswork this replaces.
 */
export const OperatorAnswerKindSchema = z.enum([
  /**
   * *You may go ahead — I have not done anything myself.*
   *
   * The load-bearing half is the second clause. A citizen blocked on a step only a
   * person can take is still blocked after this answer, and it now knows so.
   */
  'permission',
  /** *I have done what you asked.* The step is taken; go and check it. */
  'completion',
  /** *No.* Whether it will not or cannot is for the words to say. */
  'refusal',
])
export type OperatorAnswerKind = z.infer<typeof OperatorAnswerKindSchema>

/**
 * What each fixed control actually sends (`#1093`).
 *
 * **The words are written here and not in the form**, because the button and the
 * sentence must not be able to disagree. The surface posts the kind alone and the
 * Colony writes the message, so there is no request shape in which a message
 * declared `permission` carries a body saying it was done.
 *
 * They are full sentences rather than single words, and that is the half of the
 * fix that reaches a citizen which ignores the field entirely: every surface that
 * renders a thread renders `body` verbatim, so a body that says which of the two
 * it is fixes the reading on its own.
 */
export const OPERATOR_ANSWER_BODIES: Readonly<Record<OperatorAnswerKind, string>> = {
  permission:
    'You may go ahead. This is permission — I have not done anything myself, so if you were ' +
    'waiting for a step only a person can take, it has not been taken yet.',
  completion:
    'I have done what you asked. Go and check that it is there, and say so here if it is not.',
  refusal: 'No — I am not going to do this.',
}

/**
 * What each control is labelled, for the person pressing it (`#1093`).
 *
 * **Beside the bodies rather than in the page**, so the label and the sentence it
 * sends are read together by whoever next changes either. The old pair, *Allow*
 * and *Refuse*, is what the defect was: *Allow* is the same word for *you may* and
 * *I have*, and an operator answering a handoff meant the second one about half
 * the time.
 */
export const OPERATOR_ANSWER_LABELS: Readonly<Record<OperatorAnswerKind, string>> = {
  permission: 'You may go ahead',
  completion: 'I have done it',
  refusal: 'No',
}

/**
 * Which declaration a body *is*, if it is one exactly (`#1548`).
 *
 * ## Why the tag follows the body rather than the button
 *
 * `#1093` guaranteed that a message *tagged* as a declaration carries only the
 * canonical words, and it bought that by throwing away anything the person had
 * typed. The implementation did it silently and said so nowhere on the page —
 * *"the typed text is dropped rather than sent alongside"* — so a person who
 * wrote two sentences of context and then pressed *I have done it* watched them
 * disappear. Nothing else a person uses does that.
 *
 * Under one form a message either **is** the canonical sentence or it is free
 * text, so the tag cannot come from which control was pressed. It comes from
 * here.
 *
 * **What the citizen relies on is unchanged**: anything tagged `completion` says
 * only *I have done what you asked*, because that is what having the tag now
 * means. What changes is that the surface stops deciding a person did not mean
 * the words they typed — an edited sentence is an ordinary message that happens
 * to start with a familiar one.
 *
 * **Exact, after trimming, and nothing looser.** A prefix match would tag a
 * message whose *second* sentence contradicts its first, which is the failure
 * `#1093` exists to prevent arriving by a longer road.
 */
export function answerKindOfBody(body: string): OperatorAnswerKind | undefined {
  const written = body.trim()

  return OperatorAnswerKindSchema.options.find((kind) => OPERATOR_ANSWER_BODIES[kind] === written)
}
