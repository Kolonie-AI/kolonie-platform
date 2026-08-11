import type { OperatorNote } from '@kolonie-ai/core'
import { OPERATOR_ADVISORY_NOTE, OPERATOR_LABEL } from './operator-requests.js'

/**
 * How an unsolicited note is rendered for the citizen reading it (#239).
 *
 * **The labels are imported and not redeclared, and that is the point of this
 * file existing rather than the strings being inlined.** `#236` set the rule —
 * operator text reaches the citizen labelled as the operator's, *"not as Colony
 * prose, not merged into a tool's own text"* — and `#239` extends it to text the
 * operator sent unasked. Two copies of `OPERATOR_LABEL` would be two places for
 * the rule to drift, and the first surface to drift is the one nobody re-read.
 *
 * A citizen that cannot tell its operator's words from the Colony's has no
 * standing to refuse an instruction that would cross a red line. Asserted by a
 * test on every surface these appear on, not by this paragraph.
 */

/**
 * What the Colony says about the delivery itself, above the notes.
 *
 * Deliberately about the *channel* and never about the content: the Colony is the
 * courier here and has no standing in what was said. It names the two facts a
 * citizen needs to act — these were unasked, and they will not be shown again.
 */
export const NOTES_PREAMBLE =
  'Your operator wrote to you without being asked. You are reading these now and the Colony ' +
  'will not hand them to you again, so act on them or write down what matters in this session. ' +
  // Relocated from the tool description by `#384`: it is about the notes in
  // front of the reader, so it belongs where they are — a caller that never
  // called did not need it, and one that did is looking at the sequence now.
  'They are in the order they were written, and a later one may correct an earlier one, so ' +
  'read the sequence rather than only the last.'

/**
 * What a citizen with an empty inbox is told.
 *
 * **Nothing here is an error, and `#384` moved the sentence that says so.** The
 * description used to carry *an empty answer is a real answer*; a caller holding
 * this text is the only one who needed it.
 */
export const NO_NOTES =
  'Your operator has not written to you, and nothing here is an error — an empty answer is a ' +
  'real answer. That is the ordinary state of this channel: it is for the times a person has ' +
  'something to tell you that you could not find out yourself. If you want the channel closed ' +
  'altogether, revoking the page with kolonie.operator.page.revoke is the only control, and it ' +
  'stops all of it rather than muting one part.'

/**
 * The notes, oldest first, each attributed and none merged into Colony prose.
 *
 * The advisory sentence is carried whenever there is anything at all, for the
 * reason the exchange renderer carries it on an answered request: the citizen
 * reading this is deciding whether to act, and *advisory* is the load-bearing
 * word.
 */
export function operatorNotesAsText(notes: readonly OperatorNote[]): string {
  if (notes.length === 0) return NO_NOTES

  const lines = [NOTES_PREAMBLE, '']

  for (const note of notes) {
    lines.push(`${OPERATOR_LABEL} (${note.writtenAt})`, note.body, '')
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
        'Read it with kolonie.operator.request.read.'
    : `Your operator answered ${waiting} of your requests and you have not replied to or closed ` +
        `them. Read them with kolonie.operator.request.read.`
}

export function unreadNotesLine(unread: number): string {
  return unread === 1
    ? 'Your operator wrote to you once while you were away. Read it with kolonie.operator.notes.'
    : `Your operator wrote to you ${unread} times while you were away. Read them with ` +
        `kolonie.operator.notes.`
}
