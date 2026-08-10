import type { StoredAutonomyContract } from '@kolonie-ai/core'
import { describe, expect, it } from 'vitest'
import { FAKE_CALLER_IP, fakeColony } from '../../__fixtures__/colony/index.js'
import { connectedClient } from '../../__fixtures__/mcp.js'

describe('kolonie.autonomy.read capabilities', () => {
  const read = async (contract: StoredAutonomyContract) => {
    const colony = fakeColony()
    const registered = await colony.registry.register(
      { name: 'canary', platform: 'openclaw' },
      { ip: FAKE_CALLER_IP },
    )
    if (registered.outcome !== 'registered') throw new Error('fixture failed to register')
    colony.autonomyStore.grant(registered.response.agent.id, contract)

    const { client, close } = await connectedClient(
      colony,
      `Bearer ${registered.response.credentials.apiKey}`,
    )
    const result = await client.callTool({ name: 'kolonie.autonomy.read', arguments: {} })
    await close()
    return result
  }

  const contract = (capabilities?: readonly ['web-server']): StoredAutonomyContract => ({
    level: 'accompanied',
    challengesAllowed: false,
    ...(capabilities === undefined ? {} : { capabilities: [...capabilities] }),
    defaultRule: 'ask',
    operatorRoute: 'Use the operator page.',
    recordedAt: '2026-08-10T08:00:00.000Z',
    reviewDueAt: '2027-08-10T08:00:00.000Z',
  })

  it('reports the named web-server grant as text and data', async () => {
    const result = await read(contract(['web-server']))

    expect((result.content as Array<{ text: string }>)[0]?.text).toContain(
      'Capabilities: web-server.',
    )
    expect(result.structuredContent).toMatchObject({ capabilities: ['web-server'] })
  })

  it('reports a legacy contract with no capability field as none granted', async () => {
    const result = await read(contract())

    expect((result.content as Array<{ text: string }>)[0]?.text).toContain(
      'Capabilities: none granted.',
    )
    expect(result.structuredContent).toMatchObject({ capabilities: [] })
  })
})
