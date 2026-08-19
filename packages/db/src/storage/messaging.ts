import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import {
  MESSAGE_REQUEST_EXPIRY_DAYS,
  MESSAGE_REQUEST_PREVIEW_MAX_LENGTH,
  OPERATOR_ANSWER_BODIES,
  WAKEUP_MESSAGING_SAMPLE_CAP,
  looksLikeCredential,
  ConversationIdSchema,
  ConversationParticipantIdSchema,
  MessageIdSchema,
  MessageRequestIdSchema,
  type AgentId,
  type Conversation,
  type ConversationId,
  type ConversationKind,
  type ConversationParticipantId,
  type HumanId,
  type Message,
  type MessageId,
  type MessageParty,
  type MessagePriority,
  type MessageRefusal,
  type MessageRequest,
  type MessageRequestId,
  type MessageSender,
  type MessageSystemRole,
  type OperatorAnswerKind,
  type TaskId,
  type WakeupMessagingDelta,
  type WishId,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import {
  accountWishes,
  agents,
  humanAgents,
  messageBlocks,
  messageConversations,
  messageParticipants,
  messageReports,
  messageRequests,
  messages,
} from '../schema/index.js'
import { isAcceptedConnection } from './connections.js'
import { clearSetAside } from './set-asides.js'

/**
 * Sending, reading and refusing private messages (`#1285`, epic `#1284`).
 *
 * The rows are in `schema/messaging.ts` and the vocabulary is in
 * `@kolonie-ai/core`'s `message/message.ts`. **This file is where the delivery
 * matrix is a decision rather than a table in an issue**, and the whole of it is
 * the function {@link sendCitizenMessage} walks through, in this order:
 *
 * | From → To | Path |
 * |---|---|
 * | Unknown citizen → citizen | a **request**: the words are stored, the recipient is not in the conversation, and nothing is delivered until it accepts |
 * | Follow only | still a **request** — a follow grants nothing (`#1068`); the skip lives on an accepted **connection** (`#1294`) |
 * | Accepted connection | **direct**: both join now; no Message Request (`#1294`, frozen default 9) |
 * | Accepted request | the recipient joins; that and every later message deliver directly |
 * | Existing conversation participant | direct — including after a later disconnect (`#1294`: the agreement ended, the thread did not) |
 * | Verified operator-human → their citizen | direct, `operator-human`, never labelled system |
 * | System role → citizen | direct, server-attested `system-role` |
 * | Blocked sender | **refused, in words** — never a silent success |
 * | Citizen that takes no citizen mail | refused on the citizen path; system and operator unaffected |
 *
 * ## The ACL is one join and there is no second way in
 *
 * Every read here starts from the caller's own `message_participants` row. There
 * is no function that takes a conversation id and returns bodies without that
 * join, and none should be added: *may this caller read this* is the same
 * question as *is this caller in it*, and the day those become two questions is
 * the day one of them is answered wrongly somewhere.
 *
 * **The operator's side is the same join through a different column** (`#1288`):
 * {@link listOperatorConversations} and {@link readOperatorConversation} start
 * from a `human_id` participant row exactly as the citizen's start from an
 * `agent_id` one. That is what makes *one thread per human* a fact about the
 * rows rather than a filter, and it is why one operator cannot read another
 * operator's thread with the same citizen: there is no row of theirs in it.
 *
 * A citizen that is not a participant gets `not-a-participant` for a
 * conversation it is not in **and for one that does not exist**. The two are
 * deliberately indistinguishable — telling them apart would turn this surface
 * into a way to probe for conversations between other citizens.
 *
 * ## Sender kinds cannot be forged, and it is not this file that guarantees it
 *
 * There is no parameter anywhere below that a caller could put a party into.
 * {@link sendCitizenMessage} reads the party off the participant row it resolved
 * for the caller — which the database CHECK guarantees is a `citizen` row,
 * because a row carrying an `agent_id` cannot claim any other kind. The operator
 * and system paths are separate functions that take a `HumanId` and a
 * `MessageSystemRole`, and neither is reachable from a citizen's credential.
 *
 * ## Untrusted content
 *
 * Every body returned from here is text another party wrote. A surface that
 * hands one to an agent marks it as untrusted content and never as instruction
 * (`#1284`). Nothing in this file can enforce that; it is said here because this
 * is where the bodies come from.
 */

/** How many conversations one listing answers with. A ceiling, not a page. */
export const CONVERSATION_LIST_LIMIT = 50

/** How many messages one read of a conversation answers with, newest last. */
export const CONVERSATION_MESSAGE_LIMIT = 200

/**
 * What became of a send.
 *
 * **Three outcomes and not two**, because `requested` is not a kind of success
 * and not a kind of failure: the words were stored and the recipient has not
 * seen them. A caller that collapsed it into `delivered` would tell a citizen
 * its message had arrived, and one that collapsed it into a refusal would tell
 * it to try again — and it must not.
 */
export type SendResult =
  | {
      readonly outcome: 'delivered'
      readonly conversationId: ConversationId
      readonly messageId: MessageId
    }
  | {
      readonly outcome: 'requested'
      readonly conversationId: ConversationId
      readonly requestId: MessageRequestId
    }
  | { readonly outcome: 'refused'; readonly refusal: MessageRefusal }

export type ReadResult =
  | { readonly outcome: 'read'; readonly messages: readonly Message[] }
  | { readonly outcome: 'refused'; readonly refusal: MessageRefusal }

export type RequestDecision =
  | { readonly outcome: 'accepted'; readonly conversationId: ConversationId }
  | { readonly outcome: 'declined' }
  | { readonly outcome: 'refused'; readonly refusal: MessageRefusal }

const conversationId = (value: string): ConversationId => ConversationIdSchema.parse(value)
const participantId = (value: string): ConversationParticipantId =>
  ConversationParticipantIdSchema.parse(value)
const messageId = (value: string): MessageId => MessageIdSchema.parse(value)
const requestId = (value: string): MessageRequestId => MessageRequestIdSchema.parse(value)

/**
 * Whether an accepted connection lets a citizen skip the request gate
 * (`#1294`, child of epic `#1284` — frozen default 9).
 *
 * **An accepted connection is the trust edge; a follow is not.** {@link
 * isAcceptedConnection} answers only *both agreed*, so a pending ask, a
 * decline, or a one-way follow never satisfies this. The call site below is
 * after the block check and after the preference: a connection skips the
 * *request*, not a citizen's refusal of citizen mail.
 *
 * Disconnect does not tear down an existing thread — {@link
 * sharedCitizenConversation} still delivers between participants. Ending the
 * agreement only means a *new* first contact needs a request again.
 */
async function connectionSkipsRequest(
  db: Database,
  senderId: AgentId,
  recipientId: AgentId,
): Promise<boolean> {
  return await isAcceptedConnection(db, senderId, recipientId)
}

/** The citizen a handle names, or nothing. Candidates count; the erased and the absent do not. */
async function citizenByHandle(db: Database, handle: string) {
  const [row] = await db
    .select({
      id: agents.id,
      handle: agents.name,
      acceptsCitizenMessages: agents.acceptsCitizenMessages,
    })
    .from(agents)
    .where(
      and(
        sql`lower(${agents.name}) = lower(${handle})`,
        inArray(agents.status, ['candidate', 'citizen']),
        eq(agents.type, 'citizen'),
      ),
    )
    .limit(1)
  return row
}

/**
 * The conversation these two citizens already share, if there is one.
 *
 * A self-join rather than two queries, and the shape matters: a conversation
 * counts only when **both** parties hold a `citizen` participant row in it. That
 * is what makes a pending request invisible here — the recipient has no row yet,
 * so the sender's outbox conversation does not match and the send falls through
 * to the request branch, which finds the request it already made.
 */
async function sharedCitizenConversation(db: Database, a: AgentId, b: AgentId) {
  const mine = alias(messageParticipants, 'mine')
  const theirs = alias(messageParticipants, 'theirs')

  const [row] = await db
    .select({
      conversationId: mine.conversationId,
      participantId: mine.id,
      label: mine.label,
    })
    .from(mine)
    .innerJoin(theirs, and(eq(theirs.conversationId, mine.conversationId), eq(theirs.agentId, b)))
    .where(eq(mine.agentId, a))
    .orderBy(asc(mine.joinedAt))
    .limit(1)

  return row
}

/** Whether `owner` refuses `subject`. One row, one question. */
async function hasBlocked(db: Database, owner: AgentId, subject: AgentId): Promise<boolean> {
  const [row] = await db
    .select({ owner: messageBlocks.ownerAgentId })
    .from(messageBlocks)
    .where(and(eq(messageBlocks.ownerAgentId, owner), eq(messageBlocks.blockedAgentId, subject)))
    .limit(1)
  return row !== undefined
}

/**
 * Optional fields only {@link sendSystemMessage} may set (`#1289`).
 *
 * Absent on every citizen and operator path — `insertMessage` defaults them so
 * those callers stay free of a parameter they must not fill.
 */
export type SystemMessageFields = {
  readonly priority?: MessagePriority
  readonly actionRequired?: boolean
  readonly nextAction?: string
}

/**
 * What one thread is about, settled when it is opened (`#1319`, epic `#1318`).
 *
 * **At most one, and neither is the ordinary case.** A citizen writing to its
 * operator about nothing in particular names no task and no wish, and that is a
 * complete answer: `message_conversations_provenance` forbids a thread claiming
 * both and permits a thread claiming neither. It is deliberately *not* the
 * `<>` of `operator_requests_exactly_one_provenance` — an exchange had to be
 * about something, and a conversation does not.
 *
 * **Written once.** There is no function here that changes it, on purpose: see
 * {@link openDirectConversation}.
 */
export type ConversationProvenance = {
  readonly taskId?: TaskId | null
  readonly wishId?: WishId | null
}

/**
 * Write one message into a conversation the sender is already a participant of.
 *
 * The snapshot is copied off the participant row rather than passed in, which is
 * the mechanical half of *a citizen cannot forge a sender kind*: there is no
 * argument here for a party, a label or a role. System fields are the same
 * shape of rule (`#1289`): only a caller that already holds a
 * {@link MessageSystemRole} reaches the branch that sets them.
 *
 * The declaration a person makes about their own answer (`#1319`) is the third
 * of these, and the narrowest: `answer_kind` is written only where the party is
 * already `operator-human`, so a citizen calling any of the send paths below
 * cannot reach it whatever it passes. The database says the same thing again in
 * `messages_answer_kind_party`, because a rule that only one layer holds is a
 * rule one refactor removes.
 */
async function insertMessage(
  db: Database | Transaction,
  participant: {
    id: string
    conversationId: string
    party: MessageParty
    label: string
    systemRole: MessageSystemRole | null
  },
  body: string,
  system?: SystemMessageFields,
  answerKind?: OperatorAnswerKind,
): Promise<MessageId> {
  const isSystem = participant.party === 'system-role'
  const isOperator = participant.party === 'operator-human'
  const [row] = await db
    .insert(messages)
    .values({
      conversationId: participant.conversationId,
      senderParticipantId: participant.id,
      senderParty: participant.party,
      senderLabel: participant.label,
      senderSystemRole: participant.systemRole,
      body,
      ...(isSystem
        ? {
            priority: system?.priority ?? 'normal',
            actionRequired: system?.actionRequired ?? false,
            nextAction: system?.nextAction ?? null,
          }
        : {}),
      ...(isOperator ? { answerKind: answerKind ?? null } : {}),
    })
    .returning({ id: messages.id })

  if (row === undefined) throw new Error('inserting a message returned no row')
  return messageId(row.id)
}

/**
 * Whether this body is one the Colony will not carry (`#1320`).
 *
 * **Applied to what a citizen or a person wrote, and to nothing else.** The
 * three send paths below are the ones with an author outside the Colony;
 * {@link sendSystemMessage} deliberately has no such check, because a guard
 * against the Colony pasting a credential into its own prose is a guard on the
 * wrong party.
 *
 * **A shape test, applied before anything is written**, on the same rule the
 * block check follows: a refused body causes no row, no conversation and no
 * request to appear anywhere. It is the detector the operator channel has used
 * since `#335`, which is why a message that would have been refused at
 * `kolonie.operator.request.open` is refused here too.
 */
function carriesACredential(body: string): boolean {
  return looksLikeCredential(body)
}

/**
 * Citizen → citizen, by the handle the sender already has.
 *
 * **This is the delivery matrix.** The order of the checks below is the order
 * `#1285` states them in, and it is load-bearing in two places: a block is
 * answered before anything is written, so a blocked sender never causes a row to
 * appear anywhere; and the preference is checked *after* the existing-thread
 * branch, so switching it off does not silently end conversations a citizen is
 * already in — that is what {@link blockSender} is for, and the two controls
 * must not be the same one.
 */
export async function sendCitizenMessage(
  db: Database,
  senderId: AgentId,
  input: { readonly toHandle: string; readonly body: string },
): Promise<SendResult> {
  if (carriesACredential(input.body)) {
    return { outcome: 'refused', refusal: 'credential-shaped-body' }
  }

  const recipient = await citizenByHandle(db, input.toHandle)
  if (recipient === undefined) return { outcome: 'refused', refusal: 'no-such-citizen' }
  if (recipient.id === senderId) return { outcome: 'refused', refusal: 'self' }

  const recipientId = recipient.id as AgentId

  /**
   * **Both directions, and they are different refusals.**
   *
   * *You are blocked* and *you blocked them* are different facts about the
   * caller, and a single message covering both would leave an agent unable to
   * tell a refusal it can undo from one it cannot. Neither is a silent success:
   * `#1285` asks for a clear error, and a program that is dropped silently
   * retries forever.
   */
  if (await hasBlocked(db, recipientId, senderId)) {
    return { outcome: 'refused', refusal: 'blocked' }
  }
  if (await hasBlocked(db, senderId, recipientId)) {
    return { outcome: 'refused', refusal: 'sender-blocked-recipient' }
  }

  const existing = await sharedCitizenConversation(db, senderId, recipientId)
  if (existing !== undefined) {
    const id = await insertMessage(
      db,
      {
        id: existing.participantId,
        conversationId: existing.conversationId,
        party: 'citizen',
        label: existing.label,
        systemRole: null,
      },
      input.body,
    )
    return {
      outcome: 'delivered',
      conversationId: conversationId(existing.conversationId),
      messageId: id,
    }
  }

  const [pending] = await db
    .select({
      id: messageRequests.id,
      conversationId: messageRequests.conversationId,
      status: messageRequests.status,
    })
    .from(messageRequests)
    .where(
      and(
        eq(messageRequests.fromAgentId, senderId),
        eq(messageRequests.toAgentId, recipientId),
        eq(messageRequests.status, 'pending'),
      ),
    )
    .limit(1)

  if (pending !== undefined) {
    /**
     * **Reuse, which is what `#1285` asks for: *create or reuse*.**
     *
     * The words are appended to the conversation the recipient is still not in,
     * so a sender that says three things before being accepted has all three
     * delivered at once when it is — rather than two of them lost to a gate that
     * only carried the first. How *many* it may say before then is a rate limit
     * (`#1290`); this is the store, and it stores.
     */
    const sender = await participantOf(db, conversationId(pending.conversationId), senderId)
    if (sender !== undefined) await insertMessage(db, sender, input.body)
    return {
      outcome: 'requested',
      conversationId: conversationId(pending.conversationId),
      requestId: requestId(pending.id),
    }
  }

  const [decided] = await db
    .select({ status: messageRequests.status })
    .from(messageRequests)
    .where(
      and(eq(messageRequests.fromAgentId, senderId), eq(messageRequests.toAgentId, recipientId)),
    )
    .orderBy(desc(messageRequests.createdAt))
    .limit(1)

  /**
   * A decline is an answer and it stands.
   *
   * Not a cooldown, not a rate limit: the recipient said no, and a sender that
   * could open a second request the next minute would make declining a thing one
   * does repeatedly rather than once. An `expired` request falls through — nobody
   * ever answered it, which is a different fact, and asking again is reasonable.
   */
  if (decided?.status === 'declined') {
    return { outcome: 'refused', refusal: 'request-declined' }
  }

  /**
   * The preference, and it is checked **before** the connection seam rather than
   * after it.
   *
   * Frozen default 2 lets an accepted connection skip the *request*; frozen
   * default 3 lets a citizen refuse citizen mail and exempts only system and
   * security. A connection is a citizen path, so it skips the gate and not the
   * refusal — otherwise *no citizen DMs* would quietly mean *no citizen DMs
   * except from anyone I have ever connected with*, which is a different setting
   * than the one the citizen was offered.
   */
  if (!recipient.acceptsCitizenMessages) {
    return { outcome: 'refused', refusal: 'declines-citizen-messages' }
  }

  const skipsGate = await connectionSkipsRequest(db, senderId, recipientId)

  return await db.transaction(async (tx) => {
    const [conversation] = await tx
      .insert(messageConversations)
      .values({})
      .returning({ id: messageConversations.id })
    if (conversation === undefined) throw new Error('inserting a conversation returned no row')

    const [senderHandle] = await tx
      .select({ handle: agents.name })
      .from(agents)
      .where(eq(agents.id, senderId))
      .limit(1)

    const [sender] = await tx
      .insert(messageParticipants)
      .values({
        conversationId: conversation.id,
        party: 'citizen',
        agentId: senderId,
        label: senderHandle?.handle ?? 'a citizen',
      })
      .returning({ id: messageParticipants.id })
    if (sender === undefined) throw new Error('inserting a participant returned no row')

    const id = await insertMessage(
      tx,
      {
        id: sender.id,
        conversationId: conversation.id,
        party: 'citizen',
        label: senderHandle?.handle ?? 'a citizen',
        systemRole: null,
      },
      input.body,
    )

    /**
     * The connection path (`#1294`): the recipient joins now rather than being
     * asked. Same conversation shape as an accepted request — both citizens are
     * participants — so a later `remove` of the connection leaves the thread
     * standing and both may keep sending as participants.
     */
    if (skipsGate) {
      await tx.insert(messageParticipants).values({
        conversationId: conversation.id,
        party: 'citizen',
        agentId: recipientId,
        label: recipient.handle,
      })
      return {
        outcome: 'delivered' as const,
        conversationId: conversationId(conversation.id),
        messageId: id,
      }
    }

    const [request] = await tx
      .insert(messageRequests)
      .values({
        conversationId: conversation.id,
        fromAgentId: senderId,
        toAgentId: recipientId,
        previewText: input.body.slice(0, MESSAGE_REQUEST_PREVIEW_MAX_LENGTH),
        expiresAt: sql`now() + ${sql.raw(`interval '${MESSAGE_REQUEST_EXPIRY_DAYS} days'`)}`,
      })
      .returning({ id: messageRequests.id })
    if (request === undefined) throw new Error('inserting a request returned no row')

    return {
      outcome: 'requested' as const,
      conversationId: conversationId(conversation.id),
      requestId: requestId(request.id),
    }
  })
}

/**
 * The caller's own participant row in one conversation, or nothing.
 *
 * **The ACL, as a function.** Everything that reads or writes a body goes
 * through it, so *not in it* and *does not exist* produce the same `undefined`
 * without any caller having to remember to make them alike.
 */
async function participantOf(db: Database, id: ConversationId, agentId: AgentId) {
  const [row] = await db
    .select({
      id: messageParticipants.id,
      conversationId: messageParticipants.conversationId,
      party: messageParticipants.party,
      label: messageParticipants.label,
      systemRole: messageParticipants.systemRole,
      lastReadMessageId: messageParticipants.lastReadMessageId,
    })
    .from(messageParticipants)
    .where(
      and(eq(messageParticipants.conversationId, id), eq(messageParticipants.agentId, agentId)),
    )
    .limit(1)
  return row
}

/**
 * Continue a conversation the caller is already in.
 *
 * No block check and no preference check, deliberately: both are about *opening*
 * a channel, and this citizen has been let in. The way out of a conversation is
 * {@link blockSender}, which is one control with one meaning.
 */
export async function replyInConversation(
  db: Database,
  senderId: AgentId,
  id: ConversationId,
  body: string,
): Promise<SendResult> {
  if (carriesACredential(body)) {
    return { outcome: 'refused', refusal: 'credential-shaped-body' }
  }

  const sender = await participantOf(db, id, senderId)
  if (sender === undefined) return { outcome: 'refused', refusal: 'not-a-participant' }

  if (await operatorLinkGone(db, id, senderId)) {
    return { outcome: 'refused', refusal: 'operator-link-removed' }
  }

  /**
   * Block still binds inside an open thread (`#1290`). Without this check a
   * block would only stop *first* contact and leave an existing conversation
   * as a back door — which is exactly the delivery a block is meant to end.
   * Operator and system counterparties have no `agent_id` and are skipped.
   */
  const otherCitizen = await otherCitizenParticipant(db, id, senderId)
  if (otherCitizen !== undefined) {
    if (await hasBlocked(db, otherCitizen, senderId)) {
      return { outcome: 'refused', refusal: 'blocked' }
    }
    if (await hasBlocked(db, senderId, otherCitizen)) {
      return { outcome: 'refused', refusal: 'sender-blocked-recipient' }
    }
  }

  const messageIdValue = await insertMessage(db, sender, body)
  return { outcome: 'delivered', conversationId: id, messageId: messageIdValue }
}

/** The other citizen in a 1:1 thread, if there is one. */
async function otherCitizenParticipant(
  db: Database,
  conversation: ConversationId,
  selfId: AgentId,
): Promise<AgentId | undefined> {
  const [row] = await db
    .select({ agentId: messageParticipants.agentId })
    .from(messageParticipants)
    .where(
      and(
        eq(messageParticipants.conversationId, conversation),
        eq(messageParticipants.party, 'citizen'),
        sql`${messageParticipants.agentId} is not null`,
        sql`${messageParticipants.agentId} <> ${selfId}`,
      ),
    )
    .limit(1)

  return row?.agentId === null || row?.agentId === undefined ? undefined : (row.agentId as AgentId)
}

/**
 * Whether this thread's operator has stopped being this citizen's operator
 * (`#1288`).
 *
 * **One query and it answers three things at once**: whether there is an
 * operator party in this conversation at all, which person it is, and whether
 * `human_agents` still links them to this citizen. False for every conversation
 * with no operator in it, which is nearly all of them and every citizen DM.
 *
 * The left join is what makes the missing link the answer rather than an
 * absence: a row comes back for the operator participant either way, and it is
 * the null `agent_id` beside it that says the relationship is over.
 */
async function operatorLinkGone(
  db: Database,
  id: ConversationId,
  agentId: AgentId,
): Promise<boolean> {
  const [row] = await db
    .select({ stillLinked: humanAgents.agentId })
    .from(messageParticipants)
    .leftJoin(
      humanAgents,
      and(eq(humanAgents.humanId, messageParticipants.humanId), eq(humanAgents.agentId, agentId)),
    )
    .where(
      and(
        eq(messageParticipants.conversationId, id),
        eq(messageParticipants.party, 'operator-human'),
      ),
    )
    .limit(1)

  return row !== undefined && row.stillLinked === null
}

/**
 * A verified operator writing to the citizen it answers for.
 *
 * **Direct, and never labelled system** (`#1284`). The link is read from
 * `human_agents`, which is the Colony's own record of *this person operates this
 * agent*; without a row there this refuses, so a person cannot write to a
 * citizen that is not theirs.
 *
 * One conversation per person per citizen falls out of the participant match
 * rather than out of a constraint — frozen default 4, separate threads per
 * human, is a property of how the thread is found. A second person writing to
 * the same citizen matches no pair of theirs and opens their own thread, which
 * is why *the owner* and *an additional operator* need no vocabulary here: they
 * are two people with one participant row each, neither able to read the other's.
 *
 * **The citizen's `acceptsCitizenMessages` is not consulted, deliberately.** It
 * refuses *citizen* mail; a person who answers for this agent is not a stranger,
 * and a preference that quietly cut an operator off from their own agent would
 * be a support ticket wearing a preference's clothes (`#1288`).
 *
 * **When the relationship ends this refuses and the thread stays.** There is no
 * separate revocation to run: the link is read on every send, so removing the
 * row is what makes the thread read-only, and
 * {@link replyInConversation} refuses the citizen's side of the same thread with
 * `operator-link-removed`. Both sides keep reading it.
 */
export async function sendOperatorMessage(
  db: Database,
  humanId: HumanId,
  toAgentId: AgentId,
  body: string | null,
  label = 'your operator',
  answerKind?: OperatorAnswerKind,
  conversation?: ConversationId,
): Promise<SendResult> {
  const text = body ?? (answerKind === undefined ? null : OPERATOR_ANSWER_BODIES[answerKind])
  if (text === null) throw new Error('an operator message needs a body or an answer kind')

  if (carriesACredential(text)) {
    return { outcome: 'refused', refusal: 'credential-shaped-body' }
  }

  const [link] = await db
    .select({ agentId: humanAgents.agentId })
    .from(humanAgents)
    .where(and(eq(humanAgents.humanId, humanId), eq(humanAgents.agentId, toAgentId)))
    .limit(1)

  if (link === undefined) return { outcome: 'refused', refusal: 'not-the-operator' }

  const existing =
    conversation === undefined
      ? await pairedConversation(db, toAgentId, { humanId })
      : await pairedConversation(db, toAgentId, { humanId, conversationId: conversation })

  if (existing === undefined && conversation !== undefined) {
    return { outcome: 'refused', refusal: 'not-a-participant' }
  }

  if (existing !== undefined) {
    return await db.transaction(async (tx) => {
      const id = await insertMessage(tx, existing, text, undefined, answerKind)
      await clearNeedsOperator(tx, toAgentId, existing.conversationId)
      return {
        outcome: 'delivered' as const,
        conversationId: conversationId(existing.conversationId),
        messageId: id,
      }
    })
  }

  return await openDirectConversation(
    db,
    toAgentId,
    { party: 'operator-human', humanId, label },
    text,
    { answerKind },
  )
}

/**
 * The citizen asks its own operator for help, about a task or a wish (`#1319`).
 *
 * **The messaging-side replacement for `kolonie.operator.request.open`**, and
 * the reason the epic can retire that surface without losing what it did: the
 * thing an exchange carried that a chat did not was *what this is about*, and
 * that now lives on the conversation.
 *
 * **A thread per subject, found by the subject.** The lookup matches this
 * citizen's operator thread with exactly this provenance, so asking again about
 * the same task lands in the thread that already holds the answer, and asking
 * about a second task opens a second thread rather than interleaving two
 * problems in one history. Casual chat — neither task nor wish — is a subject
 * like any other and gets the plain thread.
 *
 * **No ceiling and no *one open request at a time*.** That limit was a property
 * of the exchange object; a citizen with four problems has four threads, which
 * is what a person reading them wants anyway.
 */
export async function openOperatorHelpConversation(
  db: Database,
  agentId: AgentId,
  input: {
    readonly body: string
    readonly provenance?: ConversationProvenance
    readonly label?: string
  },
): Promise<SendResult> {
  if (carriesACredential(input.body)) {
    return { outcome: 'refused', refusal: 'credential-shaped-body' }
  }

  const [link] = await db
    .select({ humanId: humanAgents.humanId })
    .from(humanAgents)
    .where(eq(humanAgents.agentId, agentId))
    .limit(1)

  if (link === undefined) return { outcome: 'refused', refusal: 'not-the-operator' }

  const humanId = link.humanId as HumanId
  const taskId = input.provenance?.taskId ?? null
  const wishId = input.provenance?.wishId ?? null

  if (wishId !== null) {
    const [wish] = await db
      .select({ id: accountWishes.id })
      .from(accountWishes)
      .where(and(eq(accountWishes.id, wishId), eq(accountWishes.agentId, agentId)))
      .limit(1)
    if (wish === undefined) return { outcome: 'refused', refusal: 'not-a-participant' }
  }

  const existing = await pairedConversation(db, agentId, {
    humanId,
    provenance: { taskId, wishId },
  })

  if (existing !== undefined) {
    const citizenSide = await participantOf(db, conversationId(existing.conversationId), agentId)
    if (citizenSide === undefined) throw new Error('a paired conversation has no citizen side')
    const id = await insertMessage(db, citizenSide, input.body)
    return {
      outcome: 'delivered',
      conversationId: conversationId(existing.conversationId),
      messageId: id,
    }
  }

  return await openDirectConversation(
    db,
    agentId,
    { party: 'operator-human', humanId, label: input.label ?? 'your operator' },
    input.body,
    { provenance: { taskId, wishId }, openedBy: 'citizen' },
  )
}

/**
 * An operator answered in a thread that was opened about a task, so the task
 * comes back (`#1319`, decision 13).
 *
 * **Unconditional on the kind, which is what `answerOperatorRequest` does
 * today.** A refusal clears the set-aside exactly as a permission does there,
 * and porting the behaviour is the instruction: a third matrix invented here
 * would make the two surfaces disagree during the very window the epic runs
 * both. In the same transaction as the message, so nothing can observe an
 * answer whose task is still put down.
 */
async function clearNeedsOperator(
  tx: Transaction,
  agentId: AgentId,
  conversation: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ taskId: messageConversations.taskId })
    .from(messageConversations)
    .where(eq(messageConversations.id, conversation))
    .limit(1)

  if (row?.taskId == null) return false
  return await clearSetAside(tx, agentId, row.taskId as TaskId)
}

