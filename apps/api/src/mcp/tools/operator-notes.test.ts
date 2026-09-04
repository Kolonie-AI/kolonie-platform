import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { fakeColony } from '../../__fixtures__/colony/index.js'
import { connectedClient } from '../../__fixtures__/mcp.js'

const FAKE_CALLER_IP = '203.0.113.7'

const RETIRED_TOOLS = [
  'kolonie.accounts.handover',
  'kolonie.operator.drop.open',
  'kolonie.operator.notes',
  'kolonie.operator.drops',
  'kolonie.operator.drop.read',
] as const

const REPLACEMENT_TOOLS = [
  'kolonie.vault.share',
  'kolonie.vault.unshare',
  'kolonie.vault.list',
  'kolonie.vault.set',
  'kolonie.messages.list_threads',
  'kolonie.messages.get_thread',
  'kolonie.messages.send',
] as const

describe('the retired operator channels (#1686)', () => {
  it('omits every retired name and preserves every replacement', async () => {
    const colony = fakeColony()
    const registered = await colony.registry.register(
      { name: `retired-${randomUUID().slice(0, 8)}`, platform: 'openclaw' },
      { ip: FAKE_CALLER_IP },
    )
    if (registered.outcome !== 'registered') throw new Error('fixture failed to register')

    const { client, close } = await connectedClient(
      colony,
      `Bearer ${registered.response.credentials.apiKey}`,
    )
    const { tools } = await client.listTools()
    await close()

    const names = tools.map((tool) => tool.name)
    for (const retired of RETIRED_TOOLS) expect(names).not.toContain(retired)
    for (const replacement of REPLACEMENT_TOOLS) expect(names).toContain(replacement)
  })
})
