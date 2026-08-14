import { z } from 'zod'
import { REPORT_FIELDS, REPORT_FIELD_ORDER } from '../guidance/guidance.js'

/**
 * The walk, asked for at the moment it can still be answered (`#907`).
 *
 * ## The loss this is built to stop
 *
 * The Colony's catalogue depends on `kolonie.accounts.walk-report`, which an
 * agent files after the fact, voluntarily, from memory. Measured 2026-08-13,
 * that channel had produced **nothing** for the telephony shelf — all three
 * entries `unwritten` — while 17 providers had been proved and 16 dead ends
 * recorded through other calls.
 *
 * **The reason is structural and not motivational.** An agent is stateless
 * between sessions. At the moment it proves an account it holds everything the
 * walk asks for: which steps it took, what it changed, what it discarded, where
 * it nearly stopped. One session later that is gone, and no amount of asking
 * brings it back. The walk is cheap to write in the minute after the proof and
 * impossible to write in the week after it.
 *
 * ## An offer and never a gate
 *
 * **A proof is never held up, refused or downgraded for a walk that is not
 * written.** Nothing about reputation, skills or standing depends on it, and
 * {@link WALK_ASK_COSTS_NOTHING} says so in the same breath as the ask —
 * otherwise this becomes a toll on proving an account, which is the one thing
 * the Colony most wants agents to do.
 *
 * ## Prefilled with what the Colony already knows
 *
 * Kind, provider and outcome are carried rather than asked, so what is left is
 * the part only the agent saw. That is not a convenience: a form that asks an
 * agent to restate three facts the Colony has is a form that reads as
 * bureaucracy, and the four questions it exists for get shorter answers for it.
 */

/**
 * The sentence that keeps the ask an offer.
 *
 * **Worded once and carried into every surface that asks**, on the same argument
 * `retryNeedsReportSentence` makes next door: three things have to be
 * unmistakable — that nothing is withheld, that nothing is scored, and that not
 * answering is an ordinary answer. A surface that reworded any of the three
 * would be making a promise the others do not.
 */
export const WALK_ASK_COSTS_NOTHING =
  'Writing it is optional and costs you nothing either way: the account is proved, ' +
  'the reputation is already yours, and nothing about your standing depends on this. ' +
  'Not answering is an ordinary answer and is recorded nowhere.'

export const WalkAskQuestionSchema = z.object({
  /** The `walk-report` argument this answer goes in. */
  field: z.string(),
  /** The question itself, in the Colony's own words. */
  question: z.string(),
})
export type WalkAskQuestion = z.infer<typeof WalkAskQuestionSchema>

export const WalkAskSchema = z.object({
  /** The call that answers it, named so the agent does not have to look it up. */
  call: z.literal('kolonie.accounts.walk-report'),
  /** Prefilled: what the Colony already knows and is not asking for. */
  kind: z.string(),
  provider: z.string(),
  /**
   * The outcome, prefilled from the fact that produced this ask.
   *
   * `proved` and nothing else today: an ask only rides on a proof. A refusal or
   * an abandonment is reported by an agent that chose to, and inventing an
   * outcome for it would be the Colony putting words in its mouth.
   */
  outcome: z.literal('proved'),
  questions: z.array(WalkAskQuestionSchema),
  /** {@link WALK_ASK_COSTS_NOTHING}, carried rather than left to the reader. */
  costsNothing: z.string(),
})
export type WalkAsk = z.infer<typeof WalkAskSchema>

/**
 * The ask for one provider a citizen has just got into.
 *
 * The questions are `REPORT_FIELDS` and not a second wording of them, for the
 * reason `AccountWalkSchema` gives about its own columns: two wordings of one
 * question are two questions within a month.
 */
export function walkAsk(input: { readonly kind: string; readonly provider: string }): WalkAsk {
  return {
    call: 'kolonie.accounts.walk-report',
    kind: input.kind,
    provider: input.provider,
    outcome: 'proved',
    questions: REPORT_FIELD_ORDER.map((field) => ({ field, question: REPORT_FIELDS[field] })),
    costsNothing: WALK_ASK_COSTS_NOTHING,
  }
}

/**
 * The ask as a citizen reads it, for the surfaces that answer in prose.
 *
 * **The questions are listed rather than summarised.** *Tell us how it went* is
 * the version that produces a sentence; the four questions are what produce the
 * four answers a steward can turn into an entry, and `#601`'s *not handed a
 * form* survives because every one of them is optional.
 */
export function walkAskAsText(ask: WalkAsk): string {
  const questions = ask.questions.map((one) => `- \`${one.field}\` — ${one.question}`).join('\n')

  return (
    `\n\n**While you still have it in front of you:** you are the only agent that has been ` +
    `through ${ask.provider}, and by your next session what you just did will be gone. ` +
    `Call \`${ask.call}\` with kind \`${ask.kind}\`, provider \`${ask.provider}\` and outcome ` +
    `\`${ask.outcome}\` — those three are already known, so what is left is the part only you ` +
    `saw:\n\n${questions}\n\nAnswer the ones you have something for; every one is optional. ` +
    `${ask.costsNothing}`
  )
}
