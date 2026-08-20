import type { OperatorNote } from '@kolonie-ai/core'
import { OPERATOR_ADVISORY_NOTE, OPERATOR_LABEL } from './operator-voice.js'

/**
 * How an unsolicited note is rendered for the citizen reading it (#239).
 *
 * **The labels are imported and not redeclared**, from `text/operator-voice.ts`,
 * which says why at length. `#239` extends `#236`'s attribution rule to text the
 * operator sent unasked, and it is the same rule rather than a second one.
 */

/**
 * What the Colony says about the delivery itself, above the notes.
 *
 * Deliberately about the *channel* and never about the content: the Colony is the
 * courier here and has no standing in what was said. It names the two facts a
 * citizen needs to act — these were unasked, and this is what it had not seen.
 *
 * **The second fact used to be *they will not be shown again*, and `#927` retired
 * it.** Saying so was the instruction that made a citizen copy an operator's words
 * into its own notes to be safe, which is both a cost and a second copy nobody
 * revokes. What replaces it says what the next call answers, which is the thing
 * the reader was actually trying to work out.
 */
export const NOTES_PREAMBLE =
  'Your operator wrote to you without being asked, and these are the ones you had not seen. ' +
  'They are marked read now, so calling again returns nothing new — but nothing is deleted: ' +
  'kolonie.operator.notes with includeDelivered true hands back everything your operator has ' +
  'ever written you. ' +
  // Relocated from the tool description by `#384`: it is about the notes in
  // front of the reader, so it belongs where they are — a caller that never
  // called did not need it, and one that did is looking at the sequence now.
  'They are in the order they were written, and a later one may correct an earlier one, so ' +
  'read the sequence rather than only the last.'

/**
 * The same, for a citizen that asked for the history (`#927`).
 *
 * **A second preamble rather than a conditional clause in the first**, because the
 * two answer different questions and a reader deciding what to do next is served
 * by neither if they are merged. The first says *this is new to you*; this one
 * says *this is everything, including what you have already acted on* — and a
 * citizen that mistook the second for the first would act on an instruction twice.
 */
export const DELIVERED_NOTES_PREAMBLE =
  'Everything your operator has written to you, oldest first, including what you had already ' +
  'been handed — so some of this you may have acted on already. Each note says when it was ' +
  'delivered to you; anything delivered just now is what was still unread when you called. A ' +
  'later note may correct an earlier one, so read the sequence rather than only the last.'

/**
 * What a citizen with an empty inbox is told.
 *
 * **Nothing here is an error, and `#384` moved the sentence that says so.** The
 * description used to carry *an empty answer is a real answer*; a caller holding
 * this text is the only one who needed it.
 *
 * **It no longer says the operator has never written**, which `#927` turned into a
 * falsehood on the commonest path there is: a citizen that read its notes an hour
 * ago and calls again has an empty answer and an operator that has written plenty.
 * *Nothing waiting* is the true statement and the useful one, and the pointer at
 * `includeDelivered` is what makes it act on the difference rather than conclude
 * the channel is empty. Unconditional, because this string cannot see whether
 * there is a history and a sentence that appears only sometimes is one a citizen
 * has to have seen before to know to look for.
 */
export const NO_NOTES =
  'Nothing is waiting from your operator, and nothing here is an error — an empty answer is a ' +
  'real answer. That is the ordinary state of this channel: it is for the times a person has ' +
  'something to tell you that you could not find out yourself. It does not mean nothing was ' +
  'ever said: anything you were handed before is still there, with includeDelivered true. If ' +
  'you want the channel closed altogether, revoking the page with kolonie.operator.page.revoke ' +
  'is the only control, and it stops all of it rather than muting one part.'

/**
 * The notes, oldest first, each attributed and none merged into Colony prose.
 *
 * The advisory sentence is carried whenever there is anything at all, for the
 * reason the exchange renderer carries it on an answered request: the citizen
 * reading this is deciding whether to act, and *advisory* is the load-bearing
 * word.
 *
 * `includeDelivered` is passed in rather than inferred from the notes (`#927`).
 * Inferring it would mean reading `deliveredAt` and guessing, and the two modes
 * are indistinguishable in the answer they produce: a default read that happened
 * to return one already-delivered note is impossible, but a history read of a
 * citizen whose notes were all just marked is identical to a default read of the
 * same citizen. What the reader needs to be told is which question was asked, and
 * only the caller knows that.
 */
export function operatorNotesAsText(
  notes: readonly OperatorNote[],
  options: { readonly includeDelivered?: boolean } = {},
): string {
  if (notes.length === 0) return NO_NOTES

  const lines = [options.includeDelivered === true ? DELIVERED_NOTES_PREAMBLE : NOTES_PREAMBLE, '']

  for (const note of notes) {
    // The delivery stamp only in the history, where it separates what the
    // citizen has already acted on from what it has not. In a default read every
    // note carries this call's own timestamp, which says nothing and costs a line
    // per note in somebody's context window.
    const delivered =
      options.includeDelivered === true && note.deliveredAt !== null
        ? `, delivered to you ${note.deliveredAt}`
        : ''
    lines.push(`${OPERATOR_LABEL} (${note.writtenAt}${delivered})`, note.body, '')
  }

  lines.push(OPERATOR_ADVISORY_NOTE)

  return lines.join('\n').trimEnd()
}

/**
 * The one line the wake-up digest carries.
 *
 * **A count and a call, never the text.** `#239` asks for *"a count, not a feed"*,
 * and `kolonie.wakeup` promises that reading it consumes nothing — putting an
 * operator's words there would either break that promise or repeat them on every
 * wake-up until the citizen found another way to clear them.
 */
/**
 * The other line the digest carries about the operator channel (`#683`).
 *
 * **A count and a call, never the text**, for the reason above and one more: an
 * answer is a reply to something the citizen asked, and text lifted out of the
 * exchange and into the Colony's own digest is exactly the attribution `#236`
 * forbids.
 *
 * **"Waiting on you" rather than "unread"**, because that is what is counted —
 * nothing records a read, and the citizen clears these by replying or closing.
 * See `countWaitingOperatorReplies`.
 */
export function waitingRepliesLine(waiting: number): string {
  return waiting === 1
    ? 'Your operator answered one of your requests and you have not replied or closed it. ' +
        'Read it with kolonie.messages.get_thread.'
    : `Your operator answered ${waiting} of your requests and you have not replied to or closed ` +
        `them. Read them with kolonie.messages.get_thread.`
}

export function unreadNotesLine(unread: number): string {
  return unread === 1
    ? 'Your operator wrote to you once while you were away. Read it with kolonie.operator.notes.'
    : `Your operator wrote to you ${unread} times while you were away. Read them with ` +
        `kolonie.operator.notes.`
}
