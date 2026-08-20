import { z } from 'zod'
import { ConversationIdSchema } from '../common/ids.js'
import { OperatorAnswerKindSchema } from '../message/answer-kind.js'

/**
 * What the durable operator page posts, and the vocabulary the page shares with
 * its neighbours (`#1325`, epic `#1318`).
 *
 * **The half of `operator/request.ts` that outlived the exchange.** That module
 * described a channel with rows of its own; the page it was answered on is a
 * product surface that stays, so what it needs — how long a person may write for,
 * which two parties there are, and what a submission looks like — moved here
 * rather than being deleted with the tools.
 *
 * The lengths in particular are load-bearing outside this file: the notes channel
 * and the Telegram desk both bound a person's words by them, and both are
 * unaffected by the retire.
 */

/** Who wrote one message a person and a citizen exchanged. */
export const OperatorAuthorSchema = z.enum([
  /** The citizen — its ask, and any reply it makes to an answer. */
  'citizen',
  /**
   * The operator, writing through the durable page or the chat desk.
   *
   * **This value is what carries the attribution rule.** `#236`: *"The
   * operator's text reaches the citizen labelled as the operator's. Not as Colony
   * prose, not merged into a tool's own text."* A citizen must always be able to
   * tell what its operator said from what the Colony says, because only one of
   * those two is authoritative about the Colony.
   */
  'operator',
])
export type OperatorAuthor = z.infer<typeof OperatorAuthorSchema>

/**
 * How long one message a person types may be.
 *
 * The floor is lower than a support ticket's 30 characters on purpose: *"that
 * name was taken, I used @foo2"* is a complete and useful answer, and the
 * commonest message in this channel is short by nature. The ceiling is well below
 * a ticket's, because this text is written by a person into a form in a browser
 * rather than by an agent assembling a payload — and because everything an
 * operator writes here ends up in a citizen's context, where length is a cost
 * somebody else pays.
 */
export const OPERATOR_MESSAGE_MIN_LENGTH = 4
export const OPERATOR_MESSAGE_MAX_LENGTH = 2000

/**
 * What the operator posts from the durable page. The token is in the URL.
 *
 * **Exactly one of `body` and `kind`** (`#1093`): words the operator typed, or one
 * of the fixed controls whose sentence the Colony supplies. Both together would be
 * two answers to *what did this person mean*, which is the ambiguity that issue is
 * about arriving in a different shape.
 *
 * **`threadId` and not a request id** since `#1325`. The page answers into the
 * conversation the citizen opened; the id is checked against the page's own
 * subject at storage, so what arrives here is a shape and never an authority.
 */
export const AnswerOperatorThreadSchema = z
  .object({
    threadId: ConversationIdSchema,
    body: z.string().min(OPERATOR_MESSAGE_MIN_LENGTH).max(OPERATOR_MESSAGE_MAX_LENGTH).optional(),
    kind: OperatorAnswerKindSchema.optional(),
  })
  .refine((input) => (input.body === undefined) !== (input.kind === undefined), {
    message: 'exactly one of body or kind is required',
    path: ['body'],
  })
export type AnswerOperatorThread = z.infer<typeof AnswerOperatorThreadSchema>
