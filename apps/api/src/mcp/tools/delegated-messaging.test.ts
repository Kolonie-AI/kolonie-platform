import { AgentIdSchema, ConversationIdSchema, MessageIdSchema } from '@kolonie-ai/core'
import { describe, expect, it } from 'vitest'
import { FAKE_CALLER_IP } from '../../__fixtures__/colony/index.js'
import { connectedClient, registeredCitizen } from '../../__fixtures__/mcp.js'

const send = (delegationId: string, body: string) => ({
  name: 'kolonie.messages.send',
  arguments: { delegationId, body },
})

const pair = async () => {
  const { colony, apiKey, agent } = await registeredCitizen()
  const registered = await colony.registry.register(
    { name: 'aurora-mentor-subject', platform: 'openclaw' },
    { ip: FAKE_CALLER_IP },
  )
  if (registered.outcome !== 'registered') throw new Error('fixture registration failed')
  const subject = registered.response.agent
  colony.agentOperatorDelegations.citizen(agent.profile.name, agent.id)
  colony.agentOperatorDelegations.citizen(subject.profile.name, subject.id)

  const requested = await colony.agentOperatorDelegations.request({
    operatorAgentId: agent.id,
    subjectHandle: subject.profile.name,
    capabilities: ['message'],
  })
  if (!('delegation' in requested)) throw new Error('fixture delegation failed')
  await colony.agentOperatorDelegations.accept(requested.delegation.id, subject.id)

  const messages = new Map<string, { conversationId: string; bodies: string[]; actors: string[] }>()
  colony.messaging.sendDelegated = async (actor, input) => {
    const authorized = await colony.agentOperatorDelegations.authorize({
      operatorAgentId: actor,
      delegationId: input.delegationId,
      capability: 'message',
    })
    if (authorized.outcome !== 'authorized') {
      const codes = {
        'not-found': 'delegation_not_found',
        pending: 'delegation_pending',
        revoked: 'delegation_revoked',
        'wrong-actor': 'delegation_wrong_actor',
        'missing-capability': 'delegation_missing_capability',
      } as const
      return {
        outcome: 'refused',
        error: { code: codes[authorized.outcome], message: authorized.outcome },
      }
    }
    const row = messages.get(input.delegationId) ?? {
      conversationId: crypto.randomUUID(),
      bodies: [] as string[],
      actors: [] as string[],
    }
    row.bodies.push(input.body)
    row.actors.push(actor)
    messages.set(input.delegationId, row)
    return {
      outcome: 'delivered',
      response: {
        conversationId: ConversationIdSchema.parse(row.conversationId),
        messageId: MessageIdSchema.parse(crypto.randomUUID()),
      },
    }
  }

  const client = await connectedClient(colony, `Bearer ${apiKey}`)
  return { colony, agent, subject, delegationId: requested.delegation.id, client, messages }
}

describe('delegated messaging through the existing messages tool (#1798)', () => {
  it('delivers under an accepted message grant without an operator-human party argument', async () => {
    const pilot = await pair()
    const result = await pilot.client.client.callTool(
      send(pilot.delegationId, 'Review the card in progress.'),
    )
    expect(result.isError).not.toBe(true)
    expect(pilot.messages.get(pilot.delegationId)?.bodies).toEqual(['Review the card in progress.'])
    await pilot.client.close()
  })

  it('becomes read-only after revoke with a stable delegation code', async () => {
    const pilot = await pair()
    await pilot.client.client.callTool(send(pilot.delegationId, 'Before revoke.'))
    await pilot.colony.agentOperatorDelegations.revoke(pilot.delegationId, pilot.subject.id)
    const refused = await pilot.client.client.callTool(send(pilot.delegationId, 'After revoke.'))
    expect(refused.isError).toBe(true)
    expect(refused.structuredContent).toMatchObject({ error: { code: 'delegation_revoked' } })
    expect(pilot.messages.get(pilot.delegationId)?.bodies).toEqual(['Before revoke.'])
    await pilot.client.close()
  })

  it('ignores a subject or party argument rather than honouring one', async () => {
    const pilot = await pair()
    const result = await pilot.client.client.callTool({
      name: 'kolonie.messages.send',
      arguments: {
        delegationId: pilot.delegationId,
        subjectAgentId: AgentIdSchema.parse(crypto.randomUUID()),
        party: 'operator-human',
        body: 'Forged route.',
      },
    })

    expect(result.isError).not.toBe(true)
    expect(pilot.messages.get(pilot.delegationId)?.actors).toEqual([pilot.agent.id])
    await pilot.client.close()
  })
})