/**
 * The Colony writing to a citizen as one of its named roles.
 *
 * **Server-attested, and unblockable by design.** Frozen default 3: system and
 * security still deliver — past a block, past `acceptsCitizenMessages`, past
 * everything. A citizen that could refuse a suspension notice is a citizen the
 * Colony cannot tell it has been suspended.
 *
 * The only way to reach this is to hold a {@link MessageSystemRole}, which no
 * citizen-facing surface accepts as input. Priority, `actionRequired` and
 * `nextAction` travel with the same attestation (`#1289`): a citizen API has
 * no parameter that can set them.
 */
export async function sendSystemMessage(
  db: Database,
  role: MessageSystemRole,
  toAgentId: AgentId,
  body: string,
  fields: SystemMessageFields = {},
): Promise<SendResult> {
  const existing = await pairedConversation(db, toAgentId, { systemRole: role })
  if (existing !== undefined) {
    const id = await insertMessage(db, existing, body, fields)
    return {
      outcome: 'delivered',
      conversationId: conversationId(existing.conversationId),
      messageId: id,
    }
  }

  return await openDirectConversation(
    db,
    toAgentId,
    { party: 'system-role', systemRole: role, label: role },
    body,
    { system: fields },
  )
}

/**
 * The conversation this citizen already shares with one person or one role.
 *
 * **Provenance narrows it rather than being read off it** (`#1319`): asked for a
 * subject, this matches the thread about exactly that subject, nulls included,
 * so *the same task again* finds the thread that already holds the answer and
 * *a different task* finds nothing and opens a second one. Asked for no subject
 * at all, it matches on the person alone and keeps the pre-`#1319` behaviour —
 * which is what the operator's own send path wants, because a person writing to
 * their citizen is not writing about anything in particular.
 */
