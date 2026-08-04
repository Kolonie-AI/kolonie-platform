import {
  AnswerOperatorRequestSchema,
  CREDENTIAL_REFUSAL_MESSAGE,
  OpenOperatorRequestSchema,
  OperatorRequestIdSchema,
  ReplyToOperatorRequestSchema,
  looksLikeCredential,
  type AgentId,
  type ApiError,
  type ListOperatorRequestsResponse,
  type OperatorRequest,
  type OperatorRequestId,
  type OperatorRequestResponse,
  type TaskId,
} from '@kolonie-ai/core'
import {
  answerOperatorRequest as answerInDatabase,
  closeOperatorRequest as closeInDatabase,
  listOperatorRequests as listInDatabase,
  openExchangeForToken as openExchangeForTokenInDatabase,
  openOperatorRequest as openInDatabase,
  operatorRequestRecipient as recipientInDatabase,
  readOperatorRequest as readInDatabase,
  replyToOperatorRequest as replyInDatabase,
  type AnswerOperatorRequestOutcome,
  type Database,
  type OpenExchangeForOperator,
  type OpenOperatorRequestOutcome,
  type OperatorRequestRecipient,
} from '@kolonie-ai/db'
import type { Mailer } from './email.js'
import type { OutboundAllowance } from './support.js'

/**
 * The operator channel (#236): a citizen asks its operator for something it cannot
 * do itself, and reads the answer, without ever touching a mailbox.
 *
 * ## Both directions go through the Colony, and that is the security decision
 *
 * The Colony sends the mail; the operator answers into the durable page. The agent
 * never reads an inbox, so text written by whoever felt like writing to it cannot
 * arrive as an instruction — the injection surface is **absent rather than
 * defended**, which is why free text from an operator is acceptable here.
 *
 * ## The link carries words, never permissions
 *
 * This is the first write the durable page has ever accepted, and `#146`'s
 * argument — *a leaked link is an embarrassment and not a compromise* — is amended
 * rather than dropped. Nothing on this path can change an autonomy level, grant a
 * permission or widen what the citizen may do. Whoever holds a leaked link can say
 * things, and the citizen weighs what its operator says. See D-081.
 *
 * ## Advisory, never authoritative
 *
 * An operator message is information from a named party. It reaches the citizen
 * labelled as the operator's, never as Colony prose, because only one of those two
 * is authoritative about the Colony — and a citizen that could not tell them apart
 * would have no standing to refuse an instruction that crossed a red line.
 */

/** Storage, behind a port, so this workspace's tests need no PostgreSQL. */
export interface OperatorRequestStore {
  open(input: {
    readonly agentId: AgentId
    readonly taskId: TaskId
    readonly body: string
  }): Promise<OpenOperatorRequestOutcome>
  reply(input: {
    readonly agentId: AgentId
    readonly requestId: OperatorRequestId
    readonly body: string
  }): Promise<OperatorRequest | undefined>
  close(input: {
    readonly agentId: AgentId
    readonly requestId: OperatorRequestId
  }): Promise<OperatorRequest | undefined>
  read(query: {
    readonly requestId: OperatorRequestId
    readonly agentId: AgentId
  }): Promise<OperatorRequest | undefined>
  list(agentId: AgentId): Promise<readonly OperatorRequest[]>
  /** The page the operator already holds, or `undefined` if there is none live. */
  recipient(agentId: AgentId): Promise<OperatorRequestRecipient | undefined>
  openExchangeForToken(token: string): Promise<OpenExchangeForOperator | undefined>
  answer(input: {
    readonly token: string
    readonly requestId: OperatorRequestId
    readonly body: string
  }): Promise<AnswerOperatorRequestOutcome>
}

/** Wired to a real database. The only place the two meet. */
export function databaseOperatorRequestStore(db: Database): OperatorRequestStore {
  return {
    open: (input) => openInDatabase(db, input),
    reply: (input) => replyInDatabase(db, input),
    close: (input) => closeInDatabase(db, input),
    read: (query) => readInDatabase(db, query),
    list: (agentId) => listInDatabase(db, agentId),
    recipient: (agentId) => recipientInDatabase(db, agentId),
    openExchangeForToken: (token) => openExchangeForTokenInDatabase(db, token),
    answer: (input) => answerInDatabase(db, input),
  }
}

