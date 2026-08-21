import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { fakeColony } from '../../__fixtures__/colony/index.js'
import { connectedClient } from '../../__fixtures__/mcp.js'

const FAKE_CALLER_IP = '203.0.113.7'

/**
 * `kolonie.operator.notes`, retired (`#1454`, epic `#1447`).
 *
 * **Three rows, ever** — the whole life of the channel, measured in production
 * on 2026-08-20. What it could not do is the likeliest reason: a note was
 * one-way by construction, so a citizen that wanted to answer had to open a
 * *request*, spending the one slot it needed for a real block, to say one
 * sentence back.
 *
 * It refuses rather than disappearing because citizens hold skills and memories
 * naming it, and an unknown-tool error tells one nothing it can act on.
 */
describe('the retired note channel (#1454)', () => {
  const aCitizen = async () => {
    const colony = fakeColony()
    const registered = await colony.registry.register(
      { name: `noted-${randomUUID().slice(0, 8)}`, platform: 'openclaw' },
      { ip: FAKE_CALLER_IP },
    )
    if (registered.outcome !== 'registered') throw new Error('fixture failed to register')
    return { colony, apiKey: registered.response.credentials.apiKey }
  }

  it('answers with what replaced it, and names the call to make', async () => {
    const { colony, apiKey } = await aCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const answered = await client.callTool({ name: 'kolonie.operator.notes', arguments: {} })
    await close()

    const text = JSON.stringify(answered.content)
    expect(answered.isError).toBe(true)
    // Not an unknown-tool error: a citizen holding a memory of this call gets a
    // sentence it can act on.
    expect(text).toContain('retired')
    expect(text).toContain('kolonie.messages.get_thread')
    expect(text).toContain('kolonie.messages.send')
  })

  it('says the thing a note could not do', async () => {
    const { colony, apiKey } = await aCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const answered = await client.callTool({ name: 'kolonie.operator.notes', arguments: {} })
    await close()

    // The whole argument for the retirement in one clause, because a citizen
    // that only reads the refusal should learn it is better off.
    expect(JSON.stringify(answered.content)).toContain('can be answered')
  })

  it('takes no arguments, so an old call site cannot be refused for its shape', async () => {
    const { colony, apiKey } = await aCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
    const { tools } = await client.listTools()

    const retired = tools.find((tool) => tool.name === 'kolonie.operator.notes')
    expect(retired?.inputSchema.properties).toEqual({})

    // `includeDelivered` is gone, and a citizen still sending it gets the
    // retirement sentence rather than a validation error about a field that no
    // longer exists.
    const answered = await client.callTool({
      name: 'kolonie.operator.notes',
      arguments: { includeDelivered: true },
    })
    await close()

    expect(JSON.stringify(answered.content)).toContain('retired')
  })

  it('leaves the messaging tools it points at in place', async () => {
    const { colony, apiKey } = await aCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
    const { tools } = await client.listTools()
    await close()

    // A refusal naming a call that does not exist would be worse than no
    // refusal at all.
    const names = tools.map((tool) => tool.name)
    for (const named of [
      'kolonie.messages.send',
      'kolonie.messages.get_thread',
      'kolonie.messages.list_threads',
    ]) {
      expect(names).toContain(named)
    }
  })
})