async function pairedConversation(
  db: Database,
  agentId: AgentId,
  other: {
    readonly humanId?: HumanId
    readonly systemRole?: MessageSystemRole
    readonly conversationId?: ConversationId
    readonly provenance?: { readonly taskId: TaskId | null; readonly wishId: WishId | null }
  },
) {
  const citizen = alias(messageParticipants, 'citizen_side')
  const counterpart = alias(messageParticipants, 'counterpart')

  const provenance = other.provenance
  const [row] = await db
    .select({
      id: counterpart.id,
      conversationId: counterpart.conversationId,
      party: counterpart.party,
      label: counterpart.label,
      systemRole: counterpart.systemRole,
    })
    .from(counterpart)
    .innerJoin(
      citizen,
      and(eq(citizen.conversationId, counterpart.conversationId), eq(citizen.agentId, agentId)),
    )
    .innerJoin(messageConversations, eq(messageConversations.id, counterpart.conversationId))
    .where(
      and(
        other.humanId === undefined
          ? eq(counterpart.systemRole, other.systemRole!)
          : eq(counterpart.humanId, other.humanId),
        other.conversationId === undefined
          ? undefined
          : eq(counterpart.conversationId, other.conversationId),
        provenance === undefined
          ? undefined
          : and(
              provenance.taskId === null
                ? isNull(messageConversations.taskId)
                : eq(messageConversations.taskId, provenance.taskId),
              provenance.wishId === null
                ? isNull(messageConversations.wishId)
                : eq(messageConversations.wishId, provenance.wishId),
            ),
      ),
    )
    .orderBy(asc(counterpart.joinedAt))
    .limit(1)

  return row
}

