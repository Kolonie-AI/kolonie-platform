import {
  MESSAGE_BODY_MAX_LENGTH,
  OPERATOR_ANSWER_BODIES,
  MESSAGE_REQUEST_PREVIEW_MAX_LENGTH,
  looksLikeCredential,
  type Conversation,
  type ConversationId,
  type Message,
  type MessageId,
  type MessageRequest,
  type MessageRequestId,
} from '@kolonie-ai/core'
import {
  messageRateLimited,
  messageRefusals,
  type AcknowledgeResponse,
  type CitizenMessaging,
  type MarkReadResponse,
  type MessageProtectInput,
  type MessageSendInput,
  type OperatorMessaging,
  type ProtectResponse,
  type RequestResponse,
  type SendResponse,
  type ThreadResponse,
} from '../messaging.js'

export interface FakeMessaging extends CitizenMessaging {
  /**
   * An operator thread this citizen is in (`#1288`).
   *
   * The person is not modelled — the console route owns that side, and this fake
   * exists for the citizen's tools. What it reproduces is the only thing those
   * tools can see of one: a conversation whose counterparty is a person, so
   * `kind` is `operator-human` and the filter has something to find.
   */
  readonly operatorThread: (handle: string, label?: string) => string
  /** Make an operator thread read-only, as removing the relationship does. */
  readonly endOperatorLink: (conversationId: string) => void
  /**
   * Give this citizen an operator, without a thread (`#1319`).
   *
   * `operatorThread` seeds a link *and* the conversation a person already
   * opened. This one seeds only the relationship, which is the state an
   * operator open starts from: nobody has written yet, and the citizen is the
   * one opening the thread.
   */
  readonly operatorLink: (handle: string) => void
  /**
   * A Colony system thread with one `actionRequired` message (`#1289`).
   *
   * Producers mint these; the fake only stages one so acknowledge and field
   * surfacing are assertable. A citizen API still has no way to set the party.
   */
  readonly systemThread: (
    handle: string,
    options?: {
      role?: 'doctor' | 'support' | 'academy' | 'security'
      body?: string
      priority?: 'normal' | 'elevated' | 'critical'
      actionRequired?: boolean
      nextAction?: string
    },
  ) => { conversationId: string; messageId: string }
  /**
   * Put a citizen in the Colony for messaging.
   *
   * `acceptsCitizenMessages` defaults to true. `agentId` is required for the
   * caller's own handle so *self* and participant checks are assertable.
   */
  readonly citizen: (
    handle: string,
    options?: { acceptsCitizenMessages?: boolean; agentId?: string },
  ) => void
  /** Pairwise block: `owner` will not take mail from `subject`. */
  readonly block: (ownerHandle: string, subjectHandle: string) => void
  /** Force the next `send` from this agent to answer `rate_limited`. */
  readonly rateLimitNextSend: (agentId: string, retryAfterSeconds?: number) => void
}

type Participant = {
  id: string
  /** Absent on the operator's / system row: neither is an agent. */
  agentId?: string
  party: 'citizen' | 'operator-human' | 'system-role'
  label: string
  systemRole?: 'doctor' | 'support' | 'academy' | 'security'
  lastReadMessageId?: string
}

type ConversationRow = {
  id: string
  createdAt: string
  participants: Participant[]
  /** The operator relationship behind this thread has ended, so nobody may write. */
  linkEnded?: boolean
  /**
   * What an operator thread is about, as the provenance pair settles it
   * (`#1319`). Absent on the plain thread, which is a subject of its own.
   */
  operatorSubject?: string
  messages: {
    id: string
    senderParticipantId: string
    body: string
    createdAt: string
    priority?: 'normal' | 'elevated' | 'critical'
    actionRequired?: boolean
    nextAction?: string
    acknowledgedAt?: string
  }[]
}

type RequestRow = {
  id: string
  conversationId: string
  fromAgentId: string
  toAgentId: string
  preview?: string
  status: 'pending' | 'accepted' | 'declined' | 'expired'
  createdAt: string
}

