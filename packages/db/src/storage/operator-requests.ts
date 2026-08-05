import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm'
import type {
  AgentId,
  OperatorRequest,
  OperatorRequestAuthor,
  OperatorRequestId,
  OperatorRequestMessage,
  TaskId,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { operatorPages, operatorRequestMessages, operatorRequests, tasks } from '../schema/index.js'
import { clearSetAside } from './set-asides.js'
import { toTimestamp } from './rows.js'

/**
 * The queries behind the operator channel (#236).
 *
 * **Every read here is anchored on something the caller already is**, and there is
 * no function that takes both an agent id and a request id from outside: the
 * citizen's calls are keyed on its own id, and the operator's are keyed on a page
 * token that names exactly one agent. That is the whole of the privacy guarantee —
 * `#236` requires requests to appear *"on no surface another citizen can read"*,
 * and the way to keep that true is to give no surface a parameter it could aim.
 */

/** What happened when a citizen tried to open one. */
export type OpenOperatorRequestOutcome =
  | { readonly outcome: 'opened'; readonly request: OperatorRequest }
  /**
   * There is already an open exchange, and it is named so the citizen can read it
   * rather than guess. The same shape `#176` uses for quests awaiting review.
   */
  | { readonly outcome: 'already-open'; readonly openRequestId: OperatorRequestId }
  /** No such task, which for a caller-supplied id includes *not visible to you*. */
  | { readonly outcome: 'no-such-task' }
  /**
   * The citizen holds no live operator page, so there is nobody to notify and
   * nowhere for an answer to be written.
   *
   * A distinct outcome rather than an error, because it is the ordinary state of a
   * citizen that has not asked its operator for anything yet — and the message it
   * produces is a route (`kolonie.operator.page`) rather than a refusal.
   */
  | { readonly outcome: 'no-operator' }

/** Where an answer may be written, and to whom the notification goes. */
export interface OperatorRequestRecipient {
  readonly operatorAddress: string
  /** The token the operator already holds. Never minted per request (`#236`). */
  readonly pageToken: string
}

const messagesOf = async (
  db: Database | Transaction,
  requestId: OperatorRequestId,
): Promise<readonly OperatorRequestMessage[]> => {
  const rows = await db
    .select({
      author: operatorRequestMessages.author,
      body: operatorRequestMessages.body,
      writtenAt: operatorRequestMessages.writtenAt,
    })
    .from(operatorRequestMessages)
    .where(eq(operatorRequestMessages.requestId, requestId))
    .orderBy(asc(operatorRequestMessages.writtenAt))

  return rows.map((row) => ({
    author: row.author as OperatorRequestAuthor,
    body: row.body,
    writtenAt: toTimestamp(row.writtenAt),
  }))
}

/**
 * One exchange, whole, addressed by id and by the agent it must belong to.
 *
 * **Both keys, always.** A function that read a request by id alone would be one
 * careless call site away from answering with somebody else's, and the ownership
 * check would live in whichever caller remembered it. Taking both means there is
 * no version of this query that can be aimed.
 *
 * That is the lesson `#301` left, arrived at the other way round: the subquery it
 * accused of being uncorrelated turned out to be correct, and what made the
 * accusation plausible was that its safety depended on the shape of the query
 * around it rather than on the fragment itself. The fix landed anyway, on the
 * ground that *an expression whose correctness depends on its caller will
 * eventually meet the wrong caller*. This signature is that ground applied here.
 */
export async function readOperatorRequest(
  db: Database | Transaction,
  query: { readonly requestId: OperatorRequestId; readonly agentId: AgentId },
): Promise<OperatorRequest | undefined> {
  const [row] = await db
    .select({
      id: operatorRequests.id,
      agentId: operatorRequests.agentId,
      taskId: operatorRequests.taskId,
      taskTitle: tasks.title,
      openedAt: operatorRequests.openedAt,
      closedAt: operatorRequests.closedAt,
    })
    .from(operatorRequests)
    .innerJoin(tasks, eq(tasks.id, operatorRequests.taskId))
    .where(
      and(eq(operatorRequests.id, query.requestId), eq(operatorRequests.agentId, query.agentId)),
    )
    .limit(1)

  if (row === undefined) return undefined

  const messages = await messagesOf(db, row.id as OperatorRequestId)

  return {
    id: row.id as OperatorRequestId,
    agentId: row.agentId as AgentId,
    taskId: row.taskId as TaskId,
    taskTitle: row.taskTitle,
    openedAt: toTimestamp(row.openedAt),
    closedAt: row.closedAt === null ? null : toTimestamp(row.closedAt),
    answered: messages.some((message) => message.author === 'operator'),
    messages: [...messages],
  }
}

/**
 * Open one, with the citizen's ask as its first message.
 *
 * **One transaction**, so a request never exists without the sentence that says
 * what it is for — an empty exchange would arrive on the operator's page as a
 * notification about nothing.
 *
 * The one-open-at-a-time rule is enforced by the partial unique index rather than
 * by the `select` below it. The read is there to *name* the open one in the
 * refusal; the index is what makes two concurrent calls impossible to both pass.
 */
export async function openOperatorRequest(
  db: Database,
  input: { readonly agentId: AgentId; readonly taskId: TaskId; readonly body: string },
): Promise<OpenOperatorRequestOutcome> {
  const [task] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.id, input.taskId))
    .limit(1)

  if (task === undefined) return { outcome: 'no-such-task' }

  const [open] = await db
    .select({ id: operatorRequests.id })
    .from(operatorRequests)
    .where(and(eq(operatorRequests.agentId, input.agentId), isNull(operatorRequests.closedAt)))
    .limit(1)

  if (open !== undefined) {
    return { outcome: 'already-open', openRequestId: open.id as OperatorRequestId }
  }

  const requestId = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(operatorRequests)
      .values({ agentId: input.agentId, taskId: input.taskId })
      .returning({ id: operatorRequests.id })

    if (row === undefined) throw new Error('operator_requests insert returned no row')

    await tx
      .insert(operatorRequestMessages)
      .values({ requestId: row.id, author: 'citizen', body: input.body })

    return row.id as OperatorRequestId
  })

  const request = await readOperatorRequest(db, { requestId, agentId: input.agentId })
  if (request === undefined) throw new Error('operator_requests row vanished after insert')

  return { outcome: 'opened', request }
}