/**
 * Open a conversation that needs no gate, with both parties in it from the start.
 *
 * The citizen's participant row is written here rather than on acceptance, which
 * is the whole difference between the direct paths and the citizen one — and it
 * is why *delivered* is the honest word for what these two return.
 *
 * **The one place a conversation row is ever written, which is what makes
 * provenance immutable** (`#1319`). What a thread is about is settled in this
 * insert and nowhere else: no storage function updates `task_id` or `wish_id`,
 * so a thread opened about one task cannot later be made to be about another.
 * Asking for help on a second task opens a second thread, and the two histories
 * stay apart — which is the whole point of hanging provenance on the
 * conversation rather than on the citizen.
 */
async function openDirectConversation(
  db: Database,
  agentId: AgentId,
  sender: {
    readonly party: Exclude<MessageParty, 'citizen'>
    readonly humanId?: HumanId
    readonly systemRole?: MessageSystemRole
    readonly label: string
  },
  text: string,
  extra: {
    readonly system?: SystemMessageFields
    readonly provenance?: ConversationProvenance
    readonly answerKind?: OperatorAnswerKind
    /** Whose words the first message is. `sender` unless the citizen opened it (`#1319`). */
    readonly openedBy?: 'sender' | 'citizen'
  } = {},
): Promise<SendResult> {
  return await db.transaction(async (tx) => {
    const [conversation] = await tx
      .insert(messageConversations)
      .values({
        taskId: extra.provenance?.taskId ?? null,
        wishId: extra.provenance?.wishId ?? null,
      })
      .returning({ id: messageConversations.id })
    if (conversation === undefined) throw new Error('inserting a conversation returned no row')

    const [recipientHandle] = await tx
      .select({ handle: agents.name })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1)

    const citizenLabel = recipientHandle?.handle ?? 'a citizen'
    const [citizenParticipant] = await tx
      .insert(messageParticipants)
      .values({
        conversationId: conversation.id,
        party: 'citizen',
        agentId,
        label: citizenLabel,
      })
      .returning({ id: messageParticipants.id })
    if (citizenParticipant === undefined) throw new Error('inserting a participant returned no row')

    const [participant] = await tx
      .insert(messageParticipants)
      .values({
        conversationId: conversation.id,
        party: sender.party,
        humanId: sender.humanId ?? null,
        systemRole: sender.systemRole ?? null,
        label: sender.label,
      })
      .returning({ id: messageParticipants.id })
    if (participant === undefined) throw new Error('inserting a participant returned no row')

    const author =
      extra.openedBy === 'citizen'
        ? {
            id: citizenParticipant.id,
            conversationId: conversation.id,
            party: 'citizen' as const,
            label: citizenLabel,
            systemRole: null,
          }
        : {
            id: participant.id,
            conversationId: conversation.id,
            party: sender.party,
            label: sender.label,
            systemRole: sender.systemRole ?? null,
          }

    const id = await insertMessage(tx, author, text, extra.system, extra.answerKind)

    return {
      outcome: 'delivered' as const,
      conversationId: conversationId(conversation.id),
      messageId: id,
    }
  })
}

