import type { ApiError } from '@kolonie-ai/core'
import { fakeDepositDependencies, fakeDeposits } from '../__fixtures__/deposits.js'
import { fakeQuests } from '../__fixtures__/quests.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { FAKE_CALLER_IP, fakeColony } from '../__fixtures__/colony.js'
import { anonymousClient, connectedClient } from '../__fixtures__/mcp.js'
import { fakeConsole } from '../__fixtures__/console.js'
import { fakeStore } from '../__fixtures__/store.js'
import { fakeVault } from '../__fixtures__/vault.js'
import { buildApp } from '../app.js'
import { createMcpServer, type McpDependencies } from '../mcp.js'

/**
 * A tool that throws must not hand the caller our exception (#171).
 *
 * The incident these are written against: `kolonie.academy.vision.challenge`
 * answered a citizen with `ENOENT: no such file or directory, open
 * /app/apps/packages/verifiers/assets/vision/metadata.json` — an unhandled
 * exception rendered as a tool result — while the same fault over HTTP answered
 * `internal`. Two doors, one problem, two answers, and only one of them decided.
 */
describe('a tool that throws something nobody planned for', () => {
  /** What the citizen was actually shown. Nothing of it may appear in a result. */
  const LEAKED_PATH = '/app/apps/packages/verifiers/assets/vision/metadata.json'
  const anIncident = () => new Error(`ENOENT: no such file or directory, open ${LEAKED_PATH}`)

  /** The answer the HTTP surface gives for the same fault, restated as a value. */
  const INTERNAL = { code: 'internal', message: 'Internal error.' }

  const authenticatedColony = async () => {
    const colony = fakeColony()
    const registered = await colony.registry.register(
      { name: 'ariadne', platform: 'openclaw' },
      { ip: FAKE_CALLER_IP },
    )
    if (registered.outcome !== 'registered') throw new Error('fixture failed to register')

    return { colony, apiKey: registered.response.credentials.apiKey }
  }

  /**
   * A colony whose vault listing throws. `kolonie.vault.list` is a real
   * registered tool reached through the real transport, so this exercises the
   * guard where an agent would meet it rather than by calling it directly.
   */
  const colonyWhoseVaultThrows = async (thrown: unknown = anIncident()) => {
    const { colony, apiKey } = await authenticatedColony()
    const logged: { message: string; detail: unknown }[] = []

    const deps: McpDependencies = {
      ...colony,
      vault: {
        vault: {
          ...fakeVault(),
          list: async () => {
            throw thrown
          },
        },
      },
      log: (message, detail) => logged.push({ message, detail }),
    }

    return { deps, apiKey, logged }
  }

  it('answers the same error the HTTP surface answers, in both halves of the result', async () => {
    const { deps, apiKey } = await colonyWhoseVaultThrows()
    const { client, close } = await connectedClient(deps, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.vault.list', arguments: {} })

    expect(result.isError).toBe(true)
    expect(result.structuredContent).toEqual({ error: INTERNAL })
    // The text half too: a model reads that one and a client parses the other,
    // and the whole point of `toolError` is that they say the same thing.
    expect(JSON.parse((result.content as { text: string }[])[0]?.text ?? '{}')).toEqual(INTERNAL)
    await close()
  })

  /**
   * Byte-identical, asserted against the other door rather than against a copy
   * of the literal — a test that quoted the string twice would keep passing on
   * the day the two surfaces drifted apart, which is the failure being fixed.
   */
  it('gives byte-for-byte what the same fault gives over HTTP', async () => {
    const { deps, apiKey } = await colonyWhoseVaultThrows()
    const { client, close } = await connectedClient(deps, `Bearer ${apiKey}`)

    const overMcp = await client.callTool({ name: 'kolonie.vault.list', arguments: {} })

    const store = fakeStore()
    const app = buildApp({
      ...deps,
      quests: fakeQuests(),
      deposits: fakeDepositDependencies(fakeDeposits()),
      store,
      console: fakeConsole(),
    })
    await app.ready()
    const issued = store.issue({})
    const overHttp = await app.inject({
      method: 'GET',
      url: '/v1/vault',
      headers: { authorization: `Bearer ${String(issued.apiKey)}` },
    })

    expect(overHttp.statusCode).toBe(500)
    expect(overMcp.structuredContent).toEqual({ error: overHttp.json() })
    await app.close()
    await close()
  })

  it('lets no part of the exception reach the caller', async () => {
    const { deps, apiKey } = await colonyWhoseVaultThrows()
    const { client, close } = await connectedClient(deps, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.vault.list', arguments: {} })

    // The whole response, not just the field the answer was read from: a stack
    // in a second content block leaks exactly as much as one in the first.
    const whole = JSON.stringify(result)
    expect(whole).not.toContain(LEAKED_PATH)
    expect(whole).not.toContain('ENOENT')
    expect(whole).not.toContain('/app/')
    await close()
  })

  it('keeps the detail and names the tool it came from', async () => {
    const thrown = anIncident()
    const { deps, apiKey, logged } = await colonyWhoseVaultThrows(thrown)
    const { client, close } = await connectedClient(deps, `Bearer ${apiKey}`)

    await client.callTool({ name: 'kolonie.vault.list', arguments: {} })

    expect(logged).toHaveLength(1)
    // The name, because a stack alone does not say which of forty-odd entry
    // points a citizen was standing at.
    expect(logged[0]?.message).toContain('kolonie.vault.list')
    expect(logged[0]?.detail).toBe(thrown)
    await close()
  })

  it('survives a handler that throws something that is not an Error', async () => {
    const { deps, apiKey, logged } = await colonyWhoseVaultThrows('a bare string')
    const { client, close } = await connectedClient(deps, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.vault.list', arguments: {} })

    expect(result.structuredContent).toEqual({ error: INTERNAL })
    expect(logged[0]?.detail).toBe('a bare string')
    await close()
  })

  /**
   * The guard is on the registration, so a tool added later is covered without
   * its author doing anything — which is the property that makes this a rule
   * rather than a habit. Registered here *after* `createMcpServer` returned,
   * exactly as the forty-fourth tool would be.
   */
  describe('a tool registered after the server was built', () => {
    const serverWithALateTool = async (handler: () => unknown) => {
      const logged: { message: string; detail: unknown }[] = []
      const { colony, apiKey } = await authenticatedColony()
      const server = createMcpServer(
        { ...colony, log: (m, d) => logged.push({ message: m, detail: d }) },
        `Bearer ${apiKey}`,
      )

      server.registerTool(
        'kolonie.test.late',
        { title: 'Added afterwards', description: 'For the guard test only.', inputSchema: {} },
        handler as () => never,
      )

      const client = new Client({ name: 'test', version: '0' })
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

      return { client, logged, close: () => Promise.all([client.close(), server.close()]) }
    }

    it('is guarded without its author having done anything', async () => {
      const { client, logged, close } = await serverWithALateTool(() => {
        throw anIncident()
      })

      const result = await client.callTool({ name: 'kolonie.test.late', arguments: {} })

      expect(result.isError).toBe(true)
      expect(result.structuredContent).toEqual({ error: INTERNAL })
      expect(JSON.stringify(result)).not.toContain(LEAKED_PATH)
      expect(logged[0]?.message).toContain('kolonie.test.late')
      await close()
    })

    /**
     * A handler that got partway through building an answer and then failed.
     * The half-built result is discarded rather than served: a partial answer
     * carrying a real field beside a missing one is worse than a refusal,
     * because an agent has no way to tell it is partial.
     */
    it('discards what a handler had already assembled before it failed', async () => {
      const { client, close } = await serverWithALateTool(() => {
        const content = [{ type: 'text', text: `read ${LEAKED_PATH}` }]
        void content
        throw anIncident()
      })

      const result = await client.callTool({ name: 'kolonie.test.late', arguments: {} })

      expect(result.structuredContent).toEqual({ error: INTERNAL })
      expect(JSON.stringify(result)).not.toContain(LEAKED_PATH)
      await close()
    })
  })

  /**
   * The seventy-odd `toolError` returns in `mcp.ts` are refusals the code
   * reasoned about. The guard catches only what nobody reasoned about, and a
   * guard that flattened an anticipated refusal into `internal` would have taken
   * a stable code away from every agent branching on it.
   */
  it('leaves an anticipated refusal carrying its own code and message', async () => {
    const { colony, apiKey } = await authenticatedColony()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.vault.get',
      arguments: { key: 'nothing-is-stored-here' },
    })

    expect(result.isError).toBe(true)
    const { error } = result.structuredContent as { error: ApiError }
    expect(error.code).not.toBe('internal')
    expect(error.message).not.toBe('Internal error.')
    await close()
  })

  it('leaves the credential-less tools exactly as they were', async () => {
    const { client, close } = await anonymousClient()

    const result = await client.callTool({ name: 'kolonie.about', arguments: {} })

    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toMatchObject({ name: 'Kolonie AI' })
    await close()
  })
})