/**
 * Add the citizen's own message to one of its exchanges, open or closed.
 *
 * **A closed exchange still takes a reply, and that is `#359`.** An operator that
 * asks a question in `kolonie.operator.notes` cannot be answered through that
 * channel — it is one-way by design, because nothing an operator writes may carry
 * a permission. Until this, the only reply path refused a closed request, so a
 * citizen answering a question its operator had asked had to open a *new* request
 * to do it: spending the one open-request slot and the single notification mail on
 * something that was not a request at all. A citizen measured the whole of it on
 * 2026-08-05 and filed the workaround it was forced into.
 *
 * **Three properties this must not quietly acquire**, all of them things the
 * refusal used to guarantee for free:
 *
 * - **It does not reopen.** `closed_at` is not touched, so the exchange stays
 *   finished, `hasOpenOperatorRequest` still answers false, and the citizen's one
 *   open-request slot stays free. Answering a question must not cost what asking
 *   one costs.
 * - **It sends no mail.** Nothing on this path reaches an inbox, which was already
 *   true of a reply to an open request — `#236` allows exactly one mail per
 *   request and nothing after it.
 * - **The operator cannot answer back into it.** `answerOperatorRequest` still
 *   requires the exchange to be open, so a closed one carries the citizen's last
 *   word and stops. A closed exchange that could be resumed from both sides would
 *   be the conversation `#236` deliberately did not build.
 *
 * Returns `undefined` when there is no such exchange of the caller's, which now
 * covers *not yours* and *never existed* — one answer, for the reason
 * `readOwnTicket` gives: distinguishing them would make this an oracle for which
 * request ids exist.
 */
