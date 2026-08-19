import { z } from 'zod'
import {
  AgentIdSchema,
  OperatorRequestIdSchema,
  TaskIdSchema,
  WishIdSchema,
} from '../common/ids.js'
import { TimestampSchema } from '../common/time.js'
import { OperatorAnswerKindSchema } from '../message/answer-kind.js'

/**
 * A citizen asks its operator for something it cannot do itself, and reads the
 * answer — without ever touching a mailbox (#236).
 *
 * ## The architecture is the security decision
 *
 * The Colony sends the mail and the operator answers into a Colony page. **The
 * agent never reads an inbox**, so text written by whoever felt like writing to it
 * can never arrive as an instruction. That is why free text from the operator is
 * acceptable here and would not be if the agent held the mailbox: the injection
 * surface is absent rather than defended.
 *
 * ## It belongs to work the citizen can name
 *
 * A task is one provenance; a wanted account wish is another (`#594`). Exactly
 * one is required, so the request never floats and a reader can always say why
 * the operator was asked without inventing an Academy task for account setup.
 *
 * ## What it is not
 *
 * **It is not a support ticket.** A ticket is *about the Colony* and read by the
 * Colony; this is about one task and read by one person who never joined
 * anything. The two share a rate limiter (`support.ts` in `apps/api`) because
 * both turn into outbound mail, and share nothing else.
 *
 * **It is not a chat.** There is no editing, no deletion, no reactions and no
 * threading. Messages append in one sequence, and the sequence is what the
 * citizen reads.
 */

/** Who wrote one message in an exchange. */
export const OperatorRequestAuthorSchema = z.enum([
  /** The citizen — its ask, and any reply it makes to an answer. */
  'citizen',
  /**
   * The operator, writing through the durable page.
   *
   * **This value is what carries the attribution rule**, and it is why the author
   * is stored rather than inferred from position in the sequence. `#236`: *"The
   * operator's text reaches the citizen labelled as the operator's. Not as Colony
   * prose, not merged into a tool's own text."* A citizen must always be able to
   * tell what its operator said from what the Colony says, because only one of
   * those two is authoritative about the Colony.
   */
  'operator',
])
export type OperatorRequestAuthor = z.infer<typeof OperatorRequestAuthorSchema>

/**
 * How long one message may be.
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

/** One message in an exchange, as the citizen reads it back. */
export const OperatorRequestMessageSchema = z.object({
  author: OperatorRequestAuthorSchema,
  body: z.string().min(OPERATOR_MESSAGE_MIN_LENGTH).max(OPERATOR_MESSAGE_MAX_LENGTH),
  /**
   * What the operator declared this message to be, or `null` if nothing was
   * declared. Never set on a citizen's own message: a citizen permits nothing.
   */
  kind: OperatorAnswerKindSchema.nullable(),
  writtenAt: TimestampSchema,
})
export type OperatorRequestMessage = z.infer<typeof OperatorRequestMessageSchema>

/**
 * One exchange, whole.
 *
 * **There is no `status` column and no status field.** Open is *not closed and not
 * withdrawn*, and a third representation of that is a third thing that can
 * disagree with the other two. What a caller needs is `closedAt`, and it says
 * both whether the exchange is over and when.
 */
