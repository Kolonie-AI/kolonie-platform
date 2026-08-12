import {
  AnswerOperatorRequestSchema,
  credentialFinding,
  credentialRefusalMessage,
  OpenOperatorRequestSchema,
  OperatorRequestIdSchema,
  ReplyToOperatorRequestSchema,
  type AgentId,
  type ApiError,
  type CredentialFinding,
  type ListOperatorRequestsResponse,
  type OperatorRequest,
  type OperatorRequestId,
  type OperatorRequestResponse,
  type TaskId,
  type WishId,
} from '@kolonie-ai/core'
import {
  answerOperatorRequest as answerInDatabase,
  closeOperatorRequest as closeInDatabase,
  listOperatorRequests as listInDatabase,
  exchangesForToken as exchangesForTokenInDatabase,
  openOperatorRequest as openInDatabase,
  operatorRequestRecipient as recipientInDatabase,
  readOperatorRequest as readInDatabase,
  replyToOperatorRequest as replyInDatabase,
  type AnswerOperatorRequestOutcome,
  type Database,
  type OpenExchangeForOperator,
  type OpenOperatorRequestOutcome,
  type OperatorRequestRecipient,
  type SettingsReader,
} from '@kolonie-ai/db'
import type { OperatorNotifier } from './operator-notifier.js'
import type { OutboundAllowance } from './support.js'
import type { WakeSender } from '@kolonie-ai/verifiers'
import { exchangeAnchor } from './autonomy-page.js'

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
  open(
    input: { readonly agentId: AgentId; readonly body: string } & (
      | { readonly taskId: TaskId; readonly wishId?: never }
      | { readonly taskId?: never; readonly wishId: WishId }
    ),
  ): Promise<OpenOperatorRequestOutcome>
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
  /**
   * Every exchange this page shows (`#593`).
   *
   * **A list and not one row.** The single-row version was `limit(1)` with no
   * `order by`, so an agent with two open questions had one of them shown and
   * which one was the query planner's choice.
   */
  exchangesForToken(token: string): Promise<readonly OpenExchangeForOperator[]>
  answer(input: {
    readonly token: string
    readonly requestId: OperatorRequestId
    readonly body: string
  }): Promise<AnswerOperatorRequestOutcome>
}