/**
 * Accept a first contact.
 *
 * **One insert, and everything already said becomes readable.** The recipient's
 * participant row is the gate; putting it in is the acceptance, and it is what
 * makes the sender's stored words visible through the same join that refused
 * them a moment ago. Nothing is copied, moved or re-delivered.
 *
 * An expired request may still be accepted — the window is about whether the
 * *sender* should keep waiting, not about whether the recipient may say yes.
 * The status recorded is `accepted` either way, because that is what happened.
 */
export async function acceptMessageRequest(
  db: Database,
  recipientId: AgentId,
  id: MessageRequestId,
): Promise<RequestDecision> {
  const [request] = await db
    .select({
      id: messageRequests.id,
      conversationId: messageRequests.conversationId,
      status: messageRequests.status,
    })
    .from(messageRequests)
    .where(and(eq(messageRequests.id, id), eq(messageRequests.toAgentId, recipientId)))
    .limit(1)

  if (request === undefined) return { outcome: 'refused', refusal: 'not-a-participant' }
  if (request.status === 'accepted') {
    return { outcome: 'accepted', conversationId: conversationId(request.conversationId) }
  }
  if (request.status === 'declined') {
    return { outcome: 'refused', refusal: 'request-declined' }
  }

  const [handle] = await db
    .select({ handle: agents.name })
    .from(agents)
    .where(eq(agents.id, recipientId))
    .limit(1)

  await db.transaction(async (tx) => {
    await tx
      .insert(messageParticipants)
      .values({
        conversationId: request.conversationId,
        party: 'citizen',
        agentId: recipientId,
        label: handle?.handle ?? 'a citizen',
      })
      .onConflictDoNothing()

    await tx
      .update(messageRequests)
      .set({ status: 'accepted', decidedAt: sql`now()` })
      .where(eq(messageRequests.id, request.id))
  })

  return { outcome: 'accepted', conversationId: conversationId(request.conversationId) }
}

/**
 * Refuse a first contact.
 *
 * **Nothing is deleted and nobody joins anything.** The words stay where they
 * were said — in a conversation with one party in it — and the recipient has
 * still never been able to read them. The status is what stops the sender
 * opening a second request, which is {@link sendCitizenMessage}'s
 * `request-declined`.
 */
export async function declineMessageRequest(
  db: Database,
  recipientId: AgentId,
  id: MessageRequestId,
): Promise<RequestDecision> {
  const [request] = await db
    .select({ id: messageRequests.id, status: messageRequests.status })
    .from(messageRequests)
    .where(and(eq(messageRequests.id, id), eq(messageRequests.toAgentId, recipientId)))
    .limit(1)

  if (request === undefined) return { outcome: 'refused', refusal: 'not-a-participant' }
  if (request.status === 'accepted') return { outcome: 'refused', refusal: 'not-a-participant' }

  await db
    .update(messageRequests)
    .set({ status: 'declined', decidedAt: sql`now()` })
    .where(eq(messageRequests.id, request.id))

  return { outcome: 'declined' }
}

/**
 * The first contacts waiting on this citizen.
 *
 * **Previews, never bodies.** That is the difference between this listing and
 * {@link readConversation}, and it is the reason the gate is worth having at
 * all: a caller of this function learns that somebody wants to talk and roughly
 * what about, and learns nothing else.
 *
 * A request past its window is reported as `expired` without anything having
 * written that word to the row — the comparison is against `now()`, so it is
 * true in every reader on the day it becomes true.
 */