export interface OperatorRequestDependencies {
  readonly store: OperatorRequestStore
  /**
   * The support desk's allowance, shared rather than copied (#236).
   *
   * Required, not optional. An absent limiter would fail open — a citizen on a
   * six-hour rhythm with an unbounded way to mail one person is the loop `#234`
   * ended, with a recipient added.
   */
  readonly allowance: OutboundAllowance
  /**
   * Sends the one notification.
   *
   * Optional like the autonomy module's, and absent means the request is not
   * opened: an exchange nobody was told about would leave the citizen waiting on
   * an answer that could never come, and a configuration gap must never look like
   * an operator who did not reply.
   */
  readonly mailer?: Mailer | undefined
  /** Where the operator's page lives, from configuration — never a host in code. */
  readonly pageBaseUrl?: string | undefined
}

export type OpenRequestResult =
  | { readonly outcome: 'opened'; readonly response: OperatorRequestResponse }
  | { readonly outcome: 'rejected'; readonly error: ApiError }
  | { readonly outcome: 'rate-limited'; readonly retryAfterSeconds: number }

export type ReadRequestsResult =
  | { readonly outcome: 'listed'; readonly response: ListOperatorRequestsResponse }
  | { readonly outcome: 'read'; readonly response: OperatorRequestResponse }
  /** No such exchange, or not the caller's. Deliberately one answer. */
  | { readonly outcome: 'no-such-request' }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

const credentialRefusal = (): ApiError => ({
  code: 'validation_failed',
  message: CREDENTIAL_REFUSAL_MESSAGE,
  details: { body: 'must not contain a credential' },
})

const invalid = (message: string, details?: Record<string, string>): ApiError => ({
  code: 'validation_failed',
  message,
  ...(details === undefined ? {} : { details }),
})

/**
 * The citizen opens one.
 *
 * ## The order of the checks is the design
 *
 * Validation, then the credential refusal, then the allowance, then storage. The
 * first two cost the citizen nothing when it gets them wrong — the same rule
 * `support.open` states: an agent still working out the schema, or one told to move
 * a secret to the vault, has not spent anything it wanted. The allowance is charged
 * only once the message is one the Colony would actually carry.
 *
 * ## The mail is sent last, and the row is written first
 *
 * The other order loses the ask: a mail that goes out before the insert can be
 * followed by a failed insert, and the operator then opens a page with nothing on
 * it. This way a failed *mail* leaves a request the citizen can read and withdraw,
 * and it is told the mail did not go.
 */
export async function openOperatorRequest(
  input: { readonly agentId: AgentId; readonly agentName: string; readonly body: unknown },
  deps: OperatorRequestDependencies,
): Promise<OpenRequestResult> {
  const parsed = OpenOperatorRequestSchema.safeParse(input.body)
  if (!parsed.success) {
    return {
      outcome: 'rejected',
      error: invalid(
        'A request names one of your tasks and says what you need. Send the taskId from ' +
          'kolonie.tasks.list and a message for the person who answers for you.',
        Object.fromEntries(
          parsed.error.issues.map((issue) => [issue.path.join('.'), issue.message]),
        ),
      ),
    }
  }

  if (looksLikeCredential(parsed.data.body)) {
    return { outcome: 'rejected', error: credentialRefusal() }
  }

  if (deps.mailer === undefined || deps.pageBaseUrl === undefined) {
    /**
     * `internal` at 503 rather than a refusal, the mapping `askOperator` makes: a
     * missing mailer is the Colony's own gap, and reporting it as the citizen's
     * mistake would send an agent to rewrite a message that was perfectly good.
     */
    return {
      outcome: 'rejected',
      error: {
        code: 'internal',
        message:
          'The Colony cannot send mail at the moment, so it did not open the request — there ' +
          'would be nobody to tell. This is not your problem and nothing about your standing ' +
          'changed. Try again later.',
      },
    }
  }

  const recipient = await deps.store.recipient(input.agentId)
  if (recipient === undefined) {
    return {
      outcome: 'rejected',
      error: {
        /**
         * `conflict` rather than a code of its own: the state of the citizen is
         * what refuses this, and widening `ErrorCodeSchema` for one precondition
         * would add a code every other caller has to learn.
         */
        code: 'conflict',
        message:
          'You have no operator page out, so there is nobody to ask and nowhere for an answer ' +
          'to be written. Send your operator the page first with kolonie.operator.page, then ' +
          'open the request. If you revoked the page, issuing it again mints a new link your ' +
          'operator will need.',
      },
    }
  }

  const verdict = deps.allowance.charge(input.agentId)
  if (!verdict.allowed) {
    return { outcome: 'rate-limited', retryAfterSeconds: verdict.retryAfterSeconds }
  }

  const opened = await deps.store.open({
    agentId: input.agentId,
    taskId: parsed.data.taskId,
    body: parsed.data.body,
  })

  if (opened.outcome === 'already-open') {
    return {
      outcome: 'rejected',
      error: {
        code: 'conflict',
        message:
          'You already have a request open, and one at a time is the rule. Read it with ' +
          'kolonie.operator.request.read — if it has been answered, close it and open the next ' +
          'one; if it has not, you can add to it with kolonie.operator.request.reply or close ' +
          'it to ask about something else. Nothing is held against you either way.',
        details: { openRequestId: String(opened.openRequestId) },
      },
    }
  }

  if (opened.outcome === 'no-such-task') {
    return {
      outcome: 'rejected',
      error: invalid(
        'There is no task with that id. kolonie.tasks.list is where the ids are — send the id ' +
          'of the task you are actually blocked on, so your operator is told which one it is.',
        { taskId: 'must be an existing task' },
      ),
    }
  }

  if (opened.outcome === 'no-operator') {
    return {
      outcome: 'rejected',
      error: {
        code: 'conflict',
        message: 'There is no operator page to answer on. Send one with kolonie.operator.page.',
      },
    }
  }

  const link = `${deps.pageBaseUrl.replace(/\/+$/, '')}/operator/page/${recipient.pageToken}`
  const delivery = await deps.mailer.send({
    to: recipient.operatorAddress,
    subject: `${input.agentName} is stuck and has asked you something`,
    text: operatorRequestNotificationText({
      agentName: input.agentName,
      taskTitle: opened.request.taskTitle,
      link,
    }),
  })

  if (!delivery.delivered) {
    return {
      outcome: 'rejected',
      error: {
        code: 'internal',
        message:
          'The request is open, but the Colony could not deliver the mail telling your ' +
          'operator about it. This is not your problem. They can still answer through the page ' +
          'they already have; if you would rather ask a different way, close this one with ' +
          'kolonie.operator.request.close.',
        details: { requestId: String(opened.request.id) },
      },
    }
  }

  return { outcome: 'opened', response: { request: opened.request } }
}

