import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import {
  MESSAGE_REQUEST_EXPIRY_DAYS,
  now as currentTime,
  MESSAGE_REQUEST_PREVIEW_MAX_LENGTH,
  OPERATOR_ANSWER_BODIES,
  WAKEUP_MESSAGING_SAMPLE_CAP,
  looksLikeCredential,
  ConversationIdSchema,
  ConversationParticipantIdSchema,
  HumanIdSchema,
  MessageIdSchema,
  MessageRequestIdSchema,
  type AgentId,
  type Conversation,
  type ConversationAbout,
  type ConversationId,
  type ConversationKind,
  type ConversationShare,
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
  accounts,
  agents,
  humanAgents,
  messageBlocks,
  messageConversationShares,
  messageConversations,
  messageParticipants,
  messageReports,
  messageRequests,
  messageTelegramAsks,
  messages,
  operatorTelegramChats,
  tasks,
  vaultShares,
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
      /**
       * Whether this send *opened* the thread rather than appending to one
       * (`#1321`).
       *
       * Read by the operator notify path and by nothing else: the rule it serves
       * is `operator_addresses`' own — **one ping per thread, never a reminder** —
       * and without it the caller cannot tell a citizen's first ask from its
       * fourth follow-up, which is the difference between telling a person and
       * pestering them. Absent on every path that is not an operator open.
       */
      readonly opened?: boolean
    }
  | {
      readonly outcome: 'requested'
      readonly conversationId: ConversationId
      readonly requestId: MessageRequestId
    }
  | { readonly outcome: 'refused'; readonly refusal: MessageRefusal }

export type ReadResult =
  | {
      readonly outcome: 'read'
      readonly messages: readonly Message[]
      /**
       * What the thread is about, and what is shared onto it (`#1441`).
       *
       * **On the read as well as on the listing**, because the operator page
       * renders one thread and an agent's `get_thread` reads one: a subject that
       * appeared only in a list would be a subject nobody sees at the moment
       * they are acting on it, which is exactly the failure `#1441` is about.
       */
      readonly about: ConversationAbout | null
      readonly shares: readonly ConversationShare[]
    }
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
  /**
   * The account this thread is about (`#1441`, epic `#1437`).
   *
   * The third of the three, and mutually exclusive with them by the same check.
   * A shared vault entry is **not** here: several may hang on one thread and
   * they come and go while it stays, so they are attachments — see
   * `message_conversation_shares`.
   */
  readonly accountId?: string | null
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

  /**
   * **A new message un-archives it, for everybody but the sender** (`#1449`).
   *
   * Archiving means *I am done with this*, and somebody writing again is the
   * event that makes it untrue. Doing it here rather than in each send path is
   * what makes it one rule: every message in the Colony goes through this
   * function, so there is no way to write one that leaves a thread archived
   * under somebody who has just been written to.
   *
   * **It does not un-mute.** Mute is *stop telling me about it* and survives
   * exactly the event archive does not — that is `#1447` frozen decision 4, and
   * the two columns are why it can be said at all.
   *
   * **The sender's own row is left alone.** A person who archived a thread and
   * then wrote one more line into it has not changed their mind about being
   * finished; they answered and moved on.
   */
  await db
    .update(messageParticipants)
    .set({ doneAt: null })
    .where(
      and(
        eq(messageParticipants.conversationId, participant.conversationId),
        isNotNull(messageParticipants.doneAt),
        sql`${messageParticipants.id} <> ${participant.id}`,
      ),
    )

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
  /**
   * The account this thread is about, when a person opens one (`#1452`).
   *
   * **Only meaningful on an open**, and ignored when `conversation` names a
   * thread that already exists — provenance is settled in the insert that
   * creates a conversation and nowhere else (`#1319`), so a person cannot
   * retitle a thread by replying into it.
   *
   * A person saying *I have put a card on the GitHub account* should be able to
   * say which account, for the same reason the agent can (`#1441`).
   */
  accountId?: string,
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

  /**
   * **The person's plain thread, or the one about this account** (`#1452`).
   *
   * With no provenance this matches on the person alone, which is the
   * pre-`#1319` behaviour and the right one: a person writing to their citizen
   * is usually not writing *about* anything in particular, and a second such
   * message belongs in the thread that already holds the first. Naming an
   * account narrows it the same way a citizen's own ask does — so *the same
   * account again* lands in the thread that already holds the answer.
   */
  const existing =
    conversation === undefined
      ? await pairedConversation(
          db,
          toAgentId,
          accountId === undefined
            ? { humanId }
            : { humanId, provenance: { taskId: null, wishId: null, accountId } },
        )
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
    {
      answerKind,
      ...(accountId === undefined ? {} : { provenance: { taskId: null, wishId: null, accountId } }),
    },
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
  const accountId = input.provenance?.accountId ?? null

  if (wishId !== null) {
    const [wish] = await db
      .select({ id: accountWishes.id })
      .from(accountWishes)
      .where(and(eq(accountWishes.id, wishId), eq(accountWishes.agentId, agentId)))
      .limit(1)
    if (wish === undefined) return { outcome: 'refused', refusal: 'not-a-participant' }
  }

  /**
   * The same ownership check the wish gets, for the same reason (`#1441`): a
   * citizen naming an account row that is not its own would otherwise open a
   * thread whose subject is somebody else's, and the operator reading it would
   * be shown an account their agent does not hold.
   */
  if (accountId !== null) {
    const [account] = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.id, accountId), eq(accounts.agentId, agentId)))
      .limit(1)
    if (account === undefined) return { outcome: 'refused', refusal: 'not-a-participant' }
  }

  const existing = await pairedConversation(db, agentId, {
    humanId,
    provenance: { taskId, wishId, accountId },
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

  const opened = await openDirectConversation(
    db,
    agentId,
    { party: 'operator-human', humanId, label: input.label ?? 'your operator' },
    input.body,
    { provenance: { taskId, wishId, accountId }, openedBy: 'citizen' },
  )

  // `opened` is what the notify path reads to send one ping and never a second
  // (`#1321`). Set here rather than inside `openDirectConversation`, which also
  // serves the operator's own first message and the Colony's — neither of which
  // pings anybody.
  return opened.outcome === 'delivered' ? { ...opened, opened: true } : opened
}

/**
 * The handle a citizen is known by, for the one line an operator reads before
 * deciding whether to open the page (`#1321`).
 *
 * Here rather than looked up by the caller because the notify path is the only
 * thing that wants it and the alternative is a second exported reader of
 * `agents`. `undefined` for a citizen that has since been erased, which the
 * caller renders as *your agent* rather than as an empty string.
 */
export async function citizenHandle(db: Database, agentId: AgentId): Promise<string | undefined> {
  const [row] = await db
    .select({ name: agents.name })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1)

  return row?.name
}