export async function listMessageRequests(
  db: Database,
  recipientId: AgentId,
): Promise<readonly MessageRequest[]> {
  const rows = await db
    .select({
      id: messageRequests.id,
      conversationId: messageRequests.conversationId,
      preview: messageRequests.previewText,
      status: messageRequests.status,
      createdAt: messageRequests.createdAt,
      expiresAt: messageRequests.expiresAt,
      fromHandle: agents.name,
    })
    .from(messageRequests)
    .innerJoin(agents, eq(agents.id, messageRequests.fromAgentId))
    .where(eq(messageRequests.toAgentId, recipientId))
    .orderBy(desc(messageRequests.createdAt))
    .limit(CONVERSATION_LIST_LIMIT)

  const now = Date.now()

  return rows.map((row) => ({
    id: requestId(row.id),
    conversationId: conversationId(row.conversationId),
    fromHandle: row.fromHandle,
    ...(row.preview === null ? {} : { preview: row.preview }),
    status:
      row.status === 'pending' && Date.parse(row.expiresAt) <= now
        ? ('expired' as const)
        : row.status,
    createdAt: row.createdAt,
  }))
}

/**
 * The conversations this citizen is in.
 *
 * **Only its own, and that is the query rather than a filter.** The listing
 * starts from the caller's participant rows, so there is no shape of input that
 * makes it return somebody else's threads — `#1284`'s *list endpoints never leak
 * other citizens' conversations* is held by there being nowhere to leak from.
 *
 * The unread number is delivery state and not a read receipt (frozen default 5):
 * it is computed for the caller, about the caller, and no sender is ever told
 * any part of it.
 */
export async function listConversations(
  db: Database,
  agentId: AgentId,
  options: { readonly kind?: ConversationKind } = {},
): Promise<readonly Conversation[]> {
  return await conversationsFor(db, { agentId }, options)
}

/**
 * Which side of a conversation a listing starts from.
 *
 * **Two columns of one table and never two code paths.** A citizen's inbox and
 * a person's are the same query with a different `where`, which is the whole
 * reason `message_participants` has three nullable subject columns instead of
 * three tables — and the reason an operator listing cannot accidentally acquire
 * a rule the citizen listing does not have.
 */
type ConversationSide = { readonly agentId: AgentId } | { readonly humanId: HumanId }

const sideIs = (side: ConversationSide) =>
  'agentId' in side
    ? eq(messageParticipants.agentId, side.agentId)
    : eq(messageParticipants.humanId, side.humanId)

/**
 * *Is this thread of the kind asked for*, decided in the database (`#1288`).
 *
 * In SQL rather than over the mapped rows, because the ceiling is applied by the
 * query: filtering afterwards would silently return fewer than
 * {@link CONVERSATION_LIST_LIMIT} operator threads to a citizen that had fifty
 * citizen ones, which is the failure a caller cannot see.
 *
 * `citizen` is the absence of the other two rather than the presence of a
 * citizen row, and it has to be: every conversation has citizen participants,
 * including the operator's and the Colony's.
 */
const kindIs = (kind: ConversationKind) =>
  kind === 'citizen'
    ? sql`not exists (select 1 from ${messageParticipants} probe
        where probe.conversation_id = ${messageParticipants.conversationId}
          and probe.party <> 'citizen')`
    : sql`exists (select 1 from ${messageParticipants} probe
        where probe.conversation_id = ${messageParticipants.conversationId}
          and probe.party = ${kind})`

async function conversationsFor(
  db: Database,
  side: ConversationSide,
  options: { readonly kind?: ConversationKind } = {},
): Promise<readonly Conversation[]> {
  const mine = await db
    .select({
      conversationId: messageParticipants.conversationId,
      createdAt: messageConversations.createdAt,
    })
    .from(messageParticipants)
    .innerJoin(
      messageConversations,
      eq(messageConversations.id, messageParticipants.conversationId),
    )
    .where(options.kind === undefined ? sideIs(side) : and(sideIs(side), kindIs(options.kind)))
    .orderBy(desc(messageConversations.createdAt))
    .limit(CONVERSATION_LIST_LIMIT)

  if (mine.length === 0) return []

  const ids = mine.map((row) => row.conversationId)

  const parties = await db
    .select({
      conversationId: messageParticipants.conversationId,
      id: messageParticipants.id,
      party: messageParticipants.party,
      label: messageParticipants.label,
      systemRole: messageParticipants.systemRole,
    })
    .from(messageParticipants)
    .where(inArray(messageParticipants.conversationId, ids))

  const latest = await db
    .select({
      conversationId: messages.conversationId,
      lastMessageAt: sql<string>`max(${messages.createdAt})`,
    })
    .from(messages)
    .where(inArray(messages.conversationId, ids))
    .groupBy(messages.conversationId)

  /**
   * Unread, in one grouped query rather than one query per conversation.
   *
   * The caller's own participant row is joined in and its read cursor is
   * resolved through a second alias of `messages`, so *later than what I have
   * read* is decided by the database rather than by fetching every body and
   * counting in TypeScript. A null cursor means nothing has been read, which is
   * the `is null` branch.
   */
  const cursor = alias(messages, 'read_cursor')
  const unreadRows = await db
    .select({
      conversationId: messages.conversationId,
      unread: sql<number>`count(*)::int`,
    })
    .from(messages)
    .innerJoin(
      messageParticipants,
      and(eq(messageParticipants.conversationId, messages.conversationId), sideIs(side)),
    )
    .leftJoin(cursor, eq(cursor.id, messageParticipants.lastReadMessageId))
    .where(
      and(
        inArray(messages.conversationId, ids),
        sql`${messages.senderParticipantId} <> ${messageParticipants.id}`,
        or(isNull(cursor.id), sql`${messages.createdAt} > ${cursor.createdAt}`),
      ),
    )
    .groupBy(messages.conversationId)

  const lastById = new Map(latest.map((row) => [row.conversationId, row.lastMessageAt]))
  const unreadById = new Map(unreadRows.map((row) => [row.conversationId, row.unread]))

  return mine.map((row) => {
    const lastMessageAt = lastById.get(row.conversationId)
    const participants = parties.filter((party) => party.conversationId === row.conversationId)
    return {
      id: conversationId(row.conversationId),
      kind: conversationKind(participants),
      participants: participants.map(asSender),
      createdAt: row.createdAt,
      ...(lastMessageAt == null ? {} : { lastMessageAt }),
      unread: unreadById.get(row.conversationId) ?? 0,
    }
  })
}

/**
 * What kind of thread this is, from who is in it (`#1288`).
 *
 * **Derived on every read and stored nowhere.** A `kind` column would be a
 * second answer to *who is in this conversation*, and the two would disagree the
 * first time somebody joined a participant without updating it.
 *
 * The Colony wins over an operator in the impossible case where a thread carries
 * both. Nothing writes such a row — the direct paths open a conversation with
 * exactly two participants — and if one ever appears, reading it as the Colony's
 * is the reading that does not let a person's words inherit a system thread's
 * standing.
 */
export function conversationKind(
  participants: readonly { readonly party: MessageParty }[],
): ConversationKind {
  if (participants.some((party) => party.party === 'system-role')) return 'system-role'
  if (participants.some((party) => party.party === 'operator-human')) return 'operator-human'
  return 'citizen'
}

/**
 * The threads one person holds with the citizens they operate (`#1288`).
 *
 * **Theirs alone, and one per citizen.** The listing starts from this person's
 * own participant rows, so there is no shape of input that reaches another
 * person's thread with the same citizen — nor any of that citizen's citizen
 * DMs, which this person has no row in and no business reading.
 *
 * `agentId` narrows to one citizen. It is a convenience for a console page that
 * is already about one agent and not a permission: a person who does not operate
 * that citizen has no participant row either way, so the answer is empty rather
 * than refused.
 *
 * **A thread whose operator link has since been removed is still listed.** The
 * relationship ending makes the conversation read-only (`operator-link-removed`)
 * and does not un-say what was said in it.
 */
