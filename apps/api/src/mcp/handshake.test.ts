import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { FAKE_CALLER_IP, fakeColony } from '../__fixtures__/colony/index.js'
import { connectedClient } from '../__fixtures__/mcp.js'
import { fakeWakeup } from '../__fixtures__/wakeup.js'
import { createMcpServer } from '../mcp.js'
import { LIST_IS_STALE } from './text/wakeup.js'

/**
 * The handshake and the behaviour agree (`#386`).
 *
 * **That agreement is the whole issue**, and it is why this file exists at all.
 * The defect was never the missing notification: it was that the server
 * advertised `listChanged` and no code anywhere sent one, and nothing was in a
 * position to notice. A capability nobody asserts is a capability that drifts
 * back the next time the SDK changes what it derives.
 */

/** The `initialize` result, as a client actually receives it. */
const handshakeOf = async (credential?: string): Promise<Record<string, unknown>> => {
  const server = createMcpServer(fakeColony(), credential)
  const client = new Client({ name: 'test', version: '0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  const capabilities = client.getServerCapabilities() as Record<string, unknown>
  await Promise.all([client.close(), server.close()])

  return capabilities
}

describe('what the handshake promises', () => {
  it('does not claim listChanged, because nothing sends it', async () => {
    for (const credential of [undefined, 'Bearer anything']) {
      const capabilities = await handshakeOf(credential)
      const tools = capabilities['tools'] as Record<string, unknown> | undefined

      // The tools capability itself is still advertised — the server does serve
      // tools. What is gone is the promise about being told when they change.
      expect(tools, String(credential)).toBeDefined()
      expect(tools).not.toHaveProperty('listChanged')
    }
  })

  /**
   * **The rejection case, and it is about the source of the flag.** The SDK sets
   * `listChanged` because tools are registered, so this is not a value anybody
   * typed and it will come back the moment the pruning is removed. Asserting the
   * raw capability object rather than a convenience getter is what makes that
   * detectable.
   */
  it('still advertises that it serves tools at all', async () => {
    const capabilities = await handshakeOf('Bearer anything')
    expect(Object.keys(capabilities)).toContain('tools')
  })
})

describe('what a citizen is told instead', () => {
  const digestFor = async (changes: {
    skillsGranted?: string[]
    rolesGranted?: string[]
    rolesRevoked?: string[]
  }): Promise<string> => {
    const wakeup = fakeWakeup()
    wakeup.answersChanges(changes as never)
    const colony = { ...fakeColony(), wakeup }

    const { apiKey } = await (async () => {
      const registered = await colony.registry.register(
        { name: 'canary', platform: 'openclaw' },
        { ip: FAKE_CALLER_IP },
      )
      if (registered.outcome !== 'registered') throw new Error('fixture failed to register')
      return { apiKey: registered.response.credentials.apiKey }
    })()

    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
    const result = await client.callTool({ name: 'kolonie.wakeup', arguments: {} })
    await close()

    return JSON.stringify(result.content)
  }

  it('says the list is stale on the lines that moved the tier', async () => {
    // The sentence has to say the two things a citizen needs: that what it holds
    // predates the change, and what to do about it.
    expect(LIST_IS_STALE).toMatch(/built before this/)
    expect(LIST_IS_STALE).toMatch(/reconnect/)

    expect(await digestFor({ skillsGranted: ['browser'] })).toContain('reconnect to see what it')
    expect(await digestFor({ rolesGranted: ['tester'] })).toContain('reconnect to see what it')
    expect(await digestFor({ rolesRevoked: ['tester'] })).toContain('reconnect to see what it')
  })

  /**
   * **The rejection case.** A digest whose tier did not move must not carry it.
   * A signal appended to everything means nothing, which is the failure the
   * advertised notification already had.
   */
  it('is absent from a digest that moved no tier', async () => {
    expect(await digestFor({})).not.toContain('reconnect to see what it')
  })
})
