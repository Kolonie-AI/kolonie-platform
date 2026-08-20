import {
  AnswerOperatorThreadSchema,
  credentialFinding,
  credentialRefusalMessage,
  OPERATOR_ANSWER_BODIES,
  type AgentId,
  type ApiError,
  type ConversationId,
  type CredentialFinding,
  type OperatorAnswerKind,
} from '@kolonie-ai/core'
import type { OperatorThreadForPage } from '@kolonie-ai/db'
import type { WakeSender } from '@kolonie-ai/verifiers'

/**
 * The operator channel as the durable page sees it, on messaging (`#1325`,
 * epic `#1318`).
 *
 * **This file is what `operator-requests.ts` was, minus everything the exchange
 * was carrying that a thread does not need.** The channel's decisions are
 * unchanged and worth restating, because the module they were written on is
 * gone:
 *
 * ## Both directions go through the Colony, and that is the security decision
 *
 * The Colony sends the ping; the operator answers into the durable page. The
 * agent never reads an inbox, so text written by whoever felt like writing to it
 * cannot arrive as an instruction. The epic gave up half of that on purpose
 * (decision 8) — a citizen now reads a thread a stranger may have opened — and
 * what compensates is the `MESSAGE_UNTRUSTED_CONTENT` marking and the credential
 * guard below.
 *
 * ## The link carries words, never permissions
 *
 * Nothing on this path can change an autonomy level, grant a permission or widen
 * what the citizen may do. Whoever holds a leaked link can say things, and the
 * citizen weighs what its operator says. D-081, unamended by the move.
 *
 * ## Advisory, never authoritative
 *
 * An operator message reaches the citizen labelled as the operator's, never as
 * Colony prose, because only one of those two is authoritative about the Colony
 * — and a citizen that could not tell them apart would have no standing to
 * refuse an instruction that crossed a red line. `senderParty` is what carries
 * it now; the exchange carried an `author` column for the same reason.
 */

/** Storage, behind a port, so this workspace's tests need no PostgreSQL. */
export interface OperatorThreadStore {
  /** Every thread the page's own subject is in, oldest first. */
  forPageToken(token: string): Promise<readonly OperatorThreadForPage[]>
  /** Which of a citizen's wishes have an unanswered question against them (`#1027`). */
  wishesWaiting(
    agentId: AgentId,
  ): Promise<readonly { readonly wishId: string; readonly threadId: ConversationId }[]>
  /**
   * Write the operator's words into one thread the page reaches.
   *
   * Resolves the token and the thread id **together**, so a valid link cannot be
   * aimed at another citizen's conversation — the property `#241` and `#399`
   * both rest on, and the one thing this port may not delegate to its caller.
   */
  answerOnPage(input: {
    readonly token: string
    readonly threadId: unknown
    readonly body: string
    readonly kind?: OperatorAnswerKind | undefined
  }): Promise<
    | { readonly outcome: 'answered'; readonly agentId: AgentId; readonly threadId: ConversationId }
    | { readonly outcome: 'unreachable' }
  >
}

export interface OperatorThreadDependencies {
  readonly store: OperatorThreadStore
  /**
   * How the citizen is told, on the one event this channel has (`#518`).
   *
   * Optional: a deployment with no wake channel leaves the citizen to read the
   * answer at its next rhythm, which is what every citizen without one does.
   */
  readonly wake?: WakeSender | undefined
}

export type AnswerResult =
  | { readonly outcome: 'answered' }
  /** The thread is not reachable through this token. One answer for every cause. */
  | { readonly outcome: 'unreachable' }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

const invalid = (message: string): ApiError => ({ code: 'validation_failed', message })

const credentialRefusal = (finding: CredentialFinding): ApiError => ({
  code: 'validation_failed',
  message: credentialRefusalMessage(finding),
})

/**
 * The operator answers, through the page it already holds.
 *
 * **The credential refusal applies in this direction too**, and this is where it
 * earns its keep: `#236` names the citizen's ask as the obvious case, but the
 * answer is where a password actually arrives — an operator who has just created
 * an account is holding one and is one paste away from putting it in a database.
 *
 * The token is the only thing that resolves the citizen. Nothing here takes an
 * agent id, so a leaked link cannot be pointed at another citizen's thread.
 */
export async function answerOperatorThread(
  input: { readonly token: string; readonly body: unknown },
  deps: OperatorThreadDependencies,
): Promise<AnswerResult> {
  const parsed = AnswerOperatorThreadSchema.safeParse(input.body)
  if (!parsed.success) {
    return {
      outcome: 'rejected',
      error: invalid(
        'An answer needs a few words — anything from one sentence upwards. Nothing you write ' +
          'here is judged, and a short answer is as useful as a long one.',
      ),
    }
  }

  /**
   * **The words come from the Colony when a control was pressed** (`#1093`).
   *
   * The page posts the kind alone, and the sentence is resolved here from the one
   * table in core. That is what makes it impossible for a message declared
   * `permission` to carry a body saying the thing was done — the two halves of the
   * answer are never independently supplied, so they cannot disagree.
   *
   * It also fixes the reading for a citizen that ignores the field entirely:
   * `kolonie.messages.get_thread` renders `body` verbatim, and these bodies say
   * in words which of the two answers this is.
   */
  const body =
    parsed.data.kind === undefined
      ? (parsed.data.body as string)
      : OPERATOR_ANSWER_BODIES[parsed.data.kind]

  const finding = credentialFinding(body)
  if (finding !== null) {
    return { outcome: 'rejected', error: credentialRefusal(finding) }
  }

  const answered = await deps.store.answerOnPage({
    token: input.token,
    threadId: parsed.data.threadId,
    body,
    ...(parsed.data.kind === undefined ? {} : { kind: parsed.data.kind }),
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
 * **The question the operator page has to ask before it draws a second box.** A
 * live thread carrying no message from the operator is a question in front of a
 * person; anything else is not.
 *
 * A citizen reported the failure this exists for: their operator wrote *"yes,
 * you may"* on the operator page, in the box that was in front of them, and the
 * rung went on answering `awaitingOperator` — because the words went to
 * `operator_notes` and the rung read the other table. Neither of them was wrong
 * about what they could see.
 */
export function isWaitingOnTheOperator(
  threads: readonly {
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
  return threads.some(
    (thread) => !thread.closed && !thread.messages.some((message) => message.author === 'operator'),
  )
}
