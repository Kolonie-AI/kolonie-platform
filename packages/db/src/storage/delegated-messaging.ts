import { and, asc, eq, or, sql } from 'drizzle-orm'
import {
  looksLikeCredential,
  type AgentId,
  type AgentOperatorDelegationId,
  type ConversationId,
  type MessageId,
  type WakeupDelegation,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import {
  agentOperatorDelegations,
  agents,
  messageConversations,
  messageParticipants,
  messages,
} from '../schema/index.js'
import { authorizeAgentOperatorDelegation } from './agent-operator-authorization.js'

/**
 * The mentor thread two citizens share under one delegation (`#1798`, epic
 * `#1792`).
 *
 * **Both parties are `citizen`, and that is the security property.** The epic
 * refused a fourth party kind: an agent that could name itself `operator-agent`
 * is one step from a citizen that names itself `operator-human`, and the value
 * of that column is that no citizen can write it. What distinguishes this from
 * an ordinary DM is the delegation the conversation is linked to, which a
 * reader can check against the grant rather than take from a label.
 *
 * **Revocation ends new sends and nothing else.** The words already exchanged
 * belong to both citizens and stay readable to both — a revocation that erased
 * history would be deleting one party's mail to express the other's decision.
 */

export type DelegatedSendResult =
  | {
      readonly outcome: 'delivered'
      readonly conversationId: ConversationId
      readonly messageId: MessageId
    }
  | {
      readonly outcome:
        | 'not-found'
        | 'pending'
        | 'revoked'
        | 'wrong-actor'
        | 'missing-capability'
        | 'credential-shaped-body'
    }

export async function sendDelegatedMentorMessage(
  db: Database,
  operatorAgentId: AgentId,
  input: { readonly delegationId: AgentOperatorDelegationId; readonly body: string },
): Promise<DelegatedSendResult> {
  if (looksLikeCredential(input.body)) {
    return { outcome: 'credential-shaped-body' }
  }

  const authorized = await authorizeAgentOperatorDelegation(db, {
    operatorAgentId,
    delegationId: input.delegationId,
    capability: 'message',
  })
  if (authorized.outcome !== 'authorized') return { outcome: authorized.outcome }

  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(messageConversations)
      .values({ delegationId: input.delegationId })
      .onConflictDoNothing({ target: messageConversations.delegationId })
      .returning({ id: messageConversations.id })
    const [existing] =
      created === undefined
        ? await tx
            .select({ id: messageConversations.id })
            .from(messageConversations)
            .where(eq(messageConversations.delegationId, input.delegationId))
            .orderBy(asc(messageConversations.createdAt))
            .limit(1)
        : [created]

    const conversationId = existing?.id
    if (conversationId === undefined) throw new Error('opening a mentor thread returned no row')

    const handles = new Map(
      (
        await tx
          .select({ id: agents.id, name: agents.name })
          .from(agents)
          .where(sql`${agents.id} in (${authorized.actorAgentId}, ${authorized.subjectAgentId})`)
      ).map((row) => [row.id, row.name]),
    )

    const seatFor = async (agentId: AgentId): Promise<string> => {
      const [seated] = await tx
        .select({ id: messageParticipants.id })
        .from(messageParticipants)
        .where(
          and(
            eq(messageParticipants.conversationId, conversationId),
            eq(messageParticipants.agentId, agentId),
          ),
        )
        .limit(1)
      if (seated !== undefined) return seated.id

      const [opened] = await tx
        .insert(messageParticipants)
        .values({
          conversationId,
          party: 'citizen',
          agentId,
          label: handles.get(agentId) ?? 'a citizen',
        })
        .returning({ id: messageParticipants.id })
      if (opened === undefined) throw new Error('seating a mentor participant returned no row')
      return opened.id
    }

    const senderParticipantId = await seatFor(authorized.actorAgentId)
    await seatFor(authorized.subjectAgentId)

    const [written] = await tx
      .insert(messages)
      .values({
        conversationId,
        senderParticipantId,
        senderParty: 'citizen',
        senderLabel: handles.get(authorized.actorAgentId) ?? 'a citizen',
        body: input.body,
      })
      .returning({ id: messages.id })
    if (written === undefined) throw new Error('inserting a mentor message returned no row')

    return {
      outcome: 'delivered',
      conversationId: conversationId as ConversationId,
      messageId: written.id as MessageId,
    }
  })
}

/**
 * The bounded delegation standing on the waking read (`#1798`).
 *
 * Counts, and at most one act. The act is the subject's acceptance, because it
 * is the only move in this vocabulary that somebody else is waiting on — an
 * operator with an unanswered request has nothing to do but wait.
 */
export async function delegationWakeupSummary(
  db: Database,
  agentId: AgentId,
): Promise<WakeupDelegation> {
  const rows = await db
    .select({
      id: agentOperatorDelegations.id,
      operatorAgentId: agentOperatorDelegations.operatorAgentId,
      subjectAgentId: agentOperatorDelegations.subjectAgentId,
      status: agentOperatorDelegations.status,
      requestedAt: agentOperatorDelegations.requestedAt,
    })
    .from(agentOperatorDelegations)
    .where(
      and(
        or(
          eq(agentOperatorDelegations.operatorAgentId, agentId),
          eq(agentOperatorDelegations.subjectAgentId, agentId),
        ),
        or(
          eq(agentOperatorDelegations.status, 'pending'),
          eq(agentOperatorDelegations.status, 'active'),
        ),
      ),
    )
    .orderBy(asc(agentOperatorDelegations.requestedAt), asc(agentOperatorDelegations.id))

  const summary = {
    operating: rows.filter((r) => r.status === 'active' && r.operatorAgentId === agentId).length,
    operatedBy: rows.filter((r) => r.status === 'active' && r.subjectAgentId === agentId).length,
    pendingIn: rows.filter((r) => r.status === 'pending' && r.subjectAgentId === agentId).length,
    pendingOut: rows.filter((r) => r.status === 'pending' && r.operatorAgentId === agentId).length,
  }

  const waiting = rows.find((r) => r.status === 'pending' && r.subjectAgentId === agentId)
  return waiting === undefined
    ? summary
    : {
        ...summary,
        nextAction: {
          act: 'accept',
          delegationId: waiting.id as AgentOperatorDelegationId,
        },
      }
}
