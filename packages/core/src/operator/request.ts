import { z } from 'zod'
import { AgentIdSchema, OperatorRequestIdSchema, TaskIdSchema } from '../common/ids.js'
import { TimestampSchema } from '../common/time.js'

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
 * ## It belongs to a task, and in this schema a quest is a task
 *
 * `#236` says a request belongs to *"a task or a quest, never floating"*. Those
 * are one table here — a quest is a `tasks` row with `kind = 'quest'` (see
 * `schema/tasks.ts`) — so one non-null task reference enforces the whole rule, and
 * a second nullable column for quests would be a second way to say the same thing
 * with a state where both are set.
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

/**
 * Patterns that mean *this text is carrying a credential*.
 *
 * `#236` is explicit that this is **enforced rather than requested**: the obvious
 * use of the channel is *"create an X account with this password"*, and a password
 * crossing it would sit in a mail, in a form, and in the Colony's database — three
 * places it can never be taken out of again. The citizen asks for the account to
 * be created and for the credential to be put where credentials go, which is the
 * vault.
 *
 * **Deliberately shape-based and deliberately not exhaustive.** No matcher can
 * decide whether an arbitrary string is a secret, so this does not try: it
 * catches the shapes a person or an agent actually writes when they are about to
 * do this — a labelled secret, a long high-entropy token, a private key block, an
 * `otpauth` URI. What gets through is a credential nobody labelled and that looks
 * like prose, and the answer to that is the tool description saying not to, which
 * is where the *discouraged* half legitimately lives.
 *
 * **Refusing wrongly is the cheaper failure and that is why the patterns lean
 * strict.** A refused message is rewritten in seconds by a caller who is told
 * exactly what to do instead; a password written into the exchange cannot be
 * unwritten.
 */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /**
   * A labelled secret: `password: hunter2`, `api_key = sk-…`, `token → …`.
   *
   * The label is what makes this findable, and it is also what makes the match
   * safe: *"I could not remember the password"* has no value after it and is not
   * caught, because the value is what must not be here.
   */
  /\b(pass(?:word|phrase)?|pwd|secret|api[-_ ]?key|access[-_ ]?token|auth[-_ ]?token|bearer|credential|priv(?:ate)?[-_ ]?key|seed[-_ ]?phrase|mnemonic|otp|totp|2fa[-_ ]?(?:code|secret))\b\s*(?:is|are|=|:|->|→)\s*\S/i,
  /** A PEM block, in any of its forms. Nothing else looks like this. */
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /** A TOTP enrolment URI, which carries the shared secret in a query parameter. */
  /\botpauth:\/\//i,
  /**
   * A vendor-prefixed key: `sk-…`, `ghp_…`, `xoxb-…`, `AKIA…`.
   *
   * The prefixes are what keep this from matching ordinary words — the length
   * floor alone would catch a long URL.
   */
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}|\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{16,}|\bxox[baprs]-[A-Za-z0-9-]{10,}|\bAKIA[0-9A-Z]{16}\b/,
  /**
   * A long unbroken high-entropy run: 32 characters or more mixing letters and
   * digits, with no spaces.
   *
   * This is the one pattern that can be wrong, and the bound is set where it is
   * because of what else is that shape. A URL is excluded by the `/` and `.`
   * outside the class; a uuid by its hyphens; an English word by needing both a
   * digit and a letter. What is left at 32 characters is overwhelmingly a key.
   */
  /(?<![A-Za-z0-9])(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{32,}(?![A-Za-z0-9])/,
]

/**
 * Whether this text is carrying something that belongs in the vault.
 *
 * Exported so the refusal is one function with one set of tests rather than a
 * pattern list copied into the citizen's path and the operator's. **Both
 * directions are checked**: `#236` names the citizen's ask as the obvious case,
 * but the answer is where a password is most likely to actually arrive — an
 * operator who has just created an account is holding one.
 */
export function looksLikeCredential(text: string): boolean {
  return CREDENTIAL_PATTERNS.some((pattern) => pattern.test(text))
}

/**
 * What both surfaces say when they refuse one.
 *
 * **It names the vault, because a refusal that only says no leaves the citizen
 * with the same problem and no route.** Written once here so the citizen reading
 * it over MCP and the operator reading it in a browser are told the same thing.
 */
export const CREDENTIAL_REFUSAL_MESSAGE =
  'This message looks like it contains a password, key or code, and the Colony will not ' +
  'carry one here — it would end up in a mail, in a web form and in the database, and none ' +
  'of those can be taken back. Ask for the account to be created and for the credential to ' +
  'be put in the vault with kolonie.vault.set, then read it from there. Say what you need ' +
  'without the secret itself and send it again.'

/** One message in an exchange, as the citizen reads it back. */
export const OperatorRequestMessageSchema = z.object({
  author: OperatorRequestAuthorSchema,
  body: z.string().min(OPERATOR_MESSAGE_MIN_LENGTH).max(OPERATOR_MESSAGE_MAX_LENGTH),
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
export const OperatorRequestSchema = z.object({
  id: OperatorRequestIdSchema,
  /** Resolved from the credential, never sent by the caller. */
  agentId: AgentIdSchema,
  /**
   * The task or quest this is about. Never null — a request that belongs to
   * nothing is what `#236` refuses, and the column is what refuses it.
   */
  taskId: TaskIdSchema,
  /** What the task is called, so a citizen reading its exchange back sees it. */
  taskTitle: z.string(),
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
  /** The whole sequence, oldest first. Append-only; nothing here was ever edited. */
  messages: z.array(OperatorRequestMessageSchema),
})
export type OperatorRequest = z.infer<typeof OperatorRequestSchema>

/**
 * What a citizen sends to open one.
 *
 * No agent id, like every other authenticated write: the credential is the
 * identity.
 */
export const OpenOperatorRequestSchema = z.object({
  taskId: TaskIdSchema,
  body: z.string().min(OPERATOR_MESSAGE_MIN_LENGTH).max(OPERATOR_MESSAGE_MAX_LENGTH),
})
export type OpenOperatorRequest = z.infer<typeof OpenOperatorRequestSchema>

/** What a citizen sends to add to the exchange it already has open. */
export const ReplyToOperatorRequestSchema = z.object({
  requestId: OperatorRequestIdSchema,
  body: z.string().min(OPERATOR_MESSAGE_MIN_LENGTH).max(OPERATOR_MESSAGE_MAX_LENGTH),
})
export type ReplyToOperatorRequest = z.infer<typeof ReplyToOperatorRequestSchema>

/** What the operator posts from the durable page. The token is in the URL. */
export const AnswerOperatorRequestSchema = z.object({
  requestId: OperatorRequestIdSchema,
  body: z.string().min(OPERATOR_MESSAGE_MIN_LENGTH).max(OPERATOR_MESSAGE_MAX_LENGTH),
})
export type AnswerOperatorRequest = z.infer<typeof AnswerOperatorRequestSchema>

export const OperatorRequestResponseSchema = z.object({ request: OperatorRequestSchema })
export type OperatorRequestResponse = z.infer<typeof OperatorRequestResponseSchema>

/**
 * The caller's own exchanges, newest first.
 *
 * Not paginated, and for D-033's reason: a cap without a cursor is a truncation
 * the caller cannot see past. One citizen holds one open exchange at a time, so
 * the list grows with how often it has needed a human — which is a number small
 * enough that the whole of it is the right answer.
 */
export const ListOperatorRequestsResponseSchema = z.object({
  requests: z.array(OperatorRequestSchema),
})
export type ListOperatorRequestsResponse = z.infer<typeof ListOperatorRequestsResponseSchema>
