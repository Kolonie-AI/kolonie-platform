import type {
  AgentId,
  AgentOperatorCapabilitySet,
  AgentOperatorDelegation,
  AgentOperatorDelegationId,
  AgentOperatorDelegationStatus,
} from '@kolonie-ai/core'
import {
  acceptAgentOperatorDelegation,
  listAgentOperatorDelegations,
  requestAgentOperatorDelegation,
  revokeAgentOperatorDelegation,
  type AgentOperatorDelegationResult,
  type Database,
} from '@kolonie-ai/db'

/**
 * The lifecycle port shared by MCP and later delegation-aware services (`#1796`).
 *
 * Names resolve to ids here rather than in the tool, keeping the MCP handler a
 * grammar adapter. The port exposes no credential and no operation outside the
 * four fixed delegation capabilities.
 */
export interface AgentOperatorDelegations {
  request(input: {
    operatorAgentId: AgentId
    subjectHandle: string
    capabilities: AgentOperatorCapabilitySet
  }): Promise<AgentOperatorDelegationResult>
  accept(
    delegationId: AgentOperatorDelegationId,
    actorAgentId: AgentId,
  ): Promise<AgentOperatorDelegationResult>
  revoke(
    delegationId: AgentOperatorDelegationId,
    actorAgentId: AgentId,
  ): Promise<AgentOperatorDelegationResult>
  list(
    agentId: AgentId,
    statuses?: readonly AgentOperatorDelegationStatus[],
  ): Promise<AgentOperatorDelegation[]>
}

/** Bind the lifecycle port to PostgreSQL while keeping the database out of MCP. */
export function databaseAgentOperatorDelegations(db: Database): AgentOperatorDelegations {
  return {
    request: async ({ operatorAgentId, subjectHandle, capabilities }) => {
      const subjectAgentId = await activeAgentIdByHandle(db, subjectHandle)
      if (subjectAgentId === null) return { outcome: 'not-found' }
      return requestAgentOperatorDelegation(db, { operatorAgentId, subjectAgentId, capabilities })
    },
    accept: (delegationId, actorAgentId) =>
      acceptAgentOperatorDelegation(db, delegationId, actorAgentId),
    revoke: (delegationId, actorAgentId) =>
      revokeAgentOperatorDelegation(db, delegationId, actorAgentId),
    list: (agentId, statuses) =>
      listAgentOperatorDelegations(db, agentId, {
        statuses: statuses ?? ['pending', 'active'],
      }),
  }
}

import { and, eq, sql } from 'drizzle-orm'
import { AgentIdSchema } from '@kolonie-ai/core'
import { agents } from '@kolonie-ai/db'

async function activeAgentIdByHandle(db: Database, handle: string): Promise<AgentId | null> {
  const [row] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(sql`lower(${agents.name}) = lower(${handle})`, eq(agents.type, 'citizen')))
    .limit(1)
  return row === undefined ? null : AgentIdSchema.parse(row.id)
}
