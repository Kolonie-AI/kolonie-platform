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

  /**
   * The flat published shape, and the contract moved into the handler (`#1964`).
   *
   * The root was a `z.discriminatedUnion`, which the SDK published as
   * `{"type":"object","properties":{}}` — no `act`, no arguments, nothing a
   * caller could read — and which Anthropic's tool-use API refuses outright when
   * it converts to a root `oneOf`. Flattening it is what makes the five fields
   * discoverable; these assert that both halves landed.
   */
  it('publishes one flat object with act and every branch field, and no root combinator', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
    const schema = (await client.listTools()).tools.find(
      (one) => one.name === 'kolonie.operator.agent',
    )?.inputSchema as {
      type?: unknown
      oneOf?: unknown
      allOf?: unknown
      anyOf?: unknown
      required?: readonly string[]
      properties: Record<string, { description?: string }>
    }
    await close()

    expect(schema.type).toBe('object')
    expect(schema.oneOf).toBeUndefined()
    expect(schema.allOf).toBeUndefined()
    expect(schema.anyOf).toBeUndefined()
    expect(Object.keys(schema.properties).sort()).toEqual([
      'act',
      'capabilities',
      'delegationId',
      'statuses',
      'subject',
    ])
    // `act` is the only thing every call needs; the rest is the handler's.
    expect(schema.required).toEqual(['act'])
    expect(schema.properties.subject?.description).toContain('request')
    expect(schema.properties.delegationId?.description).toContain('revoke')
  })

  it('refuses an act whose arguments are missing, naming the act and what it takes', async () => {
    const pair = await aPair()
    try {
      const noSubject = await pair.operator.client.callTool(
        tool({ act: 'request', capabilities: ['workplace-read'] }),
      )
      expect(noSubject.isError).toBe(true)
      expect(textOf(noSubject)).toContain('validation_failed')
      expect(textOf(noSubject)).toContain('subject')
      expect(textOf(noSubject)).toContain('request')

      const noDelegation = await pair.operator.client.callTool(tool({ act: 'revoke' }))
      expect(noDelegation.isError).toBe(true)
      expect(textOf(noDelegation)).toContain('delegationId')

      const noAcceptTarget = await pair.operator.client.callTool(tool({ act: 'accept' }))
      expect(noAcceptTarget.isError).toBe(true)
      expect(textOf(noAcceptTarget)).toContain('delegationId')

      // `list` is the one act that requires nothing, and still answers.
      const listed = await pair.operator.client.callTool(tool({ act: 'list' }))
      expect(listed.isError).toBeFalsy()
    } finally {
      await pair.close()
    }
  })

  it('still refuses an unknown act at the schema, which the enum keeps', async () => {
    const pair = await aPair()
    try {
      const unknownAct = await pair.operator.client.callTool(tool({ act: 'peek' }))
      expect(unknownAct.isError).toBe(true)
    } finally {
      await pair.close()
    }
  })
})
