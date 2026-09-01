import {
  AgentOperatorDelegationIdSchema,
  type AgentId,
  type AgentOperatorDelegation,
} from '@kolonie-ai/core'
import type { AgentOperatorDelegations } from '../agent-operator-delegations.js'

/** In-memory lifecycle rows for MCP integration tests. */
export interface FakeAgentOperatorDelegations extends AgentOperatorDelegations {
  citizen(handle: string, agentId: AgentId): void
}

export function fakeAgentOperatorDelegations(): FakeAgentOperatorDelegations {
  const citizens = new Map<string, AgentId>()
  const rows: AgentOperatorDelegation[] = []
  const now = () => new Date().toISOString()

  return {
    citizen: (handle, agentId) => citizens.set(handle.toLowerCase(), agentId),
    async request({ operatorAgentId, subjectHandle, capabilities }) {
      const subjectAgentId = citizens.get(subjectHandle.toLowerCase())
      if (subjectAgentId === undefined) return { outcome: 'not-found' }
      if (subjectAgentId === operatorAgentId) return { outcome: 'self-delegation' }
      const existing = rows.find(
        (row) =>
          row.operatorAgentId === operatorAgentId &&
          row.subjectAgentId === subjectAgentId &&
          row.status !== 'revoked',
      )
      if (existing !== undefined) {
        return {
          outcome:
            JSON.stringify(existing.capabilities) === JSON.stringify(capabilities)
              ? 'already-pending'
              : 'capability-conflict',
          delegation: existing,
        }
      }
      const delegation: AgentOperatorDelegation = {
        id: AgentOperatorDelegationIdSchema.parse(crypto.randomUUID()),
        operatorAgentId,
        subjectAgentId,
        capabilities: [...capabilities],
        status: 'pending',
        requestedAt: now(),
        acceptedAt: null,
        revokedAt: null,
        revokedByAgentId: null,
      }
      rows.push(delegation)
      return { outcome: 'created', delegation }
    },
    async accept(delegationId, actorAgentId) {
      const row = rows.find((one) => one.id === delegationId)
      if (row === undefined) return { outcome: 'not-found' }
      if (row.subjectAgentId !== actorAgentId) return { outcome: 'wrong-actor' }
      if (row.status !== 'pending') return { outcome: 'not-pending' }
      const accepted: AgentOperatorDelegation = { ...row, status: 'active', acceptedAt: now() }
      rows[rows.indexOf(row)] = accepted
      return { outcome: 'accepted', delegation: accepted }
    },
    async revoke(delegationId, actorAgentId) {
      const row = rows.find((one) => one.id === delegationId)
      if (row === undefined) return { outcome: 'not-found' }
      if (row.operatorAgentId !== actorAgentId && row.subjectAgentId !== actorAgentId) {
        return { outcome: 'wrong-actor' }
      }
      if (row.status === 'revoked') return { outcome: 'already-revoked', delegation: row }
      const revoked: AgentOperatorDelegation = {
        ...row,
        status: 'revoked',
        revokedAt: now(),
        revokedByAgentId: actorAgentId,
      }
      rows[rows.indexOf(row)] = revoked
      return { outcome: 'revoked', delegation: revoked }
    },
    async list(agentId, statuses = ['pending', 'active']) {
      return rows.filter(
        (row) =>
          (row.operatorAgentId === agentId || row.subjectAgentId === agentId) &&
          statuses.includes(row.status),
      )
    },
  }
}