/**
 * What one operator thread is about, in the words a person would recognise
 * (`#1321`).
 *
 * The same `coalesce(task title, wish provider)` the operator-request mail has
 * always named, read from the conversation's provenance rather than from an
 * exchange. `undefined` for a thread about nothing in particular, which is a
 * real state here and was not one there — the caller supplies its own phrase.
 *
 * **A title and never the message.** This is what goes into a mail subject and
 * into a Telegram line, both of which land on a lock screen; the words the
 * citizen wrote stay behind the link (epic `#1318`, decision 5).
 */
export async function operatorThreadContext(
  db: Database,
  conversation: ConversationId,
): Promise<string | undefined> {
  const [row] = await db
    .select({ context: sql<string | null>`coalesce(${tasks.title}, ${accountWishes.provider})` })
    .from(messageConversations)
    .leftJoin(tasks, eq(tasks.id, messageConversations.taskId))
    .leftJoin(accountWishes, eq(accountWishes.id, messageConversations.wishId))
    .where(eq(messageConversations.id, conversation))
    .limit(1)

  return row?.context ?? undefined
}

/**
 * Remember which Telegram message the Colony sent about which thread (`#1321`).
 *
 * `recordTelegramAsk` for conversations, and written under the same rule: only
 * on a delivered send, because a row here is the claim *this message exists in
 * that chat*, and one written for a send that failed would make a reply
 * resolvable to a thread nobody was told about.
 */
export async function recordMessageTelegramAsk(
  db: Database,
  input: {
    readonly conversationId: ConversationId
    readonly chatId: number
    readonly messageId: number
  },
): Promise<void> {
  await db
    .insert(messageTelegramAsks)
    .values({
      conversationId: input.conversationId,
      chatId: input.chatId,
      messageId: input.messageId,
    })
    /**
     * One ping per thread, so a second row is a state that should not exist. If
     * it ever does — a retry the caller thought had failed — the *latest*
     * message is the one an operator is looking at and would reply to.
     */
    .onConflictDoUpdate({
      target: messageTelegramAsks.conversationId,
      set: { chatId: input.chatId, messageId: input.messageId },
    })
}

/** What a Telegram reply did. The same three facts `answerOperatorRequestFromChat` answers. */
export type AnswerFromChatOutcome =
  | {
      readonly outcome: 'answered'
      readonly clearedSetAside: boolean
      readonly agentId: AgentId
      readonly conversationId: ConversationId
      readonly messageId: MessageId
    }
  | { readonly outcome: 'unreachable' }

/**
 * An operator's Telegram reply, written into the thread it answers (`#1321`).
 *
 * **Only from a bound chat, and only to a message the Colony sent** — the two
 * conditions decided in one query, exactly as `answerOperatorRequestFromChat`
 * decides them. A chat unbound with `/stop`, or rebound to somebody else, must
 * not be able to write into a thread it once received a message about.
 *
 * The person is resolved from the conversation's own `operator-human`
 * participant and never from the chat: the chat says *which citizen*, and which
 * human answers for that citizen is a fact the conversation already holds. So
 * no human id crosses the Telegram boundary, which is the property `#795` set
 * and this keeps.
 */
