import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { FastifyInstance } from 'fastify'
import {
  API_KEY_PREFIX,
  GetMeResponseSchema,
  RegisterAgentResponseSchema,
  type ApiKey,
} from '@kolonie-ai/core'
import { buildApp } from './app.js'
import {
  AUTHENTICATED_TOOLS,
  createMcpServer,
  MCP_PATH,
  UNAUTHENTICATED_TOOLS,
  type McpDependencies,
} from './mcp.js'
import { fakeRegistry } from './__fixtures__/registry.js'
import { fakeStore } from './__fixtures__/store.js'
import { fakeColony } from './__fixtures__/colony.js'
import { fakeCatalogue } from './__fixtures__/catalogue.js'
import { fakeSubmissions } from './__fixtures__/submissions.js'

/**
 * Drive the MCP server the way a foreign agent does — through a real client
 * speaking the real protocol, not by calling the handler directly. The tool
 * description and the input schema are part of what the agent sees, and only a
 * client round trip proves they survive registration intact.
 */
const connectedClient = async (
  deps: McpDependencies = { registry: fakeRegistry(), store: fakeStore() },
  credential?: string,
) => {
  const server = createMcpServer(deps, credential)
  const client = new Client({ name: 'test', version: '0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return { client, close: () => Promise.all([client.close(), server.close()]) }
}

/** A stranger: no credential, so only the unauthenticated tier exists. */
const anonymousClient = (registry = fakeRegistry()) =>
  connectedClient({ registry, store: fakeStore() })

describe('kolonie.register', () => {
  it('is offered to an agent that presents no credential', async () => {
    const { client, close } = await anonymousClient()

    const { tools } = await client.listTools()

    expect(tools.map((tool) => tool.name)).toContain('kolonie.register')
    await close()
  })

  it('tells the agent the key cannot be recovered — before it calls', async () => {
    const { client, close } = await anonymousClient()

    const { tools } = await client.listTools()
    const register = tools.find((tool) => tool.name === 'kolonie.register')

    // An agent decides whether to store the result from the description alone.
    // If this sentence goes missing, agents lose keys and cannot be helped.
    expect(register?.description).toMatch(/once/i)
    expect(register?.description).toMatch(/cannot recover|not recover|only as a hash/i)
    await close()
  })

  it('registers an agent and returns the same shape the HTTP endpoint does', async () => {
    const { client, close } = await anonymousClient()

    const result = await client.callTool({
      name: 'kolonie.register',
      arguments: { name: 'canary', platform: 'openclaw' },
    })

    expect(result.isError).toBeFalsy()
    expect(() => RegisterAgentResponseSchema.parse(result.structuredContent)).not.toThrow()
    await close()
  })

  it('puts the key where an agent reading text will find it', async () => {
    const { client, close } = await anonymousClient()

    const result = await client.callTool({
      name: 'kolonie.register',
      arguments: { name: 'canary', platform: 'openclaw' },
    })

    const text = JSON.stringify(result.content)
    expect(text).toContain(API_KEY_PREFIX)
    await close()
  })

  it('reports a taken name as an error carrying the same code as HTTP', async () => {
    const { client, close } = await anonymousClient()

    await client.callTool({
      name: 'kolonie.register',
      arguments: { name: 'canary', platform: 'openclaw' },
    })
    const second = await client.callTool({
      name: 'kolonie.register',
      arguments: { name: 'canary', platform: 'openclaw' },
    })

    expect(second.isError).toBe(true)
    expect(JSON.stringify(second.content)).toContain('conflict')
    await close()
  })

  it('rejects a platform outside the enum before it reaches storage', async () => {
    const registry = fakeRegistry()
    const { client, close } = await anonymousClient(registry)

    const result = await client.callTool({
      name: 'kolonie.register',
      arguments: { name: 'canary', platform: 'not-a-platform' },
    })

    expect(result.isError).toBe(true)
    expect(registry.names()).toEqual([])
    await close()
  })

  it('shares one implementation with the HTTP route — a name taken there is taken here', async () => {
    // This is the property #3 actually asks for: not that both surfaces exist,
    // but that they cannot disagree. One registry, two doors.
    const registry = fakeRegistry()
    const app = buildApp({
      registry,
      store: fakeStore(),
      catalogue: fakeCatalogue(),
      submissions: fakeSubmissions(),
    })
    await app.ready()
    await app.inject({
      method: 'POST',
      url: '/v1/agents/register',
      payload: { name: 'canary', platform: 'openclaw' },
    })

    const { client, close } = await anonymousClient(registry)
    const overMcp = await client.callTool({
      name: 'kolonie.register',
      arguments: { name: 'canary', platform: 'openclaw' },
    })

    expect(overMcp.isError).toBe(true)
    await close()
    await app.close()
  })
})

describe('the unauthenticated tier', () => {
  it('offers exactly the tools a stranger is meant to see', async () => {
    const { client, close } = await anonymousClient()

    const { tools } = await client.listTools()

    // Equality, not containment. A tool added without a decision about which
    // tier it belongs to fails here, which is the point: the front door of the
    // Colony must widen deliberately or not at all.
    expect(tools.map((tool) => tool.name).sort()).toEqual([...UNAUTHENTICATED_TOOLS].sort())
    await close()
  })

  it('does not leak the authenticated surface to a caller with no key', async () => {
    const { client, close } = await anonymousClient()

    const listing = JSON.stringify(await client.listTools())

    // Not merely absent from the names — absent from the listing altogether, so
    // no description can name a tool the caller cannot reach.
    for (const tool of AUTHENTICATED_TOOLS) expect(listing).not.toContain(tool)
    await close()
  })

  it('fails an authenticated tool called without a key', async () => {
    const { client, close } = await anonymousClient()

    // The tool is not registered at all, so the protocol itself refuses it —
    // a caller that guesses the name gets nothing but the refusal.
    const result = await client.callTool({ name: 'kolonie.me', arguments: {} })

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('not found')
    await close()
  })
})

describe('kolonie.me', () => {
  const authenticatedColony = async () => {
    const colony = fakeColony()
    const registered = await colony.registry.register({ name: 'canary', platform: 'openclaw' })
    if (registered.outcome !== 'registered') throw new Error('fixture failed to register')

    const { agent, credentials } = registered.response
    return { colony, agent, apiKey: credentials.apiKey }
  }

  it('appears once a credential is presented', async () => {
    const { colony, apiKey } = await authenticatedColony()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const { tools } = await client.listTools()

    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [...UNAUTHENTICATED_TOOLS, ...AUTHENTICATED_TOOLS].sort(),
    )
    await close()
  })

  it('answers with the same shape GET /v1/agents/me returns', async () => {
    const { colony, agent, apiKey } = await authenticatedColony()
    colony.credit(agent.id, { coins: 3, reputation: 7 })
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.me', arguments: {} })

    expect(result.isError).toBeFalsy()
    expect(() => GetMeResponseSchema.parse(result.structuredContent)).not.toThrow()
    expect(JSON.stringify(result.content)).toContain('3 coins')
    await close()
  })

  it('takes no arguments — a credential decides whose record this is', async () => {
    const { colony, apiKey } = await authenticatedColony()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const { tools } = await client.listTools()
    const tool = tools.find((candidate) => candidate.name === 'kolonie.me')

    expect(tool?.inputSchema.properties ?? {}).toEqual({})
    await close()
  })

  it('reports a key revoked mid-session as unauthorized, not as a broken Colony', async () => {
    const { colony, apiKey } = await authenticatedColony()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
    colony.revoke(apiKey)

    const result = await client.callTool({ name: 'kolonie.me', arguments: {} })

    expect(result.isError).toBe(true)
    // A stable code, so an agent can tell "my key died" from "retry later".
    expect(JSON.stringify(result.content)).toContain('unauthorized')
    await close()
  })
})

describe(`POST ${MCP_PATH}`, () => {
  let app: FastifyInstance

  afterEach(async () => {
    await app?.close()
  })

  /**
   * One JSON-RPC call over the real HTTP surface. The transport answers as an
   * SSE stream when the client accepts one, so the payload has to be dug out of
   * the frame rather than parsed off the body.
   */
  const rpc = async (
    method: string,
    params: Record<string, unknown>,
    headers: Record<string, string> = {},
  ) => {
    const response = await app.inject({
      method: 'POST',
      url: MCP_PATH,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...headers,
      },
      payload: { jsonrpc: '2.0', id: 1, method, params },
    })

    const payload = /^data: (.*)$/m.exec(response.body)?.[1]
    return {
      statusCode: response.statusCode,
      headers: response.headers,
      body: response.body,
      result:
        payload === undefined ? undefined : (JSON.parse(payload) as { result?: unknown }).result,
    }
  }

  const handshake = {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  }

  it('answers an initialize handshake over HTTP', async () => {
    app = buildApp({
      registry: fakeRegistry(),
      store: fakeStore(),
      catalogue: fakeCatalogue(),
      submissions: fakeSubmissions(),
    })
    await app.ready()

    const response = await rpc('initialize', handshake)

    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('kolonie')
  })

  it('is served unversioned — MCP negotiates its own version', async () => {
    app = buildApp({
      registry: fakeRegistry(),
      store: fakeStore(),
      catalogue: fakeCatalogue(),
      submissions: fakeSubmissions(),
    })
    await app.ready()

    const response = await app.inject({ method: 'POST', url: `/v1${MCP_PATH}` })

    expect(response.statusCode).toBe(404)
  })

  it('greets a caller carrying no credential rather than rejecting it', async () => {
    // A stranger is who this surface exists for. No key must never be a 401,
    // or an arriving agent cannot reach the tool that issues it one.
    app = buildApp({
      registry: fakeRegistry(),
      store: fakeStore(),
      catalogue: fakeCatalogue(),
      submissions: fakeSubmissions(),
    })
    await app.ready()

    const response = await rpc('initialize', handshake)

    expect(response.statusCode).toBe(200)
  })

  it('carries an agent from nothing to a credential and back in', async () => {
    // The sentence #9 is measured against: connect with nothing, register,
    // reconnect with what you were handed, and read your own standing.
    const colony = fakeColony()
    app = buildApp(colony)
    await app.ready()

    const registered = await rpc('tools/call', {
      name: 'kolonie.register',
      arguments: { name: 'canary', platform: 'openclaw' },
    })
    const { credentials } = (
      registered.result as { structuredContent: { credentials: { apiKey: ApiKey } } }
    ).structuredContent

    const standing = await rpc(
      'tools/call',
      { name: 'kolonie.me', arguments: {} },
      { authorization: `Bearer ${credentials.apiKey}` },
    )

    expect(standing.statusCode).toBe(200)
    const { structuredContent } = standing.result as { structuredContent: unknown }
    expect(() => GetMeResponseSchema.parse(structuredContent)).not.toThrow()
  })

  it('refuses a key that does not resolve, the same way /v1 does', async () => {
    app = buildApp({
      registry: fakeRegistry(),
      store: fakeStore(),
      catalogue: fakeCatalogue(),
      submissions: fakeSubmissions(),
    })
    await app.ready()

    const response = await rpc('initialize', handshake, {
      authorization: `Bearer ${API_KEY_PREFIX}${'x'.repeat(43)}`,
    })

    expect(response.statusCode).toBe(401)
    expect(response.headers['www-authenticate']).toBe('Bearer')
    expect(response.body).toContain('unauthorized')
  })

  it('refuses a revoked key before it reaches a tool', async () => {
    const colony = fakeColony()
    app = buildApp(colony)
    await app.ready()
    const registered = await colony.registry.register({ name: 'canary', platform: 'openclaw' })
    if (registered.outcome !== 'registered') throw new Error('fixture failed to register')
    colony.revoke(registered.response.credentials.apiKey)

    const response = await rpc('initialize', handshake, {
      authorization: `Bearer ${registered.response.credentials.apiKey}`,
    })

    expect(response.statusCode).toBe(401)
  })
})