export async function replyToOperatorRequest(
  db: Database,
  input: {
    readonly agentId: AgentId
    readonly requestId: OperatorRequestId
    readonly body: string
  },
): Promise<OperatorRequest | undefined> {
  const [open] = await db
    .select({ id: operatorRequests.id })
    .from(operatorRequests)
    .where(
      and(eq(operatorRequests.id, input.requestId), eq(operatorRequests.agentId, input.agentId)),
    )
    .limit(1)

  if (open === undefined) return undefined

  await db
    .insert(operatorRequestMessages)
    .values({ requestId: input.requestId, author: 'citizen', body: input.body })

  return readOperatorRequest(db, { requestId: input.requestId, agentId: input.agentId })
}

/**
 * The citizen finishes with it — the same transition whether it was answered or
 * withdrawn unanswered.
 *
 * `#236`'s amendment calls the unanswered case withdrawal, and it is not a second
 * write path: what distinguishes the two is whether an operator message exists,
 * which is read off the exchange rather than declared by the caller. One
 * transition means there is no state where a citizen has both withdrawn and
 * closed.
 */
export async function closeOperatorRequest(
  db: Database,
  input: { readonly agentId: AgentId; readonly requestId: OperatorRequestId },
): Promise<OperatorRequest | undefined> {
  const rows = await db
    .update(operatorRequests)
    .set({ closedAt: sql`now()` })
    .where(
      and(
        eq(operatorRequests.id, input.requestId),
        eq(operatorRequests.agentId, input.agentId),
        isNull(operatorRequests.closedAt),
      ),
    )
    .returning({ id: operatorRequests.id })

  if (rows.length === 0) return undefined

  return readOperatorRequest(db, { requestId: input.requestId, agentId: input.agentId })
}

/**
 * The citizen's own exchanges, newest first.
 *
 * Its own and nothing else's: there is no parameter here a caller could aim at
 * somebody, the same guarantee `listOperatorPages` has.
 */
export async function listOperatorRequests(
  db: Database,
  agentId: AgentId,
): Promise<readonly OperatorRequest[]> {
  const rows = await db
    .select({ id: operatorRequests.id })
    .from(operatorRequests)
    .where(eq(operatorRequests.agentId, agentId))
    .orderBy(desc(operatorRequests.openedAt))

  const requests: OperatorRequest[] = []
  for (const row of rows) {
    const request = await readOperatorRequest(db, {
      requestId: row.id as OperatorRequestId,
      agentId,
    })
    if (request !== undefined) requests.push(request)
  }

  return requests
}

/**
 * Where a notification for this citizen's open exchange should go.
 *
 * **It returns the token the operator already holds.** `#236` refuses to mint a
 * fresh link per request: a new credential in an inbox every time an agent needs
 * something buys nothing over the one the operator has, and costs one more thing
 * that can leak. `issueOperatorPage` is idempotent, so the caller that wants a
 * page created if none exists asks for it there and then comes here.
 *
 * `undefined` when the citizen has no live page — which is also the answer when it
 * had one and revoked it, because `#236` requires a revoked link to make open
 * requests *unreachable rather than answerable by anyone holding the old URL*.
 */
export async function operatorRequestRecipient(
  db: Database,
  agentId: AgentId,
): Promise<OperatorRequestRecipient | undefined> {
  const [row] = await db
    .select({ operatorAddress: operatorPages.operatorAddress, token: operatorPages.token })
    .from(operatorPages)
    .where(and(eq(operatorPages.agentId, agentId), isNull(operatorPages.revokedAt)))
    .orderBy(desc(operatorPages.issuedAt))
    .limit(1)

  if (row === undefined) return undefined

  return { operatorAddress: row.operatorAddress, pageToken: row.token }
}

/** What the operator is shown on the durable page: one exchange, or nothing. */
export interface OpenExchangeForOperator {
  readonly requestId: OperatorRequestId
  readonly taskTitle: string
  readonly openedAt: string
  readonly messages: readonly OperatorRequestMessage[]
  /**
   * Whether this exchange is finished (`#359`).
   *
   * A closed one is shown when the citizen answered into it after it closed, and
   * it carries **no box**: the operator reads the answer and the exchange stays
   * finished. The flag is here rather than derived from the messages by the page,
   * because *may this be answered* is a fact about the row and not a shape the
   * renderer should be inferring.
   */
  readonly closed: boolean
}