export async function answerOperatorMessageFromChat(
  db: Database,
  input: {
    readonly chatId: number
    readonly replyToMessageId: number
    readonly body: string
  },
): Promise<AnswerFromChatOutcome> {
  const citizen = alias(messageParticipants, 'citizen_side')
  const operator = alias(messageParticipants, 'operator_side')

  const [target] = await db
    .select({
      conversationId: messageTelegramAsks.conversationId,
      agentId: citizen.agentId,
      humanId: operator.humanId,
    })
    .from(messageTelegramAsks)
    .innerJoin(
      citizen,
      and(
        eq(citizen.conversationId, messageTelegramAsks.conversationId),
        eq(citizen.party, 'citizen'),
      ),
    )
    .innerJoin(
      operator,
      and(
        eq(operator.conversationId, messageTelegramAsks.conversationId),
        eq(operator.party, 'operator-human'),
      ),
    )
    .innerJoin(operatorTelegramChats, eq(operatorTelegramChats.agentId, citizen.agentId))
    .where(
      and(
        eq(messageTelegramAsks.chatId, input.chatId),
        eq(messageTelegramAsks.messageId, input.replyToMessageId),
        eq(operatorTelegramChats.chatId, input.chatId),
      ),
    )
    .limit(1)

  if (target === undefined || target.agentId === null || target.humanId === null) {
    return { outcome: 'unreachable' }
  }

  const agentId = target.agentId as AgentId
  const conversation = conversationId(target.conversationId)

  const sent = await sendOperatorMessage(
    db,
    target.humanId as HumanId,
    agentId,
    input.body,
    'your operator',
    undefined,
    conversation,
  )

  /**
   * A refusal here is not a Telegram failure and is reported as *unreachable*
   * all the same: the operator link was removed, or the body looks like a
   * credential — and both have already been answered in the chat by the caller,
   * which refuses a credential-shaped reply before it reaches this function.
   */
  if (sent.outcome !== 'delivered') return { outcome: 'unreachable' }

  return {
    outcome: 'answered',
    // `sendOperatorMessage` clears the set-aside inside its own transaction; the
    // boolean is not read back here because the caller's only use for it is the
    // sentence it writes to the operator, and that sentence does not name a task.
    clearedSetAside: false,
    agentId,
    conversationId: sent.conversationId,
    messageId: sent.messageId,
  }
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
  /**
   * A transaction is accepted here (`#1454`), and only here among the send
   * functions: `deleteHuman` has to tell an orphaned citizen inside the same
   * transaction that deletes its operator, or a rolled-back deletion would
   * leave a citizen told its operator had gone when it had not.
   */
  db: Database | Transaction,
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
  db: Database | Transaction,
  agentId: AgentId,
  other: {
    readonly humanId?: HumanId
    readonly systemRole?: MessageSystemRole
    readonly conversationId?: ConversationId
    readonly provenance?: {
      readonly taskId: TaskId | null
      readonly wishId: WishId | null
      readonly accountId: string | null
    }
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
              provenance.accountId === null
                ? isNull(messageConversations.accountId)
                : eq(messageConversations.accountId, provenance.accountId),
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
  db: Database | Transaction,
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
    readonly openedBy?: 'sender' | 'citizen' | 'colony'
  } = {},
): Promise<SendResult> {
  return await db.transaction(async (tx) => {
    const [conversation] = await tx
      .insert(messageConversations)
      .values({
        taskId: extra.provenance?.taskId ?? null,
        wishId: extra.provenance?.wishId ?? null,
        accountId: extra.provenance?.accountId ?? null,
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

    /**
     * **A third opener, since `#1445`.** A handoff opens an *operator* thread —
     * the person is the counterparty and must be in it — but the first sentence
     * is the Colony's, composed from a recipe. So the participants are the
     * operator's open and the author is a `system-role` row added beside them,
     * which is what makes *no agent wrote this* something the reader can see
     * rather than something they are told.
     */
    const colonyAuthor =
      extra.openedBy !== 'colony'
        ? undefined
        : await (async () => {
            const [row] = await tx
              .insert(messageParticipants)
              .values({
                conversationId: conversation.id,
                party: 'system-role',
                systemRole: 'academy',
                label: 'the Colony',
              })
              .returning({ id: messageParticipants.id })
            if (row === undefined) throw new Error('inserting a Colony participant returned no row')
            return {
              id: row.id,
              conversationId: conversation.id,
              party: 'system-role' as const,
              label: 'the Colony',
              systemRole: 'academy' as const,
            }
          })()

    const author =
      colonyAuthor ??
      (extra.openedBy === 'citizen'
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
          })

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

  // Two statements for the whole page rather than two per thread (`#1441`).
  const aboutById = await conversationSubjects(db, ids)
  const sharesById = await conversationShares(db, ids)

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
      about: aboutById.get(row.conversationId) ?? null,
      shares: sharesById.get(row.conversationId) ?? [],
    }
  })
}

/**
 * What each of these threads is about, in one statement (`#1441`).
 *
 * **Three left joins and one `coalesce` per field**, rather than three queries
 * or a branch per row: the provenance columns are mutually exclusive by
 * `message_conversations_provenance`, so at most one side of each coalesce can
 * be non-null and the database is the thing that guarantees it.
 *
 * The label is what a person would recognise — a task's title, a wish's
 * provider, an account's identifier — because the operator reading this has
 * never seen a uuid and should not have to start.
 */
