import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AgentIdSchema, AgentOperatorDelegationIdSchema, type AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agents } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import {
  acceptAgentOperatorDelegation,
  requestAgentOperatorDelegation,
  revokeAgentOperatorDelegation,
} from './operator-agent-delegations.js'
import { authorizeAgentOperatorDelegation } from './agent-operator-authorization.js'

const target = databaseTestTarget()
const OPERATOR = AgentIdSchema.parse('3f1e0a4e-6d2b-4c3a-9f5e-1a2b3c4d5e6f')
const SUBJECT = AgentIdSchema.parse('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
const OTHER = AgentIdSchema.parse('99999999-aaaa-4bbb-8ccc-dddddddddddd')

const addAgent = (id: AgentId, name: string) => ({
  id,
  name,
  platform: 'other' as const,
  type: 'citizen' as const,
  status: 'citizen' as const,
})

describe('agent operator authorization seam', () => {
  let db: Database

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
    await db
      .insert(agents)
      .values([
        addAgent(OPERATOR, 'operator'),
        addAgent(SUBJECT, 'subject'),
        addAgent(OTHER, 'other'),
      ])
  })

  it('authorizes the authenticated operator and resolves the subject from the delegation', async () => {
    const requested = await requestAgentOperatorDelegation(db, {
      operatorAgentId: OPERATOR,
      subjectAgentId: SUBJECT,
      capabilities: ['workplace-write'],
    })
    if (!('delegation' in requested)) throw new Error('expected delegation')
    await acceptAgentOperatorDelegation(db, requested.delegation.id, SUBJECT)

    expect(
      await authorizeAgentOperatorDelegation(db, {
        operatorAgentId: OPERATOR,
        delegationId: requested.delegation.id,
        capability: 'workplace-write',
      }),
    ).toEqual({
      outcome: 'authorized',
      actorAgentId: OPERATOR,
      subjectAgentId: SUBJECT,
      delegationId: requested.delegation.id,
      capabilities: ['workplace-write'],
    })
  })

  it('rejects missing, pending, revoked, wrong-actor and missing-capability cases with stable outcomes', async () => {
    const unknown = AgentOperatorDelegationIdSchema.parse('11111111-2222-4333-8444-555555555555')
    expect(
      await authorizeAgentOperatorDelegation(db, {
        operatorAgentId: OPERATOR,
        delegationId: unknown,
        capability: 'message',
      }),
    ).toEqual({ outcome: 'not-found' })

    const requested = await requestAgentOperatorDelegation(db, {
      operatorAgentId: OPERATOR,
      subjectAgentId: SUBJECT,
      capabilities: ['message'],
    })
    if (!('delegation' in requested)) throw new Error('expected delegation')
    const ask = {
      operatorAgentId: OPERATOR,
      delegationId: requested.delegation.id,
      capability: 'message' as const,
    }
    expect(await authorizeAgentOperatorDelegation(db, ask)).toEqual({ outcome: 'pending' })
    expect(await authorizeAgentOperatorDelegation(db, { ...ask, operatorAgentId: OTHER })).toEqual({
      outcome: 'wrong-actor',
    })

    await acceptAgentOperatorDelegation(db, requested.delegation.id, SUBJECT)
    expect(await authorizeAgentOperatorDelegation(db, { ...ask, capability: 'handover' })).toEqual({
      outcome: 'missing-capability',
    })

    const revoked = await revokeAgentOperatorDelegation(db, requested.delegation.id, SUBJECT)
    expect(revoked.outcome).toBe('revoked')
    expect(await authorizeAgentOperatorDelegation(db, ask)).toEqual({ outcome: 'revoked' })
  })
})
