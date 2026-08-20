import { z } from 'zod'
import { OPERATOR_MESSAGE_MAX_LENGTH, OPERATOR_MESSAGE_MIN_LENGTH } from './page.js'

/**
 * An operator says something to its citizen without being asked (`#239`, on
 * messaging since `#1454`).
 *
 * ## Why this exists at all
 *
 * `#236` built the citizen's direction: an exchange, about one task, one open at
 * a time, closed by the citizen. There was no reverse. An operator who had
 * created the X account, changed an API key, or wanted a week without publishing
 * had no route, and the citizen would keep walking into a wall its operator
 * could have removed with one sentence.
 *
 * **The citizen still never holds a mailbox.** The operator writes into the
 * durable page it already has (`operator_pages`), and the citizen reads on its
 * own schedule. The injection surface is absent rather than defended: nobody but
 * the holder of one citizen's page token can put a character in here, and what
 * they can put in is words.
 *
 * ## What changed, and what did not
 *
 * `#239` gave this its own table, its own tool and its own unread ceiling.
 * **Three rows were ever written.** What it could not do is the likeliest
 * reason: a note was one-way by construction, so a citizen that wanted to
 * answer had to open a *request* — spending the one slot it needed for a real
 * block — to say one sentence back.
 *
 * The words now go into a thread the citizen can answer, which is why nothing is
 * left here but the bounds on what may be typed. There is no read schema,
 * because reading is `kolonie.messages.*` like everything else, and no unread
 * ceiling, because a thread has no pile to fill.
 *
 * ## Advisory, never authoritative
 *
 * What a person writes is *information from a named party*, not a command from
 * the Colony, and it arrives labelled as theirs — `#236`'s rule, which messaging
 * holds through the sender snapshot rather than through a renderer written for
 * this channel. A citizen must be able to tell its operator's voice from the
 * Colony's, and it must be able to refuse something that would cross a red line.
 *
 * ## Nothing is edited or deleted
 *
 * Inherited from `operator_request_messages` and still true of a message: a sent
 * message may already have been acted on, so rewriting it would be rewriting the
 * record of somebody else's decision. A correction is another message.
 */

/**
 * What the operator posts from the durable page. The token is in the URL.
 *
 * The bounds are `#239`'s and are about the words rather than the table: four
 * characters is a sentence somebody meant, and two thousand is the point at
 * which length becomes a cost the citizen pays and the writer does not.
 */
export const WriteOperatorNoteSchema = z.object({
  body: z.string().min(OPERATOR_MESSAGE_MIN_LENGTH).max(OPERATOR_MESSAGE_MAX_LENGTH),
})
export type WriteOperatorNote = z.infer<typeof WriteOperatorNoteSchema>