async function conversationSubjects(
  db: Database,
  ids: readonly string[],
): Promise<ReadonlyMap<string, ConversationAbout>> {
  if (ids.length === 0) return new Map()

  const rows = await db
    .select({
      conversationId: messageConversations.id,
      taskId: messageConversations.taskId,
      taskTitle: tasks.title,
      wishId: messageConversations.wishId,
      wishProvider: accountWishes.provider,
      accountId: messageConversations.accountId,
      accountIdentifier: accounts.identifier,
    })
    .from(messageConversations)
    .leftJoin(tasks, eq(tasks.id, messageConversations.taskId))
    .leftJoin(accountWishes, eq(accountWishes.id, messageConversations.wishId))
    .leftJoin(accounts, eq(accounts.id, messageConversations.accountId))
    .where(inArray(messageConversations.id, [...ids]))

  const subjects = new Map<string, ConversationAbout>()

  for (const row of rows) {
    if (row.taskId !== null) {
      subjects.set(row.conversationId, {
        kind: 'task',
        id: row.taskId,
        label: row.taskTitle ?? row.taskId,
      })
    } else if (row.wishId !== null) {
      subjects.set(row.conversationId, {
        kind: 'wish',
        id: row.wishId,
        label: row.wishProvider ?? row.wishId,
      })
    } else if (row.accountId !== null) {
      subjects.set(row.conversationId, {
        kind: 'account',
        id: row.accountId,
        label: row.accountIdentifier ?? row.accountId,
      })
    }
  }

  return subjects
}

/**
 * The vault entries currently shared onto each of these threads (`#1441`).
 *
 * **Joined on the share still being open**, so a take-back or an expiry detaches
 * it without anything deleting a row. That is why there is no detach call:
 * ending the share is the only way an attachment goes, and one way is what stops
 * a thread and a page disagreeing about who can read what.
 *
 * **No value comes out of here**, in either direction. `sealed_value` is not in
 * the select at all, which is a stronger statement than not returning it.
 */
async function conversationShares(
  db: Database,
  ids: readonly string[],
): Promise<ReadonlyMap<string, ConversationShare[]>> {
  if (ids.length === 0) return new Map()

  const rows = await db
    .select({
      conversationId: messageConversationShares.conversationId,
      vaultKey: vaultShares.vaultKey,
      purpose: vaultShares.purpose,
      expiresAt: vaultShares.expiresAt,
      operatorAddition: vaultShares.operatorAddition,
    })
    .from(messageConversationShares)
    .innerJoin(vaultShares, eq(vaultShares.id, messageConversationShares.shareId))
    .where(
      and(
        inArray(messageConversationShares.conversationId, [...ids]),
        isNull(vaultShares.takenBackAt),
        sql`${vaultShares.expiresAt} > now()`,
      ),
    )
    .orderBy(asc(messageConversationShares.attachedAt))

  const attached = new Map<string, ConversationShare[]>()

  for (const row of rows) {
    const list = attached.get(row.conversationId) ?? []
    list.push({
      vaultKey: row.vaultKey,
      purpose: row.purpose,
      expiresAt: row.expiresAt,
      operatorWrote: row.operatorAddition !== null,
    })
    attached.set(row.conversationId, list)
  }

  return attached
}

/**
 * Attach an open share to a thread the citizen is in (`#1441`).
 *
 * **Refuses a conversation the caller is not a participant of**, which is the
 * only authorisation here and is the same one every other write in this file
 * makes: a share attached to somebody else's thread would show a credential to
 * a person who was never asked.
 *
 * Idempotent through the primary key rather than through a read — attaching the
 * same share twice is the same attachment, and two wakings racing must not
 * produce a 500.
 */
export async function attachShareToConversation(
  db: Database,
  agentId: AgentId,
  conversation: ConversationId,
  shareId: string,
): Promise<'attached' | 'not-a-participant'> {
  const me = await participantOf(db, conversation, agentId)
  if (me === undefined) return 'not-a-participant'

  await db
    .insert(messageConversationShares)
    .values({ conversationId: conversation, shareId })
    .onConflictDoNothing()

  return 'attached'
}

/**
 * The open operator thread about one account, if there is one (`#1441`).
 *
 * **The join read from the account's side.** A citizen waking mid-episode has
 * the account and needs the thread; without this it would have to list every
 * thread and look for the one whose subject matched, which is the kind of work
 * an agent does once and then stops doing.
 */