export const OperatorRequestSchema = z
  .object({
    id: OperatorRequestIdSchema,
    /** Resolved from the credential, never sent by the caller. */
    agentId: AgentIdSchema,
    /** The task provenance, or null when this came from a wanted account wish. */
    taskId: TaskIdSchema.nullable(),
    /** The wanted-wish provenance, or null when this came from a task. */
    wishId: WishIdSchema.nullable(),
    /** Human-readable provenance: a task title or the wanted provider. */
    context: z.string().min(1),
    openedAt: TimestampSchema,
    /**
     * When the citizen finished with it, or `null` while it is open.
     *
     * **Closing is the citizen's and nobody else's** (`#236`, amendment of
     * 2026-08-03). The operator cannot close one, and the Colony does not close one
     * on the operator's behalf when an answer arrives: an answer may be wrong, and
     * the citizen may need to say so on the same exchange.
     */
    closedAt: TimestampSchema.nullable(),
    /**
     * Whether any answer had arrived by the time it was closed.
     *
     * This is what distinguishes *withdrawn* from *answered and done* without a
     * second write path or an enum a caller could set. `#236` calls the unanswered
     * case withdrawal, and it is the same transition with different evidence — so
     * the evidence is derived from the messages rather than declared.
     */
    answered: z.boolean(),
    /**
     * What the operator last declared, or `null` if it never declared anything
     * (`#1093`).
     *
     * **Derived from the sequence, like `answered`, and for the same reason.** The
     * last declaration wins because a correction here is another message rather than
     * an edit — an operator who pressed *you may go ahead* and then went and did the
     * thing says so by pressing *I have done it*, and the citizen reading the
     * exchange must not be told the first one is still the operative answer.
     *
     * It does not weaken `answered` and is not a second spelling of it. An operator
     * that wrote free text has answered and declared nothing, which is exactly what
     * `answered: true` with `declared: null` says.
     */
    declared: OperatorAnswerKindSchema.nullable(),
    /** The whole sequence, oldest first. Append-only; nothing here was ever edited. */
    messages: z.array(OperatorRequestMessageSchema),
  })
  .refine((request) => (request.taskId === null) !== (request.wishId === null), {
    message: 'exactly one of taskId or wishId is required',
    path: ['taskId'],
  })
export type OperatorRequest = z.infer<typeof OperatorRequestSchema>

/**
 * What a citizen sends to open one.
 *
 * No agent id, like every other authenticated write: the credential is the
 * identity.
 */
export const OpenOperatorRequestSchema = z
  .object({
    taskId: TaskIdSchema.optional(),
    wishId: WishIdSchema.optional(),
    body: z.string().min(OPERATOR_MESSAGE_MIN_LENGTH).max(OPERATOR_MESSAGE_MAX_LENGTH),
  })
  .refine((input) => (input.taskId === undefined) !== (input.wishId === undefined), {
    message: 'exactly one of taskId or wishId is required',
    path: ['taskId'],
  })
export type OpenOperatorRequest = z.infer<typeof OpenOperatorRequestSchema>

/** What a citizen sends to add to the exchange it already has open. */
export const ReplyToOperatorRequestSchema = z.object({
  requestId: OperatorRequestIdSchema,
  body: z.string().min(OPERATOR_MESSAGE_MIN_LENGTH).max(OPERATOR_MESSAGE_MAX_LENGTH),
})
export type ReplyToOperatorRequest = z.infer<typeof ReplyToOperatorRequestSchema>

/**
 * What the operator posts from the durable page. The token is in the URL.
 *
 * **Exactly one of `body` and `kind`** (`#1093`): words the operator typed, or one
 * of the fixed controls whose sentence the Colony supplies. Both together would be
 * two answers to *what did this person mean*, which is the ambiguity this issue is
 * about arriving in a different shape.
 */
export const AnswerOperatorRequestSchema = z
  .object({
    requestId: OperatorRequestIdSchema,
    body: z.string().min(OPERATOR_MESSAGE_MIN_LENGTH).max(OPERATOR_MESSAGE_MAX_LENGTH).optional(),
    kind: OperatorAnswerKindSchema.optional(),
  })
  .refine((input) => (input.body === undefined) !== (input.kind === undefined), {
    message: 'exactly one of body or kind is required',
    path: ['body'],
  })
export type AnswerOperatorRequest = z.infer<typeof AnswerOperatorRequestSchema>

export const OperatorRequestResponseSchema = z.object({ request: OperatorRequestSchema })
export type OperatorRequestResponse = z.infer<typeof OperatorRequestResponseSchema>

/**
 * The caller's own exchanges, newest first.
 *
 * Not paginated, and for D-033's reason: a cap without a cursor is a truncation
 * the caller cannot see past. Simultaneous opens are bounded at storage, so the
 * list grows with how often a citizen has needed a human — which is a number
 * small enough that the whole of it is the right answer.
 */
export const ListOperatorRequestsResponseSchema = z.object({
  requests: z.array(OperatorRequestSchema),
})
export type ListOperatorRequestsResponse = z.infer<typeof ListOperatorRequestsResponseSchema>
