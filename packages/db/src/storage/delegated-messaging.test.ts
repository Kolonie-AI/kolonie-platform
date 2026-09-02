import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AgentIdSchema, type AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agents, messageConversations } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import {
  acceptAgentOperatorDelegation,
  requestAgentOperatorDelegation,
  revokeAgentOperatorDelegation,
} from './operator-agent-delegations.js'
import { readConversation } from './messaging.js'
import { delegationWakeupSummary, sendDelegatedMentorMessage } from './delegated-messaging.js'

const target = databaseTestTarget()
const OPERATOR = AgentIdSchema.parse('5d1e0a4e-6d2b-4c3a-9f5e-1a2b3c4d5e6f')
const SUBJECT = AgentIdSchema.parse('cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa')
const STRANGER = AgentIdSchema.parse('dddddddd-eeee-4fff-8aaa-bbbbbbbbbbbb')

const addAgent = (id: AgentId, name: string) => ({
  id,
  name,
  platform: 'other' as const,
  type: 'citizen' as const,
  status: 'citizen' as const,
})

const anActiveDelegation = async (db: Database) => {
  const requested = await requestAgentOperatorDelegation(db, {
    operatorAgentId: OPERATOR,
    subjectAgentId: SUBJECT,
    capabilities: ['message'],
  })
  if (!('delegation' in requested)) throw new Error('expected delegation')
  await acceptAgentOperatorDelegation(db, requested.delegation.id, SUBJECT)
  return requested.delegation.id
}

describe('delegated mentor messaging (#1798)', () => {
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
        addAgent(OPERATOR, 'assay'),
        addAgent(SUBJECT, 'aurora'),
        addAgent(STRANGER, 'nobody'),
      ])
  })

  it('delivers into a delegation-linked thread where both parties stay citizens', async () => {
    const delegationId = await anActiveDelegation(db)
    const sent = await sendDelegatedMentorMessage(db, OPERATOR, {
      delegationId,
      body: 'Picking up the card you left in review.',
    })
    if (sent.outcome !== 'delivered') throw new Error(`expected delivery, got ${sent.outcome}`)

    const read = await readConversation(db, SUBJECT, sent.conversationId)
    if (read.outcome !== 'read') throw new Error('subject should read its own mentor thread')
    expect(read.relationship).toBe('operator-agent')
    expect(read.delegationId).toBe(delegationId)
    expect(read.delegationStatus).toBe('active')
    expect(read.messages.map((one) => one.sender.party)).toEqual(['citizen'])
    expect(read.messages[0]?.body).toBe('Picking up the card you left in review.')
  })

  it('reuses that one thread rather than opening a second per message', async () => {
    const delegationId = await anActiveDelegation(db)
    const first = await sendDelegatedMentorMessage(db, OPERATOR, { delegationId, body: 'One.' })
    const second = await sendDelegatedMentorMessage(db, OPERATOR, { delegationId, body: 'Two.' })
    if (first.outcome !== 'delivered' || second.outcome !== 'delivered') {
      throw new Error('expected two deliveries')
    }
    expect(second.conversationId).toBe(first.conversationId)
  })

  it('opens exactly one thread under concurrent first sends', async () => {
    const delegationId = await anActiveDelegation(db)
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        sendDelegatedMentorMessage(db, OPERATOR, { delegationId, body: `Parallel ${index}.` }),
      ),
    )
    expect(results.every((one) => one.outcome === 'delivered')).toBe(true)
    expect(
      new Set(results.map((one) => ('conversationId' in one ? one.conversationId : null))),
    ).toEqual(
      new Set([results[0] && 'conversationId' in results[0] ? results[0].conversationId : null]),
    )
  })

  it('goes read-only for the delegation once revoked, and history survives', async () => {
    const delegationId = await anActiveDelegation(db)
    const sent = await sendDelegatedMentorMessage(db, OPERATOR, { delegationId, body: 'Before.' })
    if (sent.outcome !== 'delivered') throw new Error('expected delivery')

    await revokeAgentOperatorDelegation(db, delegationId, SUBJECT)
    const after = await sendDelegatedMentorMessage(db, OPERATOR, { delegationId, body: 'After.' })
    expect(after.outcome).toBe('revoked')

    const read = await readConversation(db, SUBJECT, sent.conversationId)
    if (read.outcome !== 'read') throw new Error('history must survive revocation')
    expect(read.delegationStatus).toBe('revoked')
    expect(read.messages).toHaveLength(1)
  })

  it('refuses a pending delegation and one the caller does not operate', async () => {
    const requested = await requestAgentOperatorDelegation(db, {
      operatorAgentId: OPERATOR,
      subjectAgentId: SUBJECT,
      capabilities: ['message'],
    })
    if (!('delegation' in requested)) throw new Error('expected delegation')

    expect(
      (
        await sendDelegatedMentorMessage(db, OPERATOR, {
          delegationId: requested.delegation.id,
          body: 'Too soon.',
        })
      ).outcome,
    ).toBe('pending')

    await acceptAgentOperatorDelegation(db, requested.delegation.id, SUBJECT)
    expect(
      (
        await sendDelegatedMentorMessage(db, STRANGER, {
          delegationId: requested.delegation.id,
          body: 'Not mine.',
        })
      ).outcome,
    ).toBe('wrong-actor')
  })

  it('refuses a delegation that does not carry message', async () => {
    const requested = await requestAgentOperatorDelegation(db, {
      operatorAgentId: OPERATOR,
      subjectAgentId: SUBJECT,
      capabilities: ['workplace-read'],
    })
    if (!('delegation' in requested)) throw new Error('expected delegation')
    await acceptAgentOperatorDelegation(db, requested.delegation.id, SUBJECT)

    expect(
      (
        await sendDelegatedMentorMessage(db, OPERATOR, {
          delegationId: requested.delegation.id,
          body: 'No grant.',
        })
      ).outcome,
    ).toBe('missing-capability')
  })

  it('rejects human-operator subject provenance on a delegated mentor thread', async () => {
    const delegationId = await anActiveDelegation(db)
    await expect(
      db.insert(messageConversations).values({ delegationId, taskId: crypto.randomUUID() }),
    ).rejects.toThrow(/Failed query/)
  })

  it('summarises standing as bounded counts and at most one action', async () => {
    const quiet = await delegationWakeupSummary(db, STRANGER)
    expect(quiet).toEqual({ operating: 0, operatedBy: 0, pendingIn: 0, pendingOut: 0 })

    const requested = await requestAgentOperatorDelegation(db, {
      operatorAgentId: OPERATOR,
      subjectAgentId: SUBJECT,
      capabilities: ['message'],
    })
    if (!('delegation' in requested)) throw new Error('expected delegation')

    const subjectSide = await delegationWakeupSummary(db, SUBJECT)
    expect(subjectSide.pendingIn).toBe(1)
    expect(subjectSide.nextAction).toEqual({ act: 'accept', delegationId: requested.delegation.id })

    const operatorSide = await delegationWakeupSummary(db, OPERATOR)
    expect(operatorSide.pendingOut).toBe(1)
    expect(operatorSide.nextAction).toBeUndefined()

    await acceptAgentOperatorDelegation(db, requested.delegation.id, SUBJECT)
    expect(await delegationWakeupSummary(db, OPERATOR)).toEqual({
      operating: 1,
      operatedBy: 0,
      pendingIn: 0,
      pendingOut: 0,
    })
  })
})