export async function conversationAboutAccount(
  db: Database,
  agentId: AgentId,
  accountId: string,
): Promise<ConversationId | undefined> {
  const [row] = await db
    .select({ id: messageConversations.id })
    .from(messageConversations)
    .innerJoin(
      messageParticipants,
      and(
        eq(messageParticipants.conversationId, messageConversations.id),
        eq(messageParticipants.agentId, agentId),
      ),
    )
    .where(eq(messageConversations.accountId, accountId))
    .orderBy(desc(messageConversations.createdAt))
    .limit(1)

  return row === undefined ? undefined : conversationId(row.id)
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
  const about = (await conversationSubjects(db, [id])).get(id) ?? null
  const shares = (await conversationShares(db, [id])).get(id) ?? []

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
    about,
    shares,
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

/**
 * The Colony's own sentence, into the citizen's operator thread (`#1445`).
 *
 * ## Why this exists rather than the citizen's send path
 *
 * `kolonie.accounts.handoff` composes its ask from a recipe and never from the
 * agent — `packages/core/src/operator/handover.ts` states it as constraint 4:
 * *"An agent that could compose the message arriving beside its secret is a
 * different and worse thing."* That is a prompt-injection boundary, and a person
 * reading a handoff is reading text no agent could have authored.
 *
 * **`#1437` frozen decision 2 does not reach this.** A citizen may write the
 * sentence beside a *share*, because a share hangs on a thread the citizen is
 * visibly writing in. A handoff has no such thread: it arrives cold, from a
 * recipe step, about a provider the operator may never have heard of. So the
 * Colony keeps writing it — and, since `#1445`, the message is attributed to the
 * Colony rather than delivered as the citizen's, which is what lets the operator
 * see the property rather than be told about it.
 *
 * ## It joins the operator's thread rather than opening a Colony one
 *
 * `sendSystemMessage` opens a thread between the Colony and the citizen, which
 * the operator is not in and cannot read. This writes into the thread the
 * *operator* is in, as a `system-role` participant added to it — so the ask, the
 * citizen's own words about the same account, and the operator's answer are one
 * conversation. That is the whole of `#1445`: a handoff and the conversation
 * about the same account stop being two places.
 */
export async function sendColonyMessageToOperatorThread(
  db: Database,
  agentId: AgentId,
  provenance: ConversationProvenance,
  body: string,
): Promise<SendResult> {
  const [link] = await db
    .select({ humanId: humanAgents.humanId })
    .from(humanAgents)
    .where(eq(humanAgents.agentId, agentId))
    .limit(1)

  if (link === undefined) return { outcome: 'refused', refusal: 'not-the-operator' }

  const humanId = link.humanId as HumanId
  const taskId = provenance.taskId ?? null
  const wishId = provenance.wishId ?? null
  const accountId = provenance.accountId ?? null

  const existing = await pairedConversation(db, agentId, {
    humanId,
    provenance: { taskId, wishId, accountId },
  })

  /**
   * A second handoff about the same account reuses the thread, which is
   * `#1445`'s own acceptance criterion and falls out of the provenance match
   * rather than being arranged: *the same subject* finds the thread that already
   * holds the answer.
   */
  if (existing !== undefined) {
    const colonySide = await colonyParticipant(db, conversationId(existing.conversationId))
    const id = await insertMessage(db, colonySide, body)
    return {
      outcome: 'delivered',
      conversationId: conversationId(existing.conversationId),
      messageId: id,
    }
  }

  const opened = await openDirectConversation(
    db,
    agentId,
    { party: 'operator-human', humanId, label: 'your operator' },
    body,
    { provenance: { taskId, wishId, accountId }, openedBy: 'colony' },
  )

  return opened.outcome === 'delivered' ? { ...opened, opened: true } : opened
}

/**
 * The Colony's participant row on one conversation, made if it is not there.
 *
 * **`academy` is the role**, because a handoff is a step of an onboarding recipe
 * and `MessageSystemRoleSchema` has no closer member. It is a claim of authority
 * — every role here writes past a block — and this one is the Colony saying a
 * sentence it composed itself, which is exactly the authority in question.
 */
async function colonyParticipant(db: Database | Transaction, conversation: ConversationId) {
  const [existing] = await db
    .select({
      id: messageParticipants.id,
      conversationId: messageParticipants.conversationId,
      party: messageParticipants.party,
      label: messageParticipants.label,
      systemRole: messageParticipants.systemRole,
    })
    .from(messageParticipants)
    .where(
      and(
        eq(messageParticipants.conversationId, conversation),
        eq(messageParticipants.party, 'system-role'),
      ),
    )
    .limit(1)

  if (existing !== undefined) {
    return {
      id: existing.id,
      conversationId: existing.conversationId,
      party: existing.party,
      label: existing.label,
      systemRole: existing.systemRole,
    }
  }

  const [made] = await db
    .insert(messageParticipants)
    .values({
      conversationId: conversation,
      party: 'system-role',
      systemRole: 'academy',
      label: 'the Colony',
    })
    .returning({
      id: messageParticipants.id,
      conversationId: messageParticipants.conversationId,
      party: messageParticipants.party,
      label: messageParticipants.label,
      systemRole: messageParticipants.systemRole,
    })

  if (made === undefined) throw new Error('inserting a Colony participant returned no row')

  return {
    id: made.id,
    conversationId: made.conversationId,
    party: made.party,
    label: made.label,
    systemRole: made.systemRole,
  }
}

/**
 * One row of a person's inbox (`#1448`, epic `#1447`).
 *
 * **Across every agent they operate**, which is the defect the epic is about:
 * every operator surface was `/agents/:agentId/…`, so a person with three
 * agents had three message pages and no view of what was waiting.
 */
export interface InboxRow {
  readonly conversationId: ConversationId
  readonly agentId: string
  /** The agent's handle, because a person reading this holds names and not ids. */
  readonly agentName: string
  /** What the thread is about, or null for one about nothing in particular. */
  readonly about: ConversationAbout | null
  /**
   * The **latest** message, not the first.
   *
   * The waiting queue shows the first deliberately — *the second message is
   * usually a nudge rather than the question* — which is right for a queue of
   * unanswered asks and wrong for an inbox: a thread that moved three times
   * would render its opening line from two weeks ago.
   */
  readonly latest: {
    readonly body: string
    readonly at: string
    readonly senderLabel: string
    readonly mine: boolean
  } | null
  /**
   * Whether anything from anybody else is newer than this person's cursor.
   *
   * **From `last_read_message_id` and from nothing else.** The agents' side
   * already uses that column through `kolonie.messages.mark_read`, and two
   * definitions of read would disagree within a week.
   */
  readonly unread: boolean
  /** How many of the messages are unread, for the one number a list wants. */
  readonly unreadCount: number
  /**
   * Whether this person has said they are finished with it (`#1449`).
   *
   * Three states and three columns, which `#1447` froze: unread is the cursor,
   * muted is *stop telling me*, and this is *take it out of my list*. A new
   * message from anybody else clears it.
   */
  readonly archived: boolean
  /**
   * Until when this person has silenced it, or null.
   *
   * **A muted thread still appears and still shows unread.** Mute is about
   * being told, not about being listed — folding the two would mean silencing a
   * chatty thread also lost it.
   */
  readonly mutedUntil: string | null
}

/**
 * Which slice of the inbox to answer (`#1449`).
 *
 * **Not folders — the same query with one predicate.** A folder is a place a
 * thread is *in*, which would make archiving a move and un-archiving a second
 * move somebody has to find; this is a column and a `where`.
 */
export type InboxView = 'open' | 'archived' | 'all'

/**
 * Every thread this person is a participant of, newest activity first.
 *
 * **Activity, not creation.** An inbox ordered by when a thread opened puts a
 * conversation that moved this morning below one that has been quiet for a
 * fortnight, which is the ordering of an archive rather than of an inbox.
 *
 * **Participation is the whole ACL, exactly as everywhere else in this file**
 * (`#1447` frozen decision 2). It starts from this person's own participant
 * rows, so there is no shape of input that reaches another person's thread, nor
 * any of their agents' conversations with other citizens or with the Colony —
 * reading those would be surveillance and would break what `kolonie.messages`
 * promises the other party.
 */
export async function inboxFor(
  db: Database,
  humanId: HumanId,
  options: {
    readonly agentId?: AgentId
    readonly limit?: number
    /** Open by default: an inbox is what is left to deal with. */
    readonly view?: InboxView
    /** Only threads with something newer than this person's cursor (`#1450`). */
    readonly unreadOnly?: boolean
    /** Only threads about one account (`#1450`, and `#1441` for the subject). */
    readonly accountId?: string
    /**
     * Only threads this person has written in — *sent*, as a filter (`#1450`).
     *
     * **Not a folder.** A sent-folder is an artefact of mail having no threads:
     * when a reply is a new object with no parent, a separate pile is the only
     * way to find what you wrote. Here every message already sits in the
     * conversation it belongs to, so *did I ever answer that* is a predicate
     * over this same list and the person stays where they were reading.
     */
    readonly writtenByMe?: boolean
    /**
     * A substring to look for, case-insensitively (`#1450`, frozen decision 5).
     *
     * **Plain `ILIKE` over message body, agent name and thread subject.** No
     * full-text index, no ranking, no trigram similarity: the corpus is 243
     * messages, and when a sequential scan over it is measurably slow *that
     * measurement* is the issue which adds an index — one that will be better
     * for having a real query pattern behind it. See the comment on the `hit`
     * term below for what would justify one.
     */
    readonly search?: string
  } = {},
): Promise<readonly InboxRow[]> {
  /**
   * `%` and `_` are wildcards in `like`, and a person searching for `100%` means
   * the characters. Escaped here rather than by refusing them, because a search
   * box that rejects punctuation is a search box people stop using.
   */
  const term =
    options.search === undefined || options.search.trim() === ''
      ? null
      : `%${options.search.trim().replace(/([\\%_])/g, '\\$1')}%`

  const rows = await db.execute<{
    conversation_id: string
    agent_id: string
    agent_name: string
    latest_body: string | null
    latest_at: string | null
    latest_label: string | null
    latest_mine: boolean | null
    unread_count: string
    done_at: string | null
    muted_until: string | null
  }>(sql`
    with mine as (
      select p.id as participant_id,
             p.conversation_id,
             p.last_read_message_id,
             p.done_at,
             p.muted_until
        from message_participants p
       where p.human_id = ${humanId}::uuid
    ),
    -- The agent side of each of those threads. An operator thread has exactly
    -- one citizen in it, and the join is what puts a name on the row.
    theirs as (
      select mine.conversation_id, p.agent_id, a.name as agent_name
        from mine
        join message_participants p
          on p.conversation_id = mine.conversation_id and p.agent_id is not null
        join agents a on a.id = p.agent_id
    ),
    cursor_at as (
      select mine.conversation_id, m.created_at
        from mine
        left join messages m on m.id = mine.last_read_message_id
    ),
    latest as (
      select distinct on (m.conversation_id)
             m.conversation_id, m.body, m.created_at, m.sender_label, m.sender_participant_id
        from messages m
        join mine on mine.conversation_id = m.conversation_id
       order by m.conversation_id, m.created_at desc, m.id desc
    ),
    unread as (
      select m.conversation_id, count(*)::text as unread_count
        from messages m
        join mine on mine.conversation_id = m.conversation_id
        left join cursor_at on cursor_at.conversation_id = m.conversation_id
       where m.sender_participant_id <> mine.participant_id
         and (cursor_at.created_at is null or m.created_at > cursor_at.created_at)
       group by m.conversation_id
    ),
    -- What each thread is *about*, denormalised to one label so the account
    -- filter and the subject half of the search are both one predicate. The
    -- same three columns conversationSubjects reads, in the same precedence.
    subject as (
      select c.id as conversation_id,
             c.account_id,
             coalesce(t.title, w.provider, ac.identifier) as label
        from message_conversations c
        join mine on mine.conversation_id = c.id
        left join tasks t on t.id = c.task_id
        left join account_wishes w on w.id = c.wish_id
        left join accounts ac on ac.id = c.account_id
    ),
    -- Threads this person has written at least one message into.
    wrote as (
      select distinct m.conversation_id
        from messages m
        join mine on mine.participant_id = m.sender_participant_id
    ),
    -- Threads with a message body matching the search, over *every* message
    -- rather than the latest: somebody looking for what was said a fortnight
    -- ago would otherwise be told it is not there.
    hit as (
      select distinct m.conversation_id
        from messages m
        join mine on mine.conversation_id = m.conversation_id
       where ${term === null ? sql`false` : sql`m.body ilike ${term} escape '\\'`}
    )
    select theirs.conversation_id,
           theirs.agent_id,
           theirs.agent_name,
           latest.body as latest_body,
           latest.created_at as latest_at,
           latest.sender_label as latest_label,
           (latest.sender_participant_id = mine.participant_id) as latest_mine,
           coalesce(unread.unread_count, '0') as unread_count,
           mine.done_at,
           mine.muted_until
      from theirs
      join mine on mine.conversation_id = theirs.conversation_id
      left join latest on latest.conversation_id = theirs.conversation_id
      left join unread on unread.conversation_id = theirs.conversation_id
      left join subject on subject.conversation_id = theirs.conversation_id
      left join wrote on wrote.conversation_id = theirs.conversation_id
      left join hit on hit.conversation_id = theirs.conversation_id
     where ${options.agentId === undefined ? sql`true` : sql`theirs.agent_id = ${options.agentId}::uuid`}
       and ${
         (options.view ?? 'open') === 'all'
           ? sql`true`
           : (options.view ?? 'open') === 'archived'
             ? sql`mine.done_at is not null`
             : sql`mine.done_at is null`
       }
       -- Every filter below is combinable, and each is one and: four
       -- predicates over the same list rather than four ways of listing.
       and ${options.unreadOnly === true ? sql`unread.unread_count is not null` : sql`true`}
       and ${
         options.accountId === undefined
           ? sql`true`
           : sql`subject.account_id = ${options.accountId}::uuid`
       }
       and ${options.writtenByMe === true ? sql`wrote.conversation_id is not null` : sql`true`}
       -- Body, agent name or subject. All three are inside mine, so a search
       -- cannot reach a thread this person is not in — which is the surveillance
       -- leak #1447 frozen decision 2 refused, arriving through the back door.
       and ${
         term === null
           ? sql`true`
           : sql`(hit.conversation_id is not null
                  or theirs.agent_name ilike ${term} escape '\\'
                  or subject.label ilike ${term} escape '\\')`
       }
     order by coalesce(latest.created_at, 'epoch'::timestamptz) desc, theirs.conversation_id
     limit ${options.limit ?? CONVERSATION_LIST_LIMIT}
  `)

  const subjects = await conversationSubjects(
    db,
    rows.map((row) => row.conversation_id),
  )

  return rows.map((row) => ({
    conversationId: conversationId(row.conversation_id),
    agentId: row.agent_id,
    agentName: row.agent_name,
    about: subjects.get(row.conversation_id) ?? null,
    latest:
      row.latest_at === null
        ? null
        : {
            body: row.latest_body ?? '',
            at: row.latest_at,
            senderLabel: row.latest_label ?? '',
            mine: row.latest_mine === true,
          },
    unread: Number(row.unread_count) > 0,
    unreadCount: Number(row.unread_count),
    archived: row.done_at !== null,
    mutedUntil: row.muted_until,
  }))
}

/** What an archive or a mute did, or why it did nothing. */
export type InboxStateOutcome =
  { readonly outcome: 'set' } | { readonly outcome: 'not-a-participant' }

/**
 * Say this person is, or is no longer, finished with a thread (`#1449`).
 *
 * **Archiving is not deleting**, and this is the whole of what it does: one
 * timestamp on one participant row. The thread stays, its messages stay, and a
 * message from anybody else clears it in the same insert that writes the
 * message. That is what makes it safe to use liberally — nothing is lost by
 * being wrong about it.
 *
 * **It does not mark read**, and marking read does not archive. Two acts on two
 * columns: a person who archives an unread thread has decided not to read it,
 * which is a thing they are allowed to decide.
 */
export async function archiveConversationForOperator(
  db: Database,
  humanId: HumanId,
  id: ConversationId,
  archived: boolean,
): Promise<InboxStateOutcome> {
  const changed = await db
    .update(messageParticipants)
    .set({ doneAt: archived ? currentTime() : null })
    .where(
      and(eq(messageParticipants.conversationId, id), eq(messageParticipants.humanId, humanId)),
    )
    .returning({ id: messageParticipants.id })

  return changed.length === 0 ? { outcome: 'not-a-participant' } : { outcome: 'set' }
}

/**
 * Silence a thread for this person, until a date or indefinitely (`#1449`).
 *
 * **A muted thread stays in the list and still shows unread.** Mute is about
 * being *told*, and `#1451`'s notifier is what reads it. Folding it into archive
 * would mean a person silencing a chatty thread also lost it from their list,
 * which is two intentions wearing one column.
 *
 * **The other party is never told.** An agent that learned it had been muted
 * would reasonably open a second thread, which is exactly what muting was for.
 *
 * `null` un-mutes.
 */
export async function muteConversationForOperator(
  db: Database,
  humanId: HumanId,
  id: ConversationId,
  until: string | null,
): Promise<InboxStateOutcome> {
  const changed = await db
    .update(messageParticipants)
    .set({ mutedUntil: until })
    .where(
      and(eq(messageParticipants.conversationId, id), eq(messageParticipants.humanId, humanId)),
    )
    .returning({ id: messageParticipants.id })

  return changed.length === 0 ? { outcome: 'not-a-participant' } : { outcome: 'set' }
}

/** How long one thread stays quiet after this person has been told about it. */
export const OPERATOR_NOTIFY_QUIET_HOURS = 24

/**
 * Decide whether to tell this person a message arrived, and claim it (`#1451`).
 *
 * ## The rule
 *
 * `#1321` carried `operator_addresses`' rule across: **one ping per thread, and
 * never on a reply**. Measured in production on 2026-08-20, that meant sixteen
 * threads had an agent message newer than the operator's last reply and nobody
 * had been told about any of them. The rule that replaces it — `#1447` frozen
 * decision 1 — is four conditions, all of which must hold:
 *
 * 1. The message is from **somebody else**. A person is not told about their own
 *    words, which is the one condition the old rule also had.
 * 2. The thread is **unread** for this person at this moment. A thread they are
 *    actively reading needs no mail; this is what replaces *never on a reply*
 *    and keeps most of its effect.
 * 3. Nothing has gone out about this thread in the last
 *    {@link OPERATOR_NOTIFY_QUIET_HOURS} hours.
 * 4. The thread is **not muted**, whatever the other three say. That is what
 *    mute is (`#1449`) — *keep it in my list, stop telling me about it* — and
 *    it is checked last here only because it is the one that overrides.
 *
 * What this preserves: an agent writing four times into a thread opened this
 * morning still costs one mail, and an agent nudging the same unread thread
 * hourly for a day still costs one. What it fixes: a reply to a thread the
 * person answered last week now arrives.
 *
 * ## Why it claims rather than reports
 *
 * The stamp is written in the same statement that decides, so two messages
 * landing at once cannot both find it stale — a read followed by a write would
 * be one mail per concurrent send, which is the flood the old rule protected
 * against arriving by a different route. A caller that decides not to send
 * afterwards has spent a quiet period rather than sent a duplicate, which is
 * the cheaper of the two mistakes.
 *
 * **Unread is the same cursor the inbox counts from**, so a person cannot be
 * mailed about a thread the page shows as read.
 */
export async function claimOperatorNotification(
  db: Database,
  conversationId: ConversationId,
  messageId: MessageId,
): Promise<{ readonly humanId: HumanId } | undefined> {
  const claimed = await db.execute<{ human_id: string }>(sql`
    with sent as (
      select m.id, m.created_at, m.sender_participant_id
        from messages m
       where m.id = ${messageId}::uuid and m.conversation_id = ${conversationId}::uuid
    ),
    -- The person's own row, and where their cursor is. A thread with no human
    -- participant is a citizen or a Colony thread, and neither pings anybody.
    theirs as (
      select p.id, p.human_id, p.muted_until, p.notified_at, read.created_at as read_at
        from message_participants p
        left join messages read on read.id = p.last_read_message_id
       where p.conversation_id = ${conversationId}::uuid and p.human_id is not null
    )
    update message_participants
       set notified_at = now()
      from theirs, sent
     where message_participants.id = theirs.id
       -- 1. Not their own words.
       and sent.sender_participant_id <> theirs.id
       -- 2. Unread: nothing read yet, or this message is newer than the cursor.
       and (theirs.read_at is null or sent.created_at > theirs.read_at)
       -- 3. Quiet for a day.
       and (
         theirs.notified_at is null
         or theirs.notified_at < now() - ${sql.raw(`interval '${OPERATOR_NOTIFY_QUIET_HOURS} hours'`)}
       )
       -- 4. Not muted, which overrides the other three.
       and (theirs.muted_until is null or theirs.muted_until <= now())
    returning theirs.human_id
  `)

  const row = claimed[0]
  return row === undefined ? undefined : { humanId: HumanIdSchema.parse(row.human_id) }
}

/**
 * Move this person's read cursor to the newest message of one thread (`#1448`).
 *
 * **The single missing write that makes the whole surface possible.** Measured
 * 2026-08-20, `message_participants.last_read_message_id` was null for all 52
 * operator participants: the column existed, the agents' side wrote it through
 * `kolonie.messages.mark_read`, and nothing in the console ever did — so a
 * person had no notion of *unread* at all, only of *never answered*.
 *
 * The agent's own `markConversationRead` is the same act one participant column
 * over. Two functions rather than one because the two are found by different
 * keys, and a single function taking *either* an agent or a human is a function
 * whose authorisation a reader has to work out from which argument is set.
 */
export async function markConversationReadByOperator(
  db: Database,
  humanId: HumanId,
  id: ConversationId,
): Promise<{ readonly outcome: 'marked' } | { readonly outcome: 'not-a-participant' }> {
  const [me] = await db
    .select({ id: messageParticipants.id })
    .from(messageParticipants)
    .where(
      and(eq(messageParticipants.conversationId, id), eq(messageParticipants.humanId, humanId)),
    )
    .limit(1)

  if (me === undefined) return { outcome: 'not-a-participant' }

  const [newest] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.conversationId, id))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(1)

  // A thread nobody has written in has no cursor to move, and that is `marked`
  // rather than a refusal: the person has read everything there is.
  if (newest === undefined) return { outcome: 'marked' }

  await db
    .update(messageParticipants)
    .set({ lastReadMessageId: newest.id })
    .where(eq(messageParticipants.id, me.id))

  return { outcome: 'marked' }
}