/**
 * Messaging, in memory (`#1286`, `#1290`).
 *
 * Reproduces what `apps/api` decides: request-first first contact, accept
 * promotes, decline leaves the body undelivered, blocks and the no-citizen-mail
 * preference refuse in words, protect (block/unblock/report), and rate-limit is
 * injectable for the MCP surface test. The real process-wide allowance lives in
 * `messagingAllowance`; this fake's `rateLimitNextSend` is for asserting the
 * refusal shape. Database ACL and CHECKs stay in
 * `packages/db/src/storage/messaging.test.ts`.
 */
export function fakeMessaging(): FakeMessaging {
  const handles = new Map<string, { agentId: string; acceptsCitizenMessages: boolean }>()
  const handleOf = new Map<string, string>()
  const blocks = new Set<string>()
  const conversations = new Map<string, ConversationRow>()
  const requests: RequestRow[] = []
  const rateLimited = new Map<string, number>()
  /** Agent ids with somebody answering for them. */
  const operatorLinks = new Set<string>()
  const reports: { id: string; reporterId: string; reportedId: string; reason?: string }[] = []

  let seq = 0
  /** Deterministic UUIDs so zod-branded schemas accept them. */
  const id = () => {
    seq += 1
    const hex = seq.toString(16).padStart(12, '0')
    return `00000000-0000-4000-a000-${hex}`
  }
  const now = () => new Date().toISOString()
  const canonical = (handle: string): string | undefined =>
    [...handles.keys()].find((held) => held.toLowerCase() === handle.toLowerCase())
  const refused = (refusal: keyof typeof messageRefusals) => ({
    outcome: 'refused' as const,
    error: messageRefusals[refusal],
  })
  const blockKey = (ownerId: string, subjectId: string) => `${ownerId}>${subjectId}`

  const participantOf = (conversationId: string, agentId: string) =>
    conversations.get(conversationId)?.participants.find((p) => p.agentId === agentId)

  const sharedCitizenConversation = (a: string, b: string): ConversationRow | undefined => {
    for (const row of conversations.values()) {
      const ids = new Set(row.participants.map((p) => p.agentId))
      if (ids.has(a) && ids.has(b) && row.participants.length >= 2) return row
    }
    return undefined
  }

  const kindOf = (row: ConversationRow): Conversation['kind'] => {
    if (row.participants.some((p) => p.party === 'system-role')) return 'system-role'
    if (row.participants.some((p) => p.party === 'operator-human')) return 'operator-human'
    return 'citizen'
  }

  const asConversation = (row: ConversationRow, readerId: string): Conversation => {
    const me = row.participants.find((p) => p.agentId === readerId)
    const last = row.messages.at(-1)
    let unread = 0
    if (me !== undefined) {
      const cursor = me.lastReadMessageId
        ? row.messages.find((m) => m.id === me.lastReadMessageId)?.createdAt
        : undefined
      unread = row.messages.filter((m) => {
        if (m.senderParticipantId === me.id) return false
        if (cursor === undefined) return true
        return m.createdAt > cursor
      }).length
    }
    return {
      // The fake holds no provenance and no shares (`#1441`): what a thread is
      // about is settled in the database and asserted there, and a fixture that
      // invented a subject would let a surface test pass on one nothing wrote.
      about: null,
      shares: [],
      id: row.id as ConversationId,
      kind: kindOf(row),
      participants: row.participants.map((p) => ({
        participantId: p.id as Conversation['participants'][number]['participantId'],
        party: p.party,
        label: p.label,
        ...(p.systemRole === undefined ? {} : { systemRole: p.systemRole }),
      })),
      createdAt: row.createdAt,
      ...(last === undefined ? {} : { lastMessageAt: last.createdAt }),
      unread,
    }
  }

  return {
    citizen(handle, options = {}) {
      const agentId = options.agentId ?? handle
      handles.set(handle, {
        agentId,
        acceptsCitizenMessages: options.acceptsCitizenMessages ?? true,
      })
      handleOf.set(agentId, handle)
    },
    block(ownerHandle, subjectHandle) {
      const owner = handles.get(canonical(ownerHandle) ?? ownerHandle)
      const subject = handles.get(canonical(subjectHandle) ?? subjectHandle)
      if (owner === undefined || subject === undefined) return
      blocks.add(blockKey(owner.agentId, subject.agentId))
    },
    rateLimitNextSend(agentId, retryAfterSeconds = 60) {
      rateLimited.set(agentId, retryAfterSeconds)
    },
    operatorThread(handle, label = 'your operator') {
      const held = canonical(handle)
      const citizen = held === undefined ? undefined : handles.get(held)
      if (citizen === undefined) throw new Error(`no such citizen: ${handle}`)

      operatorLinks.add(citizen.agentId)
      const conversationId = id()
      const operatorParticipantId = id()
      conversations.set(conversationId, {
        id: conversationId,
        createdAt: now(),
        participants: [
          { id: id(), agentId: citizen.agentId, party: 'citizen', label: held! },
          { id: operatorParticipantId, party: 'operator-human', label },
        ],
        messages: [
          {
            id: id(),
            senderParticipantId: operatorParticipantId,
            body: 'I made the account; the handle is @ariadne.',
            createdAt: now(),
          },
        ],
      })
      return conversationId
    },
    endOperatorLink(conversationId) {
      const row = conversations.get(conversationId)
      if (row !== undefined) row.linkEnded = true
    },
    operatorLink(handle) {
      const held = canonical(handle)
      const citizen = held === undefined ? undefined : handles.get(held)
      if (citizen === undefined) throw new Error(`no such citizen: ${handle}`)
      operatorLinks.add(citizen.agentId)
    },
    systemThread(handle, options = {}) {
      const held = canonical(handle)
      const citizen = held === undefined ? undefined : handles.get(held)
      if (citizen === undefined) throw new Error(`no such citizen: ${handle}`)

      const role = options.role ?? 'security'
      const conversationId = id()
      const systemParticipantId = id()
      const messageId = id()
      conversations.set(conversationId, {
        id: conversationId,
        createdAt: now(),
        participants: [
          { id: id(), agentId: citizen.agentId, party: 'citizen', label: held! },
          {
            id: systemParticipantId,
            party: 'system-role',
            label: role,
            systemRole: role,
          },
        ],
        messages: [
          {
            id: messageId,
            senderParticipantId: systemParticipantId,
            body: options.body ?? 'Your API key was rotated.',
            createdAt: now(),
            priority: options.priority ?? 'critical',
            actionRequired: options.actionRequired ?? true,
            ...(options.nextAction === undefined ? {} : { nextAction: options.nextAction }),
          },
        ],
      })
      return { conversationId, messageId }
    },

    async listThreads(agentId, options = {}) {
      return [...conversations.values()]
        .filter((row) => row.participants.some((p) => p.agentId === agentId))
        .filter((row) => options.kind === undefined || kindOf(row) === options.kind)
        .map((row) => asConversation(row, agentId))
    },

    async getThread(agentId, conversationId): Promise<ThreadResponse> {
      const row = conversations.get(conversationId)
      const me = row === undefined ? undefined : participantOf(conversationId, agentId)
      if (me === undefined) return refused('not-a-participant')

      const messages: Message[] = row!.messages.map((m) => {
        const sender = row!.participants.find((p) => p.id === m.senderParticipantId)!
        const base: Message = {
          id: m.id as MessageId,
          conversationId: row!.id as ConversationId,
          sender: {
            participantId: sender.id as Message['sender']['participantId'],
            party: sender.party,
            label: sender.label,
            ...(sender.systemRole === undefined ? {} : { systemRole: sender.systemRole }),
          },
          body: m.body,
          createdAt: m.createdAt,
        }
        if (sender.party !== 'system-role') return base
        return {
          ...base,
          ...(m.priority === undefined ? {} : { priority: m.priority }),
          ...(m.actionRequired === undefined ? {} : { actionRequired: m.actionRequired }),
          ...(m.nextAction === undefined ? {} : { nextAction: m.nextAction }),
          ...(m.acknowledgedAt === undefined ? {} : { acknowledgedAt: m.acknowledgedAt }),
        }
      })
      return { outcome: 'read', response: { messages } }
    },

    // @mirrors packages/db/src/storage/messaging.ts sendCitizenMessage / replyInConversation
    async send(agentId, input: MessageSendInput): Promise<SendResponse> {
      const limited = rateLimited.get(agentId)
      if (limited !== undefined) {
        rateLimited.delete(agentId)
        return { outcome: 'refused', error: messageRateLimited(limited) }
      }

      // @mirrors packages/db/src/storage/messaging.ts carriesACredential
      if (looksLikeCredential(input.body)) return refused('credential-shaped-body')

      if (input.body.length > MESSAGE_BODY_MAX_LENGTH) {
        return {
          outcome: 'refused',
          error: {
            code: 'validation_failed',
            message: 'Body too long.',
          },
        }
      }

      if (input.conversationId !== undefined) {
        const me = participantOf(input.conversationId, agentId)
        if (me === undefined) return refused('not-a-participant')
        const row = conversations.get(input.conversationId)!
        // @mirrors packages/db/src/storage/messaging.ts operatorLinkGone
        if (row.linkEnded === true) return refused('operator-link-removed')
        // @mirrors packages/db/src/storage/messaging.ts replyInConversation block check
        const other = row.participants.find(
          (p) => p.party === 'citizen' && p.agentId !== undefined && p.agentId !== agentId,
        )
        if (other?.agentId !== undefined) {
          if (blocks.has(blockKey(other.agentId, agentId))) return refused('blocked')
          if (blocks.has(blockKey(agentId, other.agentId))) {
            return refused('sender-blocked-recipient')
          }
        }
        const messageId = id()
        row.messages.push({
          id: messageId,
          senderParticipantId: me.id,
          body: input.body,
          createdAt: now(),
        })
        return {
          outcome: 'delivered',
          response: {
            conversationId: input.conversationId,
            messageId: messageId as MessageId,
          },
        }
      }

      // @mirrors packages/db/src/storage/messaging.ts openOperatorHelpConversation
      if (input.operator === true) {
        if (!operatorLinks.has(agentId)) return refused('not-the-operator')
        // The provenance pair, flattened: at most one of the two is set, so a
        // single key orders the threads. The empty string is the plain thread,
        // which is a subject of its own rather than the absence of one.
        const subject = input.taskId ?? input.wishId ?? ''
        const existing = [...conversations.values()].find(
          (row) =>
            row.participants.some((p) => p.party === 'operator-human') &&
            row.participants.some((p) => p.agentId === agentId) &&
            (row.operatorSubject ?? '') === subject,
        )
        const row =
          existing ??
          (() => {
            const conversationId = id()
            const opened: ConversationRow = {
              id: conversationId,
              createdAt: now(),
              participants: [
                {
                  id: id(),
                  agentId,
                  party: 'citizen',
                  label: handleOf.get(agentId) ?? agentId,
                },
                { id: id(), party: 'operator-human', label: 'your operator' },
              ],
              messages: [],
              ...(subject === '' ? {} : { operatorSubject: subject }),
            }
            conversations.set(conversationId, opened)
            return opened
          })()
        const me = row.participants.find((p) => p.agentId === agentId)!
        const messageId = id()
        row.messages.push({
          id: messageId,
          senderParticipantId: me.id,
          body: input.body,
          createdAt: now(),
        })
        return {
          outcome: 'delivered',
          response: {
            conversationId: row.id as ConversationId,
            messageId: messageId as MessageId,
          },
        }
      }

      const held = input.toHandle === undefined ? undefined : canonical(input.toHandle)
      if (held === undefined) return refused('no-such-citizen')
      const recipient = handles.get(held)!
      if (recipient.agentId === agentId) return refused('self')

      if (blocks.has(blockKey(recipient.agentId, agentId))) return refused('blocked')
      if (blocks.has(blockKey(agentId, recipient.agentId))) {
        return refused('sender-blocked-recipient')
      }

      const existing = sharedCitizenConversation(agentId, recipient.agentId)
      if (existing !== undefined) {
        const me = existing.participants.find((p) => p.agentId === agentId)!
        const messageId = id()
        existing.messages.push({
          id: messageId,
          senderParticipantId: me.id,
          body: input.body,
          createdAt: now(),
        })
        return {
          outcome: 'delivered',
          response: {
            conversationId: existing.id as ConversationId,
            messageId: messageId as MessageId,
          },
        }
      }

      const pending = requests.find(
        (r) =>
          r.fromAgentId === agentId && r.toAgentId === recipient.agentId && r.status === 'pending',
      )
      if (pending !== undefined) {
        const row = conversations.get(pending.conversationId)!
        const me = row.participants.find((p) => p.agentId === agentId)!
        row.messages.push({
          id: id(),
          senderParticipantId: me.id,
          body: input.body,
          createdAt: now(),
        })
        return {
          outcome: 'requested',
          response: {
            conversationId: pending.conversationId as ConversationId,
            requestId: pending.id as MessageRequestId,
          },
        }
      }

      const decided = [...requests]
        .filter((r) => r.fromAgentId === agentId && r.toAgentId === recipient.agentId)
        .at(-1)
      if (decided?.status === 'declined') return refused('request-declined')

      if (!recipient.acceptsCitizenMessages) return refused('declines-citizen-messages')

      const conversationId = id()
      const senderParticipantId = id()
      const senderHandle = handleOf.get(agentId) ?? agentId
      conversations.set(conversationId, {
        id: conversationId,
        createdAt: now(),
        participants: [{ id: senderParticipantId, agentId, party: 'citizen', label: senderHandle }],
        messages: [
          {
            id: id(),
            senderParticipantId,
            body: input.body,
            createdAt: now(),
          },
        ],
      })
      const requestId = id()
      requests.push({
        id: requestId,
        conversationId,
        fromAgentId: agentId,
        toAgentId: recipient.agentId,
        preview: input.body.slice(0, MESSAGE_REQUEST_PREVIEW_MAX_LENGTH),
        status: 'pending',
        createdAt: now(),
      })
      return {
        outcome: 'requested',
        response: {
          conversationId: conversationId as ConversationId,
          requestId: requestId as MessageRequestId,
        },
      }
    },

    async listRequests(agentId): Promise<readonly MessageRequest[]> {
      return requests
        .filter((r) => r.toAgentId === agentId)
        .map((r) => ({
          id: r.id as MessageRequestId,
          conversationId: r.conversationId as ConversationId,
          fromHandle: handleOf.get(r.fromAgentId) ?? r.fromAgentId,
          ...(r.preview === undefined ? {} : { preview: r.preview }),
          status: r.status,
          createdAt: r.createdAt,
        }))
    },

    async acceptRequest(agentId, requestId): Promise<RequestResponse> {
      const request = requests.find((r) => r.id === requestId && r.toAgentId === agentId)
      if (request === undefined) return refused('not-a-participant')
      if (request.status === 'declined') return refused('request-declined')
      if (request.status === 'accepted') {
        return {
          outcome: 'accepted',
          response: { conversationId: request.conversationId as ConversationId },
        }
      }

      const row = conversations.get(request.conversationId)
      if (row === undefined) return refused('not-a-participant')
      if (!row.participants.some((p) => p.agentId === agentId)) {
        row.participants.push({
          id: id(),
          agentId,
          party: 'citizen',
          label: handleOf.get(agentId) ?? agentId,
        })
      }
      request.status = 'accepted'
      return {
        outcome: 'accepted',
        response: { conversationId: request.conversationId as ConversationId },
      }
    },

    async declineRequest(agentId, requestId): Promise<RequestResponse> {
      const request = requests.find((r) => r.id === requestId && r.toAgentId === agentId)
      if (request === undefined) return refused('not-a-participant')
      if (request.status === 'accepted') return refused('not-a-participant')
      request.status = 'declined'
      return { outcome: 'declined', response: { declined: true } }
    },

    async markRead(agentId, conversationId, upTo): Promise<MarkReadResponse> {
      const me = participantOf(conversationId, agentId)
      if (me === undefined) return refused('not-a-participant')
      const row = conversations.get(conversationId)!
      const target =
        upTo === undefined ? row.messages.at(-1)?.id : row.messages.find((m) => m.id === upTo)?.id
      if (target !== undefined) me.lastReadMessageId = target
      return { outcome: 'marked', response: { marked: true } }
    },

    // @mirrors packages/db/src/storage/messaging.ts acknowledgeSystemMessage
    async acknowledge(agentId, messageId): Promise<AcknowledgeResponse> {
      for (const row of conversations.values()) {
        const me = row.participants.find((p) => p.agentId === agentId)
        if (me === undefined) continue
        const message = row.messages.find((m) => m.id === messageId)
        if (message === undefined) continue
        const sender = row.participants.find((p) => p.id === message.senderParticipantId)
        if (
          sender?.party !== 'system-role' ||
          message.actionRequired !== true ||
          message.acknowledgedAt !== undefined
        ) {
          return refused('nothing-to-acknowledge')
        }
        const acknowledgedAt = now()
        message.actionRequired = false
        message.acknowledgedAt = acknowledgedAt
        return { outcome: 'acknowledged', response: { acknowledgedAt } }
      }
      return refused('nothing-to-acknowledge')
    },

    // @mirrors packages/db/src/storage/messaging.ts blockSender / unblockSender / reportMessageAbuse
    async protect(agentId, input: MessageProtectInput): Promise<ProtectResponse> {
      const held = canonical(input.handle)
      if (held === undefined) return refused('no-such-citizen')
      const subject = handles.get(held)!
      if (subject.agentId === agentId) return refused('self')

      if (input.act === 'block') {
        blocks.add(blockKey(agentId, subject.agentId))
        for (const request of requests) {
          if (
            request.toAgentId === agentId &&
            request.fromAgentId === subject.agentId &&
            request.status === 'pending'
          ) {
            request.status = 'declined'
          }
        }
        return { outcome: 'blocked', response: { blocked: true } }
      }
      if (input.act === 'unblock') {
        blocks.delete(blockKey(agentId, subject.agentId))
        return { outcome: 'unblocked', response: { unblocked: true } }
      }

      if (input.messageId !== undefined) {
        let found = false
        for (const row of conversations.values()) {
          if (!row.participants.some((p) => p.agentId === agentId)) continue
          if (row.messages.some((m) => m.id === input.messageId)) {
            found = true
            break
          }
        }
        if (!found) return refused('not-a-participant')
      } else if (input.conversationId !== undefined) {
        if (participantOf(input.conversationId, agentId) === undefined) {
          return refused('not-a-participant')
        }
      }

      const reportId = id()
      reports.push({
        id: reportId,
        reporterId: agentId,
        reportedId: subject.agentId,
        reason: input.reason,
      })
      return { outcome: 'reported', response: { reported: true, reportId } }
    },
  }
}