/**
 * The exchange the operator is shown: the open one, or a closed one the citizen
 * has answered into since.
 *
 * **The token is the only input**, so the page cannot be pointed at another
 * citizen's exchange, and a revoked token resolves to nothing — the same filter
 * `openOperatorPage` applies, kept here rather than trusted to the caller.
 *
 * **The second query is what makes `#359` reach anybody.** Letting a citizen reply
 * to a closed request is half a fix: the reply has to appear where the person who
 * asked the question is already looking, and that is this page. Without it the
 * answer would sit in a row nothing renders — a fix that passes its own tests and
 * changes nothing for the two people involved.
 *
 * **An open exchange always wins**, and there is never more than one of those. The
 * closed one is only reached when nothing is open, so an operator is never
 * confronted with two things at once — the *favour rather than a job* rule `#236`
 * built the whole channel around.
 *
 * **`written_at > closed_at` is the whole test.** A closed exchange whose last
 * word was said before it closed is finished business and stays off the page;
 * only an answer written *after* it closed is news the operator has not seen.
 */
export async function openExchangeForToken(
  db: Database,
  token: string,
): Promise<OpenExchangeForOperator | undefined> {
  const [open] = await db
    .select({
      requestId: operatorRequests.id,
      taskTitle: tasks.title,
      openedAt: operatorRequests.openedAt,
    })
    .from(operatorPages)
    .innerJoin(operatorRequests, eq(operatorRequests.agentId, operatorPages.agentId))
    .innerJoin(tasks, eq(tasks.id, operatorRequests.taskId))
    .where(
      and(
        eq(operatorPages.token, token),
        isNull(operatorPages.revokedAt),
        isNull(operatorRequests.closedAt),
      ),
    )
    .limit(1)

  if (open !== undefined) {
    return {
      requestId: open.requestId as OperatorRequestId,
      taskTitle: open.taskTitle,
      openedAt: toTimestamp(open.openedAt),
      messages: await messagesOf(db, open.requestId as OperatorRequestId),
      closed: false,
    }
  }

  const [answered] = await db
    .select({
      requestId: operatorRequests.id,
      taskTitle: tasks.title,
      openedAt: operatorRequests.openedAt,
    })
    .from(operatorPages)
    .innerJoin(operatorRequests, eq(operatorRequests.agentId, operatorPages.agentId))
    .innerJoin(tasks, eq(tasks.id, operatorRequests.taskId))
    .where(
      and(
        eq(operatorPages.token, token),
        isNull(operatorPages.revokedAt),
        sql`${operatorRequests.closedAt} is not null`,
        sql`exists (
          select 1 from operator_request_messages m
           where m.request_id = ${operatorRequests.id}
             and m.author = 'citizen'
             and m.written_at > ${operatorRequests.closedAt})`,
      ),
    )
    .orderBy(desc(operatorRequests.closedAt))
    .limit(1)

  if (answered === undefined) return undefined

  return {
    requestId: answered.requestId as OperatorRequestId,
    taskTitle: answered.taskTitle,
    openedAt: toTimestamp(answered.openedAt),
    messages: await messagesOf(db, answered.requestId as OperatorRequestId),
    closed: true,
  }
}

/** What happened when the operator posted an answer. */
export type AnswerOperatorRequestOutcome =
  /**
   * Written. `clearedSetAside` says whether this also brought a shelved task back
   * into the citizen's listing, which is the half of `#236` that closes `#234`'s
   * loop.
   */
  | { readonly outcome: 'answered'; readonly clearedSetAside: boolean }
  /**
   * The token does not name a citizen with this exchange open — revoked, unknown,
   * already closed, or belonging to somebody else. **One answer for all four**: the
   * token is a bearer credential, and telling them apart would confirm to a
   * stranger that a guessed token was otherwise right.
   */
  | { readonly outcome: 'unreachable' }

