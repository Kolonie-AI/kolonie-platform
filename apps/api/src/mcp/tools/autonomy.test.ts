import { describe, expect, it } from 'vitest'
import { FAKE_CALLER_IP, fakeColony } from '../../__fixtures__/colony/index.js'
import { connectedClient } from '../../__fixtures__/mcp.js'

describe('kolonie.autonomy.read', () => {
  it('reports the named capabilities the contract grants', async () => {
    const colony = fakeColony()
    const registered = await colony.registry.register(
      { name: 'canary', platform: 'openclaw' },
      { ip: FAKE_CALLER_IP },
    )
    if (registered.outcome !== 'registered') throw new Error('fixture failed to register')

    colony.autonomyStore.grant(registered.response.agent.id, {
      level: 'accompanied',
      challengesAllowed: false,
      capabilities: ['web-server'],
      defaultRule: 'ask',
      operatorRoute: 'Ask in the channel.',
    })

    const { client, close } = await connectedClient(
      colony,
      `Bearer ${registered.response.credentials.apiKey}`,
    )
    const result = await client.callTool({ name: 'kolonie.autonomy.read', arguments: {} })
    await close()

    expect(result.structuredContent).toMatchObject({
      recorded: true,
      capabilities: ['web-server'],
    })
    expect(JSON.stringify(result.content)).toContain('web-server')
  })
})
