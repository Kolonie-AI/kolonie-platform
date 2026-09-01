import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { AgentIdSchema, type AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agentOperatorDelegations, agents } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import {
  acceptAgentOperatorDelegation,
  listAgentOperatorDelegations,
  requestAgentOperatorDelegation,
  revokeAgentOperatorDelegation,
} from './operator-agent-delegations.js'

const target = databaseTestTarget()
const OPERATOR = AgentIdSchema.parse('3f1e0a4e-6d2b-4c3a-9f5e-1a2b3c4d5e6f')
const SUBJECT = AgentIdSchema.parse('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
const OTHER = AgentIdSchema.parse('99999999-aaaa-4bbb-8ccc-dddddddddddd')

const citizen = (id: AgentId, name: string): typeof agents.$inferInsert => ({
  id,
  name,
  platform: 'other',
  status: 'citizen',
  type: 'citizen',
})

describe('agent operator delegation lifecycle', () => {
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
      .values([citizen(OPERATOR, 'operator'), citizen(SUBJECT, 'subject'), citizen(OTHER, 'other')])
  })

  it('creates one pending direct request and returns an identical retry idempotently', async () => {
    const first = await requestAgentOperatorDelegation(db, {
      operatorAgentId: OPERATOR,
      subjectAgentId: SUBJECT,
      capabilities: ['workplace-read', 'message'],
    })
    const retry = await requestAgentOperatorDelegation(db, {
      operatorAgentId: OPERATOR,
      subjectAgentId: SUBJECT,
      capabilities: ['workplace-read', 'message'],
    })
    const conflict = await requestAgentOperatorDelegation(db, {
      operatorAgentId: OPERATOR,
      subjectAgentId: SUBJECT,
      capabilities: ['workplace-read'],
    })

    expect(first.outcome).toBe('created')
    if (!('delegation' in first)) throw new Error('expected delegation')
    expect(retry).toEqual({ outcome: 'already-pending', delegation: first.delegation })
    expect(conflict).toEqual({ outcome: 'capability-conflict', delegation: first.delegation })
    expect(await db.select().from(agentOperatorDelegations)).toHaveLength(1)
  })

  it('rejects self-delegation but allows an independent reciprocal request', async () => {
    expect(
      await requestAgentOperatorDelegation(db, {
        operatorAgentId: OPERATOR,
        subjectAgentId: OPERATOR,
        capabilities: ['message'],
      }),
    ).toEqual({ outcome: 'self-delegation' })

    await requestAgentOperatorDelegation(db, {
      operatorAgentId: OPERATOR,
      subjectAgentId: SUBJECT,
      capabilities: ['message'],
    })
    expect(
      (
        await requestAgentOperatorDelegation(db, {
          operatorAgentId: SUBJECT,
          subjectAgentId: OPERATOR,
          capabilities: ['message'],
        })
      ).outcome,
    ).toBe('created')
  })

  it('accepts only by the subject and activates exactly the requested capabilities', async () => {
    const requested = await requestAgentOperatorDelegation(db, {
      operatorAgentId: OPERATOR,
      subjectAgentId: SUBJECT,
      capabilities: ['workplace-write', 'handover'],
    })
    if (!('delegation' in requested)) throw new Error('expected delegation')

    expect(await acceptAgentOperatorDelegation(db, requested.delegation.id, OPERATOR)).toEqual({
      outcome: 'wrong-actor',
    })
    const accepted = await acceptAgentOperatorDelegation(db, requested.delegation.id, SUBJECT)

    expect(accepted.outcome).toBe('accepted')
    if (!('delegation' in accepted)) throw new Error('expected accepted delegation')
    expect(accepted.delegation.capabilities).toEqual(['workplace-write', 'handover'])
    expect(accepted.delegation.status).toBe('active')
  })

  it('allows either party to revoke, preserves history, and gives a later request a new id', async () => {
    const requested = await requestAgentOperatorDelegation(db, {
      operatorAgentId: OPERATOR,
      subjectAgentId: SUBJECT,
      capabilities: ['message'],
    })
    if (!('delegation' in requested)) throw new Error('expected delegation')
    await acceptAgentOperatorDelegation(db, requested.delegation.id, SUBJECT)

    expect(await revokeAgentOperatorDelegation(db, requested.delegation.id, OTHER)).toEqual({
      outcome: 'wrong-actor',
    })
    const revoked = await revokeAgentOperatorDelegation(db, requested.delegation.id, OPERATOR)
    expect(revoked.outcome).toBe('revoked')
    if (!('delegation' in revoked)) throw new Error('expected revoked delegation')
    expect(revoked.delegation.revokedByAgentId).toBe(OPERATOR)

    const replacement = await requestAgentOperatorDelegation(db, {
      operatorAgentId: OPERATOR,
      subjectAgentId: SUBJECT,
      capabilities: ['message'],
    })
    expect(replacement.outcome).toBe('created')
    if (!('delegation' in replacement)) throw new Error('expected replacement delegation')
    expect(replacement.delegation.id).not.toBe(requested.delegation.id)
    expect(await listAgentOperatorDelegations(db, OPERATOR)).toHaveLength(2)
  })

  it('has a deterministic winner under concurrent request and revoke transitions', async () => {
    const requests = await Promise.all(
      Array.from({ length: 4 }, () =>
        requestAgentOperatorDelegation(db, {
          operatorAgentId: OPERATOR,
          subjectAgentId: SUBJECT,
          capabilities: ['workplace-read'],
        }),
      ),
    )
    expect(requests.filter((result) => result.outcome === 'created')).toHaveLength(1)
    expect(
      new Set(requests.map((result) => ('delegation' in result ? result.delegation.id : null))),
    ).toHaveLength(1)

    const first = requests[0]
    const id = first && 'delegation' in first ? first.delegation.id : null
    if (!id) throw new Error('expected delegation')
    await acceptAgentOperatorDelegation(db, id, SUBJECT)
    const revocations = await Promise.all([
      revokeAgentOperatorDelegation(db, id, OPERATOR),
      revokeAgentOperatorDelegation(db, id, SUBJECT),
    ])
    expect(revocations.filter((result) => result.outcome === 'revoked')).toHaveLength(1)
    expect(revocations.filter((result) => result.outcome === 'already-revoked')).toHaveLength(1)

    const rows = await db
      .select()
      .from(agentOperatorDelegations)
      .where(eq(agentOperatorDelegations.id, id))
    expect(rows[0]?.status).toBe('revoked')
  })
})
