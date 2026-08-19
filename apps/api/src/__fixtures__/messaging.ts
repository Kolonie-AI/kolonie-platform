import {
  MESSAGE_BODY_MAX_LENGTH,
  MESSAGE_REQUEST_PREVIEW_MAX_LENGTH,
  type AgentId,
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
  type CitizenMessaging,
  type MarkReadResponse,
  type MessageSendInput,
  type RequestResponse,
  type SendResponse,
  type ThreadResponse,
} from '../messaging.js'

export interface FakeMessaging extends CitizenMessaging {
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
  agentId: string
  label: string
  lastReadMessageId?: string
}

type ConversationRow = {
  id: string
  createdAt: string
  participants: Participant[]
  messages: {
    id: string
    senderParticipantId: string
    body: string
    createdAt: string
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
 * Messaging, in memory (`#1286`).
 *
 * Reproduces what `apps/api` decides: request-first first contact, accept
 * promotes, decline leaves the body undelivered, blocks and the no-citizen-mail
 * preference refuse in words, and rate-limit is injectable for the MCP surface
 * test (storage does not yet rate-limit sends). Database ACL and CHECKs stay in
 * `packages/db/src/storage/messaging.test.ts`.
 */
export function fakeMessaging(): FakeMessaging {
  const handles = new Map<string, { agentId: string; acceptsCitizenMessages: boolean }>()
  const handleOf = new Map<string, string>()
  const blocks = new Set<string>()
  const conversations = new Map<string, ConversationRow>()
  const requests: RequestRow[] = []
  const rateLimited = new Map<string, number>()

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
  const refused = (refusal: keyof typeof messageRefusals) =>
    ({ outcome: 'refused' as const, error: messageRefusals[refusal] })
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
      id: row.id as ConversationId,
      participants: row.participants.map((p) => ({
        participantId: p.id as Conversation['participants'][number]['participantId'],
        party: 'citizen' as const,
        label: p.label,
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

    async listThreads(agentId) {
      return [...conversations.values()]
        .filter((row) => row.participants.some((p) => p.agentId === agentId))
        .map((row) => asConversation(row, agentId))
    },

    async getThread(agentId, conversationId): Promise<ThreadResponse> {
      const row = conversations.get(conversationId)
      const me = row === undefined ? undefined : participantOf(conversationId, agentId)
      if (me === undefined) return refused('not-a-participant')

      const messages: Message[] = row!.messages.map((m) => {
        const sender = row!.participants.find((p) => p.id === m.senderParticipantId)!
        return {
          id: m.id as MessageId,
          conversationId: row!.id as ConversationId,
          sender: {
            participantId: sender.id as Message['sender']['participantId'],
            party: 'citizen',
            label: sender.label,
          },
          body: m.body,
          createdAt: m.createdAt,
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
          r.fromAgentId === agentId &&
          r.toAgentId === recipient.agentId &&
          r.status === 'pending',
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
        participants: [
          { id: senderParticipantId, agentId, label: senderHandle },
        ],
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
        upTo === undefined
          ? row.messages.at(-1)?.id
          : row.messages.find((m) => m.id === upTo)?.id
      if (target !== undefined) me.lastReadMessageId = target
      return { outcome: 'marked', response: { marked: true } }
    },
  }
}