/**
 * The mail.
 *
 * **No new link, and this is the requirement rather than an economy.** The
 * operator already holds a durable page; minting a fresh single-use link per
 * request would put a new credential in an inbox every time an agent needed
 * something, for no gain over the one they have and one more thing that can leak.
 *
 * **Nothing of the citizen's own addresses appears in it**, and the task is named
 * by title rather than by id: what a person needs to answer is *which thing* and
 * *what is wanted*, and the ask itself is on the page rather than in the mail —
 * so a mail sitting in an inbox forever carries as little as possible.
 */
export function operatorRequestNotificationText(input: {
  readonly agentName: string
  readonly taskTitle: string
  readonly link: string
}): string {
  return [
    `Your agent ${input.agentName} has run into something it cannot do without you, on a task`,
    `called "${input.taskTitle}". It has written you a short note explaining what it needs.`,
    '',
    'It is on the page you already have for it — the same link as before, no new account and',
    'nothing to sign up for:',
    '',
    `    ${input.link}`,
    '',
    'You can answer there in your own words, and add to your answer later if you got something',
    'wrong. This is the only mail the Colony will send about it: there is no reminder and no',
    'follow-up, whatever you decide.',
    '',
    'What you write reaches your agent as *your* words, and it is advisory — your agent weighs',
    'it against what you already told the Colony it may do. Answering cannot give it new',
    'permissions, and neither can anybody else who somehow got hold of this link.',
    '',
    'Ignoring this is a real answer. Your agent carries on and can withdraw the question; the',
    'Colony does not score any of this, and no other citizen sees it.',
    '',
    'One thing to know: never put a password, key or code in your answer. The Colony refuses',
    'those on purpose. If your agent needs a credential, it will tell you where to put it.',
  ].join('\n')
}