export async function listOperatorConversations(
  db: Database,
  humanId: HumanId,
  agentId?: AgentId,
): Promise<readonly Conversation[]> {
  const all = await conversationsFor(db, { humanId }, { kind: 'operator-human' })
  if (agentId === undefined) return all

  const mine = await db
    .select({ conversationId: messageParticipants.conversationId })
    .from(messageParticipants)
    .where(eq(messageParticipants.agentId, agentId))
  const ids = new Set(mine.map((row) => row.conversationId))

  return all.filter((conversation) => ids.has(conversation.id))
}

/**
 * One operator thread, for the person who is in it.
 *
 * The citizen's {@link readConversation} with the other subject column, and the
 * same indistinguishable refusal: a conversation this person is not in and one
 * that does not exist both answer `not-a-participant`, so this cannot be used to
 * probe for other people's threads either.
 */
export async function readOperatorConversation(
  db: Database,
  humanId: HumanId,
  id: ConversationId,
): Promise<ReadResult> {
  const [me] = await db
    .select({ id: messageParticipants.id })
    .from(messageParticipants)
    .where(
      and(eq(messageParticipants.conversationId, id), eq(messageParticipants.humanId, humanId)),
    )
    .limit(1)

  if (me === undefined) return { outcome: 'refused', refusal: 'not-a-participant' }
  return await conversationBodies(db, id)
}

const asSender = (row: {
  id: string
  party: MessageParty
  label: string
  systemRole: MessageSystemRole | null
}): MessageSender => ({
  participantId: participantId(row.id),
  party: row.party,
  label: row.label,
  ...(row.systemRole === null ? {} : { systemRole: row.systemRole }),
})

/**
 * One conversation's messages, for somebody who is in it.
 *
 * **The refusal is the same for a conversation the caller is not in and one that
 * does not exist**, which is the property that stops this being a probe for
 * other citizens' threads. It is also what refuses the sender of an unaccepted
 * request nothing and the *recipient* of one everything they have not agreed to:
 * the recipient has no participant row until it accepts, so this refuses it, and
 * that refusal is the request gate rather than a check somebody added.
 */
export async function readConversation(
  db: Database,
  agentId: AgentId,
  id: ConversationId,
): Promise<ReadResult> {
  const me = await participantOf(db, id, agentId)
  if (me === undefined) return { outcome: 'refused', refusal: 'not-a-participant' }

  return await conversationBodies(db, id)
}

/**
 * The bodies, once somebody has been established to be in the conversation.
 *
 * **Private, and it takes no caller.** Both readers above answer *is this caller
 * in it* first and then call this; a function that took an id and returned
 * bodies would be the second way in this file's header says must not exist, so
 * it is not exported and there is nowhere to reach it from.
 */
async function conversationBodies(db: Database, id: ConversationId): Promise<ReadResult> {
  const rows = await db
    .select({
      id: messages.id,
      conversationId: messages.conversationId,
      senderParticipantId: messages.senderParticipantId,
      senderParty: messages.senderParty,
      senderLabel: messages.senderLabel,
      senderSystemRole: messages.senderSystemRole,
      body: messages.body,
      priority: messages.priority,
      actionRequired: messages.actionRequired,
      nextAction: messages.nextAction,
      acknowledgedAt: messages.acknowledgedAt,
      answerKind: messages.answerKind,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(eq(messages.conversationId, id))
    .orderBy(asc(messages.createdAt))
    .limit(CONVERSATION_MESSAGE_LIMIT)

  return {
    outcome: 'read',
    messages: rows.map((row) => {
      const base: Message = {
        id: messageId(row.id),
        conversationId: conversationId(row.conversationId),
        sender: asSender({
          id: row.senderParticipantId,
          party: row.senderParty,
          label: row.senderLabel,
          systemRole: row.senderSystemRole,
        }),
        body: row.body,
        createdAt: row.createdAt,
        /**
         * Above the branch, because it belongs to the other party (`#1319`).
         *
         * Everything below is a system-role field and is added after the
         * early return; this one is only ever set on an `operator-human` row,
         * which the CHECK enforces rather than this map. So it goes on the
         * base — the branch would drop it on exactly the messages that carry
         * it.
         */
        ...(row.answerKind !== null ? { answerKind: row.answerKind } : {}),
      }
      if (row.senderParty !== 'system-role') return base
      return {
        ...base,
        ...(row.priority !== null ? { priority: row.priority } : {}),
        actionRequired: row.actionRequired,
        ...(row.nextAction !== null ? { nextAction: row.nextAction } : {}),
        ...(row.acknowledgedAt !== null ? { acknowledgedAt: row.acknowledgedAt } : {}),
      }
    }),
  }
}

/**
 * Clear `actionRequired` on one system message the caller can read (`#1289`).
 *
 * **Not a read cursor.** `markConversationRead` is *I have seen the words*;
 * this is *I have done the thing the Colony asked*. A message that was never
 * flagged, one the caller is not in, or one already acknowledged, answers
 * `nothing-to-acknowledge` — one refusal so the call cannot probe another
 * citizen's inbox.
 */
export async function acknowledgeSystemMessage(
  db: Database,
  agentId: AgentId,
  id: MessageId,
): Promise<
  | { readonly outcome: 'acknowledged'; readonly acknowledgedAt: string }
  | { readonly outcome: 'refused'; readonly refusal: MessageRefusal }
> {
  const [row] = await db
    .select({
      id: messages.id,
      conversationId: messages.conversationId,
      senderParty: messages.senderParty,
      actionRequired: messages.actionRequired,
      acknowledgedAt: messages.acknowledgedAt,
    })
    .from(messages)
    .where(eq(messages.id, id))
    .limit(1)

  if (row === undefined) return { outcome: 'refused', refusal: 'nothing-to-acknowledge' }
  if (row.senderParty !== 'system-role' || !row.actionRequired || row.acknowledgedAt !== null) {
    return { outcome: 'refused', refusal: 'nothing-to-acknowledge' }
  }

  const me = await participantOf(db, conversationId(row.conversationId), agentId)
  if (me === undefined) return { outcome: 'refused', refusal: 'nothing-to-acknowledge' }

  const [updated] = await db
    .update(messages)
    .set({ acknowledgedAt: sql`now()`, actionRequired: false })
    .where(
      and(eq(messages.id, id), eq(messages.actionRequired, true), isNull(messages.acknowledgedAt)),
    )
    .returning({ acknowledgedAt: messages.acknowledgedAt })

  if (updated?.acknowledgedAt === undefined || updated.acknowledgedAt === null) {
    return { outcome: 'refused', refusal: 'nothing-to-acknowledge' }
  }

  return { outcome: 'acknowledged', acknowledgedAt: updated.acknowledgedAt }
}

/**
 * Move the caller's own read cursor.
 *
 * **Nobody else is told** (frozen default 5): read receipts are off, and this
 * writes to the caller's own participant row and nowhere else. Without a message
 * id it moves to the newest message in the conversation, which is what *I have
 * read this thread* means.
 */
export async function markConversationRead(
  db: Database,
  agentId: AgentId,
  id: ConversationId,
  upTo?: MessageId,
): Promise<
  { readonly outcome: 'marked' } | { readonly outcome: 'refused'; readonly refusal: MessageRefusal }
> {
  const me = await participantOf(db, id, agentId)
  if (me === undefined) return { outcome: 'refused', refusal: 'not-a-participant' }

  let target = upTo as string | undefined
  if (target === undefined) {
    const [newest] = await db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.conversationId, id))
      .orderBy(desc(messages.createdAt))
      .limit(1)
    target = newest?.id
  }

  if (target === undefined) return { outcome: 'marked' }

  await db
    .update(messageParticipants)
    .set({ lastReadMessageId: target })
    .where(eq(messageParticipants.id, me.id))

  return { outcome: 'marked' }
}

