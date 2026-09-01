import { and, asc, eq, or } from 'drizzle-orm'
import {
  AgentOperatorCapabilitySetSchema,
  AgentOperatorDelegationSchema,
  type AgentId,
  type AgentOperatorCapabilitySet,
  type AgentOperatorDelegation,
  type AgentOperatorDelegationId,
  type AgentOperatorDelegationStatus,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agentOperatorDelegations } from '../schema/index.js'
import { violatesConstraint } from './errors.js'

export type AgentOperatorDelegationResult =
  | {
      outcome:
        | 'created'
        | 'already-pending'
        | 'capability-conflict'
        | 'accepted'
        | 'revoked'
        | 'already-revoked'
      delegation: AgentOperatorDelegation
    }
  | { outcome: 'self-delegation' | 'not-found' | 'wrong-actor' | 'not-pending' }

export interface RequestAgentOperatorDelegation {
  operatorAgentId: AgentId
  subjectAgentId: AgentId
  capabilities: AgentOperatorCapabilitySet
}

function delegationFromRow(
  row: typeof agentOperatorDelegations.$inferSelect,
): AgentOperatorDelegation {
  return AgentOperatorDelegationSchema.parse({
    ...row,
    requestedAt: row.requestedAt.toISOString(),
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  })
}

const sameCapabilities = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((capability, index) => capability === right[index])

async function liveDelegation(
  db: Database,
  operatorAgentId: AgentId,
  subjectAgentId: AgentId,
): Promise<AgentOperatorDelegation | null> {
  const [row] = await db
    .select()
    .from(agentOperatorDelegations)
    .where(
      and(
        eq(agentOperatorDelegations.operatorAgentId, operatorAgentId),
        eq(agentOperatorDelegations.subjectAgentId, subjectAgentId),
        or(
          eq(agentOperatorDelegations.status, 'pending'),
          eq(agentOperatorDelegations.status, 'active'),
        ),
      ),
    )
    .limit(1)
  return row ? delegationFromRow(row) : null
}

/** Create one direct pending request, with a deterministic database winner under races. */
export async function requestAgentOperatorDelegation(
  db: Database,
  command: RequestAgentOperatorDelegation,
): Promise<AgentOperatorDelegationResult> {
  if (command.operatorAgentId === command.subjectAgentId) return { outcome: 'self-delegation' }
  const capabilities = AgentOperatorCapabilitySetSchema.parse(command.capabilities)

  try {
    const [row] = await db
      .insert(agentOperatorDelegations)
      .values({ ...command, capabilities, status: 'pending' })
      .returning()
    if (!row) throw new Error('delegation insert returned no row')
    return { outcome: 'created', delegation: delegationFromRow(row) }
  } catch (error) {
    if (!violatesConstraint(error, 'agent_operator_delegations_pair_live_unique')) throw error
    const existing = await liveDelegation(db, command.operatorAgentId, command.subjectAgentId)
    if (!existing) throw error
    return {
      outcome:
        existing.status === 'pending' && sameCapabilities(existing.capabilities, capabilities)
          ? 'already-pending'
          : 'capability-conflict',
      delegation: existing,
    }
  }
}

/** Atomically activate exactly the requested capabilities; only the subject may accept. */
export async function acceptAgentOperatorDelegation(
  db: Database,
  delegationId: AgentOperatorDelegationId,
  actorAgentId: AgentId,
): Promise<AgentOperatorDelegationResult> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(agentOperatorDelegations)
      .where(eq(agentOperatorDelegations.id, delegationId))
      .for('update')
    if (!row) return { outcome: 'not-found' }
    if (row.subjectAgentId !== actorAgentId) return { outcome: 'wrong-actor' }
    if (row.status !== 'pending') return { outcome: 'not-pending' }

    const [accepted] = await tx
      .update(agentOperatorDelegations)
      .set({ status: 'active', acceptedAt: new Date() })
      .where(eq(agentOperatorDelegations.id, delegationId))
      .returning()
    if (!accepted) throw new Error('delegation accept returned no row')
    return { outcome: 'accepted', delegation: delegationFromRow(accepted) }
  })
}

/** Atomically revoke by either recorded party; committed revocation is terminal. */
export async function revokeAgentOperatorDelegation(
  db: Database,
  delegationId: AgentOperatorDelegationId,
  actorAgentId: AgentId,
): Promise<AgentOperatorDelegationResult> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(agentOperatorDelegations)
      .where(eq(agentOperatorDelegations.id, delegationId))
      .for('update')
    if (!row) return { outcome: 'not-found' }
    if (row.operatorAgentId !== actorAgentId && row.subjectAgentId !== actorAgentId) {
      return { outcome: 'wrong-actor' }
    }
    if (row.status === 'revoked') {
      return { outcome: 'already-revoked', delegation: delegationFromRow(row) }
    }

    const [revoked] = await tx
      .update(agentOperatorDelegations)
      .set({ status: 'revoked', revokedAt: new Date(), revokedByAgentId: actorAgentId })
      .where(eq(agentOperatorDelegations.id, delegationId))
      .returning()
    if (!revoked) throw new Error('delegation revoke returned no row')
    return { outcome: 'revoked', delegation: delegationFromRow(revoked) }
  })
}

/** List direct rows involving one citizen, bounded and optionally status-filtered. */
export async function listAgentOperatorDelegations(
  db: Database,
  agentId: AgentId,
  options: { statuses?: readonly AgentOperatorDelegationStatus[]; limit?: number } = {},
): Promise<AgentOperatorDelegation[]> {
  const statuses = options.statuses ?? ['pending', 'active', 'revoked']
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100)
  if (statuses.length === 0) return []

  const rows = await db
    .select()
    .from(agentOperatorDelegations)
    .where(
      and(
        or(
          eq(agentOperatorDelegations.operatorAgentId, agentId),
          eq(agentOperatorDelegations.subjectAgentId, agentId),
        ),
        or(...statuses.map((status) => eq(agentOperatorDelegations.status, status))),
      ),
    )
    .orderBy(asc(agentOperatorDelegations.requestedAt), asc(agentOperatorDelegations.id))
    .limit(limit)
  return rows.map(delegationFromRow)
}