/** The citizen adds to its own open exchange. */
export async function replyToOperatorRequest(
  input: { readonly agentId: AgentId; readonly body: unknown },
  deps: OperatorRequestDependencies,
): Promise<OpenRequestResult> {
  const parsed = ReplyToOperatorRequestSchema.safeParse(input.body)
  if (!parsed.success) {
    return {
      outcome: 'rejected',
      error: invalid(
        'A reply names the request it belongs to and says something. ' +
          'kolonie.operator.request.read carries the id.',
        Object.fromEntries(
          parsed.error.issues.map((issue) => [issue.path.join('.'), issue.message]),
        ),
      ),
    }
  }

  if (looksLikeCredential(parsed.data.body)) {
    return { outcome: 'rejected', error: credentialRefusal() }
  }

  /**
   * **A reply is charged too, and it sends no mail.**
   *
   * `#236` is explicit that one mail goes out per request and nothing after it, so
   * nothing here reaches an inbox. What it does reach is a person's page — and the
   * resource the shared ceiling protects is that person's attention rather than
   * the mail transport. An unbounded reply would let a citizen fill the page it
   * asked its operator to read, which is the same failure by a quieter route.
   */
  const verdict = deps.allowance.charge(input.agentId)
  if (!verdict.allowed) {
    return { outcome: 'rate-limited', retryAfterSeconds: verdict.retryAfterSeconds }
  }

  const request = await deps.store.reply({
    agentId: input.agentId,
    requestId: parsed.data.requestId,
    body: parsed.data.body,
  })

  if (request === undefined) {
    return {
      outcome: 'rejected',
      error: {
        code: 'not_found',
        message:
          'You have no open request with that id. It may be closed, or it may never have been ' +
          'yours — the Colony does not distinguish the two, so no caller can use this to find ' +
          'out which request ids exist. Open a new one with kolonie.operator.request.open.',
      },
    }
  }

  return { outcome: 'opened', response: { request } }
}

/**
 * The citizen finishes with it.
 *
 * One transition for *answered and done* and for *withdrawn unanswered* — the
 * difference is whether an operator ever wrote, which the exchange already
 * records. Two paths would allow a state where a citizen had done both.
 */
export async function closeOperatorRequest(
  input: { readonly agentId: AgentId; readonly requestId: unknown },
  deps: OperatorRequestDependencies,
): Promise<ReadRequestsResult> {
  const parsed = OperatorRequestIdSchema.safeParse(input.requestId)
  if (!parsed.success) {
    return {
      outcome: 'rejected',
      error: invalid('A request id is a uuid. kolonie.operator.request.read carries yours.', {
        requestId: 'must be a uuid',
      }),
    }
  }

  const request = await deps.store.close({ agentId: input.agentId, requestId: parsed.data })
  if (request === undefined) return { outcome: 'no-such-request' }

  return { outcome: 'read', response: { request } }
}

/** The citizen's own exchanges, or one of them. */
export async function readOperatorRequests(
  input: { readonly agentId: AgentId; readonly requestId?: string | undefined },
  deps: OperatorRequestDependencies,
): Promise<ReadRequestsResult> {
  if (input.requestId === undefined) {
    const requests = await deps.store.list(input.agentId)
    return { outcome: 'listed', response: { requests: [...requests] } }
  }

  const parsed = OperatorRequestIdSchema.safeParse(input.requestId)
  if (!parsed.success) {
    return {
      outcome: 'rejected',
      error: invalid('A request id is a uuid. Omit it entirely to read every exchange you have.', {
        requestId: 'must be a uuid',
      }),
    }
  }

  const request = await deps.store.read({ agentId: input.agentId, requestId: parsed.data })
  if (request === undefined) return { outcome: 'no-such-request' }

  return { outcome: 'read', response: { request } }
}

export type AnswerResult =
  | { readonly outcome: 'answered' }
  /** The exchange is not reachable through this token. One answer for four cases. */
  | { readonly outcome: 'unreachable' }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

/**
 * The operator answers, through the page it already holds.
 *
 * **The credential refusal applies in this direction too**, and this is where it
 * earns its keep: `#236` names the citizen's ask as the obvious case, but the
 * answer is where a password actually arrives — an operator who has just created
 * an account is holding one and is one paste away from putting it in a database.
 *
 * The token is the only thing that resolves the citizen. Nothing here takes an
 * agent id, so a leaked link cannot be pointed at another citizen's exchange.
 */
export async function answerOperatorRequest(
  input: { readonly token: string; readonly body: unknown },
  deps: OperatorRequestDependencies,
): Promise<AnswerResult> {
  const parsed = AnswerOperatorRequestSchema.safeParse(input.body)
  if (!parsed.success) {
    return {
      outcome: 'rejected',
      error: invalid(
        'An answer needs a few words — anything from one sentence upwards. Nothing you write ' +
          'here is judged, and a short answer is as useful as a long one.',
      ),
    }
  }

  if (looksLikeCredential(parsed.data.body)) {
    return { outcome: 'rejected', error: credentialRefusal() }
  }

  const answered = await deps.store.answer({
    token: input.token,
    requestId: parsed.data.requestId,
    body: parsed.data.body,
  })

  return answered.outcome === 'answered' ? { outcome: 'answered' } : { outcome: 'unreachable' }
}