/** Wired to a real database. The only place the two meet. */
export function databaseOperatorRequestStore(
  db: Database,
  settings: SettingsReader,
): OperatorRequestStore {
  return {
    open: (input) => openInDatabase(db, input, settings),
    reply: (input) => replyInDatabase(db, input),
    close: (input) => closeInDatabase(db, input),
    read: (query) => readInDatabase(db, query),
    list: (agentId) => listInDatabase(db, agentId),
    recipient: (agentId) => recipientInDatabase(db, agentId),
    exchangesForToken: (token) => exchangesForTokenInDatabase(db, token),
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
   * Sends the one notification, by whichever channel this operator has (`#794`).
   *
   * Optional like the autonomy module's, and absent means the request is not
   * opened: an exchange nobody was told about would leave the citizen waiting on
   * an answer that could never come, and a configuration gap must never look like
   * an operator who did not reply.
   *
   * **A port and not a mailer since `#794`.** It was an {@link OperatorMailer}
   * (`#474`) — operator-facing mail, with the console's sender bound rather than
   * the Academy's — and that implementation is still the one every deployment
   * without a Telegram bot gets. What changed is that the choice of transport is
   * made once at wiring time rather than by an `if` on this path, which is how
   * one of two branches quietly stops being tested.
   */
  readonly notifier?: OperatorNotifier | undefined
  /** Where the operator's page lives, from configuration — never a host in code. */
  readonly pageBaseUrl?: string | undefined
  /**
   * The wake channel (`#518`), used on exactly one path: an operator answering.
   *
   * **Optional, and absent means today's behaviour.** A deployment without a
   * channel — and every test that does not care — records the answer and the
   * agent reads it on its own rhythm, which is the guarantee the rung is
   * required not to weaken.
   */
  readonly wake?: WakeSender | undefined
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

/**
 * The refusal, naming what tripped it (`#335`).
 *
 * `details.reason` is the finding's class and never its value — a refusal
 * travels back through an API error, which is a place a credential must not go.
 * A citizen branches on `reason`; the message is what it reads.
 */
const credentialRefusal = (finding: CredentialFinding): ApiError => ({
  code: 'validation_failed',
  message: credentialRefusalMessage(finding),
  details: { body: 'must not contain a credential', reason: finding.reason },
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
        'A request names exactly one task or wanted account wish and says what you need. Send ' +
          'taskId from kolonie.tasks.list or wishId from kolonie.accounts.wishes, plus a message ' +
          'for the person who answers for you.',
        Object.fromEntries(
          parsed.error.issues.map((issue) => [issue.path.join('.'), issue.message]),
        ),
      ),
    }
  }

  const finding = credentialFinding(parsed.data.body)
  if (finding !== null) {
    return { outcome: 'rejected', error: credentialRefusal(finding) }
  }

  if (deps.notifier === undefined || deps.pageBaseUrl === undefined) {
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

  const opened =
    parsed.data.taskId === undefined
      ? await deps.store.open({
          agentId: input.agentId,
          body: parsed.data.body,
          wishId: parsed.data.wishId!,
        })
      : await deps.store.open({
          agentId: input.agentId,
          body: parsed.data.body,
          taskId: parsed.data.taskId,
        })

  if (opened.outcome === 'at-ceiling') {
    return {
      outcome: 'rejected',
      error: {
        code: 'conflict',
        message:
          'You already have as many requests open as the Colony carries at once. Finish or ' +
          'withdraw one of these before opening another: ' +
          opened.openRequests
            .map((request) => `“${request.context}” (${request.requestId})`)
            .join(', ') +
          '. Read them with kolonie.operator.request.read; nothing is held against you for ' +
          'closing one unanswered.',
        details: {
          openRequests: opened.openRequests
            .map((request) => `${request.requestId}:${request.context}`)
            .join(','),
        },
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

  if (opened.outcome === 'no-such-wish') {
    return {
      outcome: 'rejected',
      error: invalid(
        'There is no wanted account wish of yours with that id. Read kolonie.accounts.wishes ' +
          'and use the id of the provider your operator marked as wanted.',
        { wishId: 'must be a wanted wish belonging to you' },
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

  const link =
    `${deps.pageBaseUrl.replace(/\/+$/, '')}/operator/page/${recipient.pageToken}` +
    `#${exchangeAnchor(opened.request.id)}`
  /**
   * One channel, chosen by the notifier, charged once (`#794`).
   *
   * The allowance was spent above and before the transport was known, which is
   * the property that makes it impossible for a Telegram ask to be cheaper than a
   * mailed one — there is no path from here that could skip it.
   */
  const delivery = await deps.notifier.notify({
    agentId: input.agentId,
    agentName: input.agentName,
    context: opened.request.context,
    link,
    address: recipient.operatorAddress,
  })

  if (!delivery.delivered) {
    return {
      outcome: 'rejected',
      error: {
        code: 'internal',
        message:
          'The request is open, but the Colony could not deliver the message telling your ' +
          'operator about it. This is not your problem. They can still answer through the page ' +
          'they already have; if you would rather ask a different way, close this one with ' +
          'kolonie.operator.request.close.',
        details: { requestId: String(opened.request.id) },
      },
    }
  }

  return { outcome: 'opened', response: { request: opened.request } }
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

  const finding = credentialFinding(parsed.data.body)
  if (finding !== null) {
    return { outcome: 'rejected', error: credentialRefusal(finding) }
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
          'You have no request with that id — it may never have been yours, or it may never ' +
          'have existed, and the Colony does not distinguish the two, so no caller can use ' +
          'this to find out which request ids exist. A request of yours that is already ' +
          'closed is not one of these cases: you may reply into it, and doing so costs you ' +
          'neither your open-request slot nor a mail.',
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

  const finding = credentialFinding(parsed.data.body)
  if (finding !== null) {
    return { outcome: 'rejected', error: credentialRefusal(finding) }
  }

  const answered = await deps.store.answer({
    token: input.token,
    requestId: parsed.data.requestId,
    body: parsed.data.body,
  })

  if (answered.outcome !== 'answered') return { outcome: 'unreachable' }

  /**
   * **The operator's answer is the event** (`#518`).
   *
   * This is the one call site the wake channel was built for: a person replies
   * in one minute and, without it, the agent reads the reply at its next rhythm
   * — four to six hours later, which makes an onboarding ceremony a two-day
   * project.
   *
   * **Awaited and ignored.** The answer is already written and the operator is
   * owed a reply either way; a citizen whose endpoint has stopped answering
   * falls back to polling, which is what every citizen has today. Nothing about
   * this line may reach the operator's screen.
   */
  await deps.wake?.wake(answered.agentId, 'operator-answer')

  return { outcome: 'answered' }
}

/**
 * Whether this citizen is waiting on an answer right now (#564).
 *
 * **The question the operator page has to ask before it draws a second box.** An
 * exchange that is open and carries no message from the operator is a question
 * in front of a person; anything else is not.
 *
 * A citizen reported the failure this exists for: their operator wrote *"yes,
 * you may"* on the operator page, in the box that was in front of them, and the
 * rung went on answering `awaitingOperator` — because the words went to
 * `operator_notes` and the rung reads `operator_request_messages`. Neither of
 * them was wrong about what they could see.
 */
export function isWaitingOnTheOperator(
  exchanges: readonly {
    readonly closed: boolean
    readonly messages: readonly { readonly author: string }[]
  }[],
): boolean {
  /**
   * **Any of them** (`#593`). A note posted while two questions are open leaves
   * both open, and the confirmation page's whole job is to say so — telling an
   * operator *nothing is still waiting* because the first of two had been
   * answered is the sentence this function exists to prevent, one question late.
   */
  return exchanges.some(
    (exchange) =>
      !exchange.closed && !exchange.messages.some((message) => message.author === 'operator'),
  )
}