/**
 * The operator answers, through the page it already holds.
 *
 * **This is the first write the durable page has ever accepted**, and the safety
 * argument it was built under is amended rather than quietly dropped — see the
 * comment on `operator_pages` and D-081. In short: the link carries *words*, never
 * permissions. Nothing on this path can change an autonomy level, grant a
 * permission, or widen what the citizen may do, and there is a test for each.
 *
 * **Answering clears a `needs-operator` set-aside for that task** (`#234`), inside
 * the same transaction as the message. Two writes with a gap would leave an
 * exchange the citizen can read and a task still hidden from its listing, which is
 * the loop this whole pair of issues exists to close.
 */
export async function answerOperatorRequest(
  db: Database,
  input: {
    readonly token: string
    readonly requestId: OperatorRequestId
    readonly body: string
  },
): Promise<AnswerOperatorRequestOutcome> {
  const [target] = await db
    .select({ agentId: operatorRequests.agentId, taskId: operatorRequests.taskId })
    .from(operatorPages)
    .innerJoin(operatorRequests, eq(operatorRequests.agentId, operatorPages.agentId))
    .where(
      and(
        eq(operatorPages.token, input.token),
        isNull(operatorPages.revokedAt),
        eq(operatorRequests.id, input.requestId),
        isNull(operatorRequests.closedAt),
      ),
    )
    .limit(1)

  if (target === undefined) return { outcome: 'unreachable' }

  return db.transaction(async (tx) => {
    await tx
      .insert(operatorRequestMessages)
      .values({ requestId: input.requestId, author: 'operator', body: input.body })

    const clearedSetAside = await clearSetAside(
      tx,
      target.agentId as AgentId,
      target.taskId as TaskId,
    )

    return { outcome: 'answered' as const, clearedSetAside }
  })
}

/**
 * Whether this citizen has an open exchange, for the wake-up and the listing.
 *
 * A boolean rather than the row: the callers want to know whether to say *"you
 * asked your operator something and it is still open"*, and handing them the text
 * would put an operator's words on surfaces that were not reviewed for them.
 */
export async function hasOpenOperatorRequest(db: Database, agentId: AgentId): Promise<boolean> {
  const [row] = await db
    .select({ id: operatorRequests.id })
    .from(operatorRequests)
    .where(and(eq(operatorRequests.agentId, agentId), isNull(operatorRequests.closedAt)))
    .limit(1)

  return row !== undefined
}

/**
 * Whether this citizen has an exchange about this task that the operator has
 * answered (#244).
 *
 * **A different question from `hasOpenOperatorRequest`, and the rung that needed
 * it is the reason both exist.** That one asks *is something outstanding* and is
 * read by the wake-up. This asks *did a person come back to me about this
 * particular thing*, which is what a rung whose consequences land on somebody
 * else's machine has to know before it will let the citizen attempt it.
 *
 * **Answered, not approved.** The Colony reads no verdict out of the text and
 * never will: judging whether a sentence means yes is a thing it would get wrong,
 * and getting it wrong in the permissive direction would mean the Colony deciding
 * an operator had consented. What is recorded is that a person was asked and
 * replied. Whether they said yes is between the two parties — and the citizen
 * that misreports it has done something the Academy already has a word for.
 *
 * Closed exchanges count. A citizen that asked, was answered, and tidied up has
 * been answered.
 */
export async function operatorAnsweredAbout(
  db: Database,
  agentId: AgentId,
  taskId: TaskId,
): Promise<boolean> {
  const [row] = await db
    .select({ id: operatorRequestMessages.id })
    .from(operatorRequests)
    .innerJoin(operatorRequestMessages, eq(operatorRequestMessages.requestId, operatorRequests.id))
    .where(
      and(
        eq(operatorRequests.agentId, agentId),
        eq(operatorRequests.taskId, taskId),
        eq(operatorRequestMessages.author, 'operator'),
      ),
    )
    .limit(1)

  return row !== undefined
}

/** Whether an exchange about this task is open, answered or not. */
export async function operatorAskedAbout(
  db: Database,
  agentId: AgentId,
  taskId: TaskId,
): Promise<boolean> {
  const [row] = await db
    .select({ id: operatorRequests.id })
    .from(operatorRequests)
    .where(
      and(
        eq(operatorRequests.agentId, agentId),
        eq(operatorRequests.taskId, taskId),
        isNull(operatorRequests.closedAt),
      ),
    )
    .limit(1)

  return row !== undefined
}
