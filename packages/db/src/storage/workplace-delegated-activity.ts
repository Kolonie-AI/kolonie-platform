import type { AgentId, AgentOperatorDelegationId } from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { workplaceActivity } from '../schema/index.js'

/**
 * Write one delegated Workplace event (`#1797`, epic `#1792`).
 *
 * **Three identities and not one.** The actor is the operator that called, the
 * subject is the citizen whose Workplace moved, and the delegation is the grant
 * that allowed it — so a later reader can answer *who did this, on whose
 * board, under what authority* from the row itself rather than by inference.
 * An ordinary act writes none of the last two, and the CHECK refuses half a
 * pair.
 */
export async function recordDelegatedWorkplaceAct(
  db: Database | Transaction,
  event: {
    readonly boardId: string
    readonly cardId?: string
    readonly actorAgentId: AgentId
    readonly subjectAgentId: AgentId
    readonly delegationId: AgentOperatorDelegationId
    readonly verb: string
    readonly payload?: Record<string, unknown>
  },
): Promise<void> {
  await db.insert(workplaceActivity).values({
    boardId: event.boardId,
    ...(event.cardId === undefined ? {} : { cardId: event.cardId }),
    actorId: event.actorAgentId,
    subjectAgentId: event.subjectAgentId,
    delegationId: event.delegationId,
    verb: event.verb,
    ...(event.payload === undefined ? {} : { payload: event.payload }),
  })
}
