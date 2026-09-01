import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { describe, expect, it } from 'vitest'
import { FAKE_CALLER_IP } from '../../__fixtures__/colony/index.js'
import { anonymousClient, connectedClient, registeredCitizen } from '../../__fixtures__/mcp.js'

const tool = (args: Record<string, unknown>) => ({
  name: 'kolonie.operator.agent',
  arguments: args,
})

const textOf = (result: Awaited<ReturnType<Client['callTool']>>) => JSON.stringify(result.content)

const aPair = async () => {
  const { colony, apiKey, agent } = await registeredCitizen()
  const registered = await colony.registry.register(
    { name: 'aurora', platform: 'openclaw' },
    { ip: FAKE_CALLER_IP },
  )
  if (registered.outcome !== 'registered') throw new Error('fixture failed to register')
  const subject = registered.response.agent
  const subjectKey = registered.response.credentials.apiKey
  colony.agentOperatorDelegations.citizen(agent.profile.name, agent.id)
  colony.agentOperatorDelegations.citizen(subject.profile.name, subject.id)

  const operatorClient = await connectedClient(colony, `Bearer ${apiKey}`)
  const subjectClient = await connectedClient(colony, `Bearer ${subjectKey}`)

  return {
    colony,
    operator: { agent, client: operatorClient.client, close: operatorClient.close },
    subject: { agent: subject, client: subjectClient.client, close: subjectClient.close },
    close: async () => {
      await operatorClient.close()
      await subjectClient.close()
    },
  }
}

describe('kolonie.operator.agent (#1796)', () => {
  it('is not offered to an anonymous caller', async () => {
    const { client, close } = await anonymousClient()
    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names).not.toContain('kolonie.operator.agent')
    await close()
  })

  it('is offered to an authenticated citizen with exact single tool name', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
    const tools = (await client.listTools()).tools
    const names = tools.map((t) => t.name)
    expect(names).toContain('kolonie.operator.agent')
    expect(names).not.toContain('kolonie.operator.agent.request')
    expect(names).not.toContain('kolonie.operator.agent.accept')
    expect(names).not.toContain('kolonie.operator.agent.list')
    expect(names).not.toContain('kolonie.operator.agent.revoke')
    await close()
  })

  it('covers the complete lifecycle: request -> accept -> list -> revoke', async () => {
    const pair = await aPair()
    try {
      const requested = await pair.operator.client.callTool(
        tool({
          act: 'request',
          subject: 'aurora',
          capabilities: ['workplace-read', 'workplace-write', 'message'],
        }),
      )
      expect(requested.isError).toBeFalsy()
      const reqData = requested.structuredContent as {
        outcome: string
        delegation: { id: string; status: string; capabilities: string[] }
      }
      expect(reqData.outcome).toBe('created')
      expect(reqData.delegation.status).toBe('pending')
      expect(reqData.delegation.capabilities).toEqual([
        'workplace-read',
        'workplace-write',
        'message',
      ])
      const delegationId = reqData.delegation.id

      const strangerAccept = await pair.operator.client.callTool(
        tool({ act: 'accept', delegationId }),
      )
      expect(strangerAccept.isError).toBe(true)

      const accepted = await pair.subject.client.callTool(tool({ act: 'accept', delegationId }))
      expect(accepted.isError).toBeFalsy()
      const accData = accepted.structuredContent as {
        outcome: string
        delegation: { id: string; status: string }
      }
      expect(accData.outcome).toBe('accepted')
      expect(accData.delegation.status).toBe('active')

      const listedOperator = await pair.operator.client.callTool(tool({ act: 'list' }))
      expect(listedOperator.isError).toBeFalsy()
      const listData = listedOperator.structuredContent as {
        delegations: Array<{ id: string; status: string }>
      }
      expect(listData.delegations.some((d) => d.id === delegationId && d.status === 'active')).toBe(
        true,
      )

      const revoked = await pair.operator.client.callTool(tool({ act: 'revoke', delegationId }))
      expect(revoked.isError).toBeFalsy()
      const revData = revoked.structuredContent as {
        outcome: string
        delegation: { id: string; status: string }
      }
      expect(revData.outcome).toBe('revoked')
      expect(revData.delegation.status).toBe('revoked')
    } finally {
      await pair.close()
    }
  })

  it('rejects self-delegation, unknown citizen, and invalid arguments', async () => {
    const pair = await aPair()
    try {
      const selfReq = await pair.operator.client.callTool(
        tool({
          act: 'request',
          subject: pair.operator.agent.profile.name,
          capabilities: ['workplace-read'],
        }),
      )
      expect(selfReq.isError).toBe(true)

      const unknownCitizen = await pair.operator.client.callTool(
        tool({ act: 'request', subject: 'no-such-citizen-xyz', capabilities: ['workplace-read'] }),
      )
      expect(unknownCitizen.isError).toBe(true)
      expect(textOf(unknownCitizen)).toContain('not_found')

      const invalidCap = await pair.operator.client.callTool(
        tool({ act: 'request', subject: 'aurora', capabilities: ['vault-access'] }),
      )
      expect(invalidCap.isError).toBe(true)
    } finally {
      await pair.close()
    }
  })
})