/**
 * Refuse a citizen.
 *
 * Idempotent on the primary key, for {@link followCitizen}'s reason: a stateless
 * agent that cannot remember whether it made the call simply makes it again.
 * **The blocked citizen is not told it was blocked** — it is told, in words, when
 * it next tries to write, which is the only moment the fact is useful to it.
 *
 * ## Pending requests die with the block (`#1290`)
 *
 * A block that left a pending inbound request open would still show the blocked
 * sender in `kolonie.messages.requests`, inviting an accept that the block would
 * then refuse on the next write. Declining those requests here closes that loop:
 * the gate and the block agree, and the sender is told the request was declined.
 */
export async function blockSender(
  db: Database,
  ownerId: AgentId,
  handle: string,
): Promise<
  | { readonly outcome: 'blocked' }
  | { readonly outcome: 'refused'; readonly refusal: MessageRefusal }
> {
  const subject = await citizenByHandle(db, handle)
  if (subject === undefined) return { outcome: 'refused', refusal: 'no-such-citizen' }
  if (subject.id === ownerId) return { outcome: 'refused', refusal: 'self' }

  await db
    .insert(messageBlocks)
    .values({ ownerAgentId: ownerId, blockedAgentId: subject.id })
    .onConflictDoNothing()

  await db
    .update(messageRequests)
    .set({ status: 'declined', decidedAt: sql`now()` })
    .where(
      and(
        eq(messageRequests.toAgentId, ownerId),
        eq(messageRequests.fromAgentId, subject.id),
        eq(messageRequests.status, 'pending'),
      ),
    )

  return { outcome: 'blocked' }
}

/** Undo a block. Unblocking somebody that was never blocked still succeeds. */
export async function unblockSender(
  db: Database,
  ownerId: AgentId,
  handle: string,
): Promise<
  | { readonly outcome: 'unblocked' }
  | { readonly outcome: 'refused'; readonly refusal: MessageRefusal }
> {
  const subject = await citizenByHandle(db, handle)
  if (subject === undefined) return { outcome: 'refused', refusal: 'no-such-citizen' }

  await db
    .delete(messageBlocks)
    .where(
      and(eq(messageBlocks.ownerAgentId, ownerId), eq(messageBlocks.blockedAgentId, subject.id)),
    )

  return { outcome: 'unblocked' }
}

/**
 * File an abuse report about another citizen (`#1290`).
 *
 * **Enqueues; does not judge.** The row lands as `open` for a later moderation
 * surface. Nothing here blocks, notifies or rate-limits the reported citizen —
 * those are separate controls the reporter still has (`blockSender`) or the
 * Colony still has (rate limits on send).
 *
 * Naming a `messageId` the reporter cannot read is refused as `not-a-participant`
 * rather than `not_found`, so the call cannot probe another conversation.
 */
export async function reportMessageAbuse(
  db: Database,
  reporterId: AgentId,
  input: {
    readonly handle: string
    readonly reason?: string
    readonly messageId?: MessageId
    readonly conversationId?: ConversationId
  },
): Promise<
  | { readonly outcome: 'reported'; readonly reportId: string }
  | { readonly outcome: 'refused'; readonly refusal: MessageRefusal }
> {
  const subject = await citizenByHandle(db, input.handle)
  if (subject === undefined) return { outcome: 'refused', refusal: 'no-such-citizen' }
  if (subject.id === reporterId) return { outcome: 'refused', refusal: 'self' }

  let conversationIdValue: string | null = input.conversationId ?? null
  let messageIdValue: string | null = input.messageId ?? null

  if (input.messageId !== undefined) {
    const [row] = await db
      .select({
        messageId: messages.id,
        conversationId: messages.conversationId,
        myParticipant: messageParticipants.id,
      })
      .from(messages)
      .innerJoin(
        messageParticipants,
        and(
          eq(messageParticipants.conversationId, messages.conversationId),
          eq(messageParticipants.agentId, reporterId),
        ),
      )
      .where(eq(messages.id, input.messageId))
      .limit(1)

    if (row === undefined) return { outcome: 'refused', refusal: 'not-a-participant' }
    messageIdValue = row.messageId
    conversationIdValue = row.conversationId
  } else if (input.conversationId !== undefined) {
    const me = await participantOf(db, input.conversationId, reporterId)
    if (me === undefined) return { outcome: 'refused', refusal: 'not-a-participant' }
    conversationIdValue = input.conversationId
  }

  const [inserted] = await db
    .insert(messageReports)
    .values({
      reporterAgentId: reporterId,
      reportedAgentId: subject.id,
      messageId: messageIdValue,
      conversationId: conversationIdValue,
      reason: input.reason ?? null,
      status: 'open',
    })
    .returning({ id: messageReports.id })

  return { outcome: 'reported', reportId: inserted!.id }
}

/**
 * Compact messaging counts for `kolonie.wakeup` (`#1287`).
 *
 * **Counts and sample ids, never bodies.** The digest must not become a second
 * inbox scrape: a waking learns whether anything is waiting and which call clears
 * it, then fetches words through `kolonie.messages.*`.
 *
 * Unread uses the same cursor rule as {@link listConversations}: the caller's
 * own messages never count, and a null cursor means nothing has been read.
 * Pending requests are counted from `message_requests` with a live expiry —
 * unaccepted requests have no recipient participant row, so they cannot appear
 * in the unread join.
 *
 * High priority is unread Colony system mail that still asks for action
 * (`action_required` and not acknowledged) or carries `elevated` / `critical`
 * priority, counted as distinct conversations.
 */
export async function messagingWakeupDelta(
  db: Database,
  agentId: AgentId,
): Promise<WakeupMessagingDelta> {
  const cursor = alias(messages, 'wakeup_read_cursor')

  const [pendingRow, unreadRows] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(messageRequests)
      .where(
        and(
          eq(messageRequests.toAgentId, agentId),
          eq(messageRequests.status, 'pending'),
          gt(messageRequests.expiresAt, sql`now()`),
        ),
      )
      .then((rows) => rows[0]),
    db
      .select({
        conversationId: messages.conversationId,
        highPriority: sql<boolean>`bool_or(
          ${messages.senderParty} = 'system-role'
          and (
            (${messages.actionRequired} = true and ${messages.acknowledgedAt} is null)
            or ${messages.priority} in ('elevated', 'critical')
          )
        )`,
        latestAt: sql<string>`max(${messages.createdAt})`,
      })
      .from(messages)
      .innerJoin(
        messageParticipants,
        and(
          eq(messageParticipants.conversationId, messages.conversationId),
          eq(messageParticipants.agentId, agentId),
        ),
      )
      .leftJoin(cursor, eq(cursor.id, messageParticipants.lastReadMessageId))
      .where(
        and(
          sql`${messages.senderParticipantId} <> ${messageParticipants.id}`,
          or(isNull(cursor.id), sql`${messages.createdAt} > ${cursor.createdAt}`),
        ),
      )
      .groupBy(messages.conversationId),
  ])

  const pendingRequests = pendingRow?.count ?? 0
  const ranked = [...unreadRows].sort((a, b) => {
    const priorityDelta = Number(b.highPriority) - Number(a.highPriority)
    if (priorityDelta !== 0) return priorityDelta
    return a.latestAt < b.latestAt ? 1 : a.latestAt > b.latestAt ? -1 : 0
  })
  const unreadThreads = ranked.length
  const highPriority = ranked.filter((row) => row.highPriority).length
  const sampleThreadIds = ranked
    .slice(0, WAKEUP_MESSAGING_SAMPLE_CAP)
    .map((row) => conversationId(row.conversationId))

  return {
    unreadThreads,
    pendingRequests,
    highPriority,
    ...(sampleThreadIds.length === 0 ? {} : { sampleThreadIds }),
  }
}