export interface FakeOperatorMessaging extends OperatorMessaging {
  /** Confirm the relationship this port refuses to write without. */
  readonly link: (humanId: string, agentId: string) => void
  /** End it. The thread stays and stops taking words, which is `#1288`'s choice. */
  readonly unlink: (humanId: string, agentId: string) => void
  /**
   * A thread a citizen opened, empty (`#1319`).
   *
   * The console never opens a second one — a citizen asking about a second
   * subject does. This is how a test gets the state a person actually arrives
   * at: more than one thread, each about something, and an answer that has to
   * name which of them it answers.
   */
  readonly thread: (humanId: string, agentId: string) => string
}

/**
 * The operator's own direction, in memory (`#1288`).
 *
 * Reproduces the three things `apps/api` decides on that path: the write is
 * refused without a confirmed relationship **and after one is removed**, an
 * answer landing in the thread it names rather than the first one (`#1319`),
 * and a person reads only the threads they
 * are in. What the database decides — the CHECK that stops a citizen row
 * claiming `operator-human` — stays in `packages/db/src/storage/messaging.test.ts`,
 * where a fake asserting it would be asserting a copy of the schema.
 */
export function fakeOperatorMessaging(): FakeOperatorMessaging {
  const links = new Set<string>()
  const threads: {
    id: string
    humanId: string
    agentId: string
    createdAt: string
    messages: Message[]
  }[] = []

  let seq = 0
  const id = () => {
    seq += 1
    return `00000000-0000-4000-b000-${seq.toString(16).padStart(12, '0')}`
  }
  const now = () => new Date().toISOString()
  const linkKey = (humanId: string, agentId: string) => `${humanId}>${agentId}`
  const asConversation = (thread: (typeof threads)[number]): Conversation => ({
    about: null,
    shares: [],
    id: thread.id as ConversationId,
    kind: 'operator-human',
    participants: [
      {
        participantId:
          `${thread.id}-operator` as Conversation['participants'][number]['participantId'],
        party: 'operator-human',
        label: 'your operator',
      },
    ],
    createdAt: thread.createdAt,
    ...(thread.messages.at(-1) === undefined
      ? {}
      : { lastMessageAt: thread.messages.at(-1)!.createdAt }),
    unread: 0,
  })

  return {
    link(humanId, agentId) {
      links.add(linkKey(humanId, agentId))
    },
    unlink(humanId, agentId) {
      links.delete(linkKey(humanId, agentId))
    },
    thread(humanId, agentId) {
      const opened = { id: id(), humanId, agentId, createdAt: now(), messages: [] as Message[] }
      threads.push(opened)
      return opened.id
    },

    async listThreads(humanId, agentId) {
      return threads
        .filter((thread) => thread.humanId === humanId)
        .filter((thread) => agentId === undefined || thread.agentId === agentId)
        .map(asConversation)
    },

    async getThread(humanId, conversationId): Promise<ThreadResponse> {
      const thread = threads.find((one) => one.id === conversationId && one.humanId === humanId)
      if (thread === undefined) {
        return { outcome: 'refused', error: messageRefusals['not-a-participant'] }
      }
      return { outcome: 'read', response: { messages: thread.messages } }
    },

    // @mirrors packages/db/src/storage/messaging.ts sendOperatorMessage
    async send(humanId, agentId, input): Promise<SendResponse> {
      /**
       * A declaration carries the Colony's own sentence (`#1093`, `#1319`).
       *
       * Which is why the credential check runs on free text only: there is no
       * body to inspect when the person pressed one of the three controls, and
       * the words that go out were written here rather than typed.
       */
      const body = input.body ?? (input.answerKind && OPERATOR_ANSWER_BODIES[input.answerKind])
      if (body === undefined || body === '') {
        return {
          outcome: 'refused',
          error: { code: 'validation_failed', message: 'Nothing to send.' },
        }
      }
      // @mirrors packages/db/src/storage/messaging.ts carriesACredential
      if (input.body !== undefined && looksLikeCredential(input.body)) {
        return { outcome: 'refused', error: messageRefusals['credential-shaped-body'] }
      }

      if (!links.has(linkKey(humanId, agentId))) {
        return { outcome: 'refused', error: messageRefusals['not-the-operator'] }
      }

      const named =
        input.conversationId === undefined
          ? undefined
          : threads.find(
              (thread) =>
                thread.id === input.conversationId &&
                thread.humanId === humanId &&
                thread.agentId === agentId,
            )
      if (input.conversationId !== undefined && named === undefined) {
        return { outcome: 'refused', error: messageRefusals['not-a-participant'] }
      }
      const existing =
        named ?? threads.find((thread) => thread.humanId === humanId && thread.agentId === agentId)
      const thread =
        existing ??
        (() => {
          const opened = {
            id: id(),
            humanId,
            agentId,
            createdAt: now(),
            messages: [] as Message[],
          }
          threads.push(opened)
          return opened
        })()

      const messageId = id()
      thread.messages.push({
        id: messageId as MessageId,
        conversationId: thread.id as ConversationId,
        sender: {
          participantId: `${thread.id}-operator` as Message['sender']['participantId'],
          party: 'operator-human',
          label: 'your operator',
        },
        body,
        createdAt: now(),
        ...(input.answerKind === undefined ? {} : { answerKind: input.answerKind }),
      })

      return {
        outcome: 'delivered',
        response: {
          conversationId: thread.id as ConversationId,
          messageId: messageId as MessageId,
        },
      }
    },
  }
}
