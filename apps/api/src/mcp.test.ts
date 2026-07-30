import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { FastifyInstance } from 'fastify'
import {
  API_BASE_PATH,
  API_KEY_PREFIX,
  API_VERSION,
  FrontierResponseSchema,
  GetMeResponseSchema,
  ListSubmissionsResponseSchema,
  RegisterAgentResponseSchema,
  SkillSchema,
  SubmissionIdSchema,
  SubmissionSchema,
  UpdateProfileResponseSchema,
  type ApiError,
  type ApiKey,
} from '@kolonie-ai/core'
import { buildApp } from './app.js'
import { VERDICT_POLL } from './submissions.js'
import {
  AUTHENTICATED_TOOLS,
  createMcpServer,
  MCP_ALIAS_PATH,
  MCP_PATH,
  MCP_PATHS,
  UNAUTHENTICATED_TOOLS,
  type McpDependencies,
} from './mcp.js'
import { fakeRegistry } from './__fixtures__/registry.js'
import { fakeKeypair, fakeKeys } from './__fixtures__/keys.js'
import {
  FAKE_POW_DIFFICULTY,
  fakePow,
  fakePowChallenges,
  missingNonce,
  solveChallenge,
} from './__fixtures__/proof-of-work.js'
import { fakeGithub } from './__fixtures__/github.js'
import { fakeSocial } from './__fixtures__/social.js'
import { fakeStore } from './__fixtures__/store.js'
import { fakeColony, FAKE_CALLER_IP } from './__fixtures__/colony.js'
import { REGISTRATION_LIMIT } from './rate-limit.js'
import { aTask, fakeCatalogue } from './__fixtures__/catalogue.js'
import { fakeSubmissions } from './__fixtures__/submissions.js'
import { aStruggle, fakeGuidance } from './__fixtures__/guidance.js'
import { fakeAcademy } from './__fixtures__/academy.js'
import {
  FAKE_CHALLENGE_DOMAIN,
  FAKE_INBOUND_SECRET,
  fakeEmail,
  fakeEmailChallenges,
  fakeMailer,
} from './__fixtures__/email.js'

/**
 * Drive the MCP server the way a foreign agent does — through a real client
 * speaking the real protocol, not by calling the handler directly. The tool
 * description and the input schema are part of what the agent sees, and only a
 * client round trip proves they survive registration intact.
 */
const connectedClient = async (deps: McpDependencies = fakeColony(), credential?: string) => {
  const server = createMcpServer(deps, credential)
  const client = new Client({ name: 'test', version: '0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return { client, close: () => Promise.all([client.close(), server.close()]) }
}

/** A stranger: no credential, so only the unauthenticated tier exists. */
const anonymousClient = (registry = fakeRegistry()) =>
  connectedClient({
    registry,
    store: fakeStore(),
    catalogue: fakeCatalogue(),
    submissions: fakeSubmissions(),
    guidance: fakeGuidance(),
    academy: fakeAcademy(),
    email: fakeEmail(),
    keys: fakeKeys(),
    pow: fakePow(),
    github: fakeGithub(),
    social: fakeSocial(),
    caller: { ip: FAKE_CALLER_IP },
  })

describe('kolonie.about', () => {
  it('is offered to an agent that presents no credential', async () => {
    const { client, close } = await anonymousClient()

    const { tools } = await client.listTools()

    expect(tools.map((tool) => tool.name)).toContain('kolonie.about')
    await close()
  })

  it('answers with structure, not prose — the reader is deciding what to do next', async () => {
    const { client, close } = await anonymousClient()

    const result = await client.callTool({ name: 'kolonie.about', arguments: {} })

    expect(result.isError).toBeFalsy()
    // Every field #15 lists, asserted by name. A response that drops one still
    // reads fine to a human and leaves an agent unable to work out its next move.
    expect(result.structuredContent).toMatchObject({
      name: 'Kolonie AI',
      description: expect.any(String),
      version: API_VERSION,
      capabilities: expect.any(Array),
      registration: { tool: 'kolonie.register', endpoint: `${API_BASE_PATH}/agents/register` },
      docs: expect.any(String),
    })
    await close()
  })

  it('tells a stranger how to register without being asked a second question', async () => {
    const { client, close } = await anonymousClient()

    const result = await client.callTool({ name: 'kolonie.about', arguments: {} })

    // The text half, because a model reads that one. Both halves are generated
    // from the same constant, so this also proves they have not drifted.
    const text = JSON.stringify(result.content)
    expect(text).toContain('kolonie.register')
    expect(text).toMatch(/once/i)
    await close()
  })

  it('names no authenticated tool anywhere in its answer', async () => {
    const { client, close } = await anonymousClient()

    const result = await client.callTool({ name: 'kolonie.about', arguments: {} })

    // The one response every stranger is guaranteed to read. A tool name that
    // leaks into it invites a call that can only fail, and does so in the place
    // an arriving agent trusts most.
    const whole = JSON.stringify(result)
    for (const tool of AUTHENTICATED_TOOLS) expect(whole).not.toContain(tool)
    await close()
  })

  it('says the same thing twice — a cached answer stays correct', async () => {
    const { client, close } = await anonymousClient()

    const first = await client.callTool({ name: 'kolonie.about', arguments: {} })
    const second = await client.callTool({ name: 'kolonie.about', arguments: {} })

    // Byte equality, not shape equality. #15 asks for determinism because this
    // result will be cached and diffed; a timestamp or a live count added here
    // would pass a looser assertion and break that promise silently.
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
    await close()
  })
})

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
      email: fakeEmail(),
      registry,
      store: fakeStore(),
      catalogue: fakeCatalogue(),
      submissions: fakeSubmissions(),
      guidance: fakeGuidance(),
      academy: fakeAcademy(),
      keys: fakeKeys(),
      pow: fakePow(),
      github: fakeGithub(),
      social: fakeSocial(),
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
    const registered = await colony.registry.register(
      { name: 'canary', platform: 'openclaw' },
      { ip: FAKE_CALLER_IP },
    )
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

  /**
   * The struggle list is the one place a runtime breakdown decides what an agent
   * should do next, and a model reads the prose rather than the structured half.
   * So the breakdown has to be *in* the prose — otherwise an agent acts on
   * "forty agents hit this" when the truth is "forty OpenClaw agents hit this",
   * which is a fact about its runtime and not about the task.
   */
  it('puts the runtime breakdown in the text a model reads', async () => {
    const { colony, apiKey } = await authenticatedColony()
    colony.guidance.answersStruggles([
      aStruggle({ confirmations: 47, platforms: { openclaw: 45, claude: 2 } }),
    ])
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.tasks.struggles',
      arguments: { taskId: randomUUID() },
    })

    const text = JSON.stringify(result.content)
    expect(text).toContain('47 agents')
    expect(text).toContain('openclaw 45')
    expect(text).toContain('claude 2')
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

describe('kolonie.profile.update', () => {
  /**
   * Register through the Colony fixture, so the key handed back is the key that
   * authenticates and the profile written here is the profile read back there.
   * Two unrelated fakes could prove a round trip that never happened.
   */
  const citizen = async (profile: Record<string, unknown> = {}) => {
    const colony = fakeColony()
    const registered = await colony.registry.register(
      {
        name: 'canary',
        platform: 'openclaw',
        ...profile,
      },
      { ip: FAKE_CALLER_IP },
    )
    if (registered.outcome !== 'registered') throw new Error('fixture failed to register')

    return { colony, apiKey: registered.response.credentials.apiKey }
  }

  it('appears only once a credential is presented', async () => {
    const { colony, apiKey } = await citizen()
    const stranger = await connectedClient(colony)
    const member = await connectedClient(colony, `Bearer ${apiKey}`)

    const anonymous = (await stranger.client.listTools()).tools.map((tool) => tool.name)
    const authenticated = (await member.client.listTools()).tools.map((tool) => tool.name)

    expect(anonymous).not.toContain('kolonie.profile.update')
    expect(authenticated).toContain('kolonie.profile.update')
    await Promise.all([stranger.close(), member.close()])
  })

  it('sets capabilities, and kolonie.me reads back what was set', async () => {
    const { colony, apiKey } = await citizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const updated = await client.callTool({
      name: 'kolonie.profile.update',
      arguments: { capabilities: ['typescript', 'research'] },
    })
    const standing = await client.callTool({ name: 'kolonie.me', arguments: {} })

    expect(updated.isError).toBeFalsy()
    expect(() => UpdateProfileResponseSchema.parse(updated.structuredContent)).not.toThrow()
    // The point of the round trip: one write, visible to the other tool. This is
    // also the mechanism behind Academy Level 0, whose verifier reads the
    // profile rather than any payload (D-018).
    const { agent } = GetMeResponseSchema.parse(standing.structuredContent)
    expect(agent.profile.capabilities).toEqual(['typescript', 'research'])
    await close()
  })

  it('leaves a field it was not sent alone', async () => {
    const { colony, apiKey } = await citizen({ operator: 'Gregor Sprint' })
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    await client.callTool({
      name: 'kolonie.profile.update',
      arguments: { capabilities: ['typescript'] },
    })
    const standing = await client.callTool({ name: 'kolonie.me', arguments: {} })

    // PATCH semantics, all the way down (D-017). An agent updating one field
    // must not have to resend the rest to keep it.
    const { agent } = GetMeResponseSchema.parse(standing.structuredContent)
    expect(agent.profile.operator).toBe('Gregor Sprint')
    await close()
  })

  it('clears a nullable field when it is sent an explicit null', async () => {
    const { colony, apiKey } = await citizen({ operator: 'Gregor Sprint' })
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    await client.callTool({ name: 'kolonie.profile.update', arguments: { operator: null } })
    const standing = await client.callTool({ name: 'kolonie.me', arguments: {} })

    // The other half of PATCH, and the reason the schema distinguishes absent
    // from null. An agent that becomes self-operated has no other way to say so.
    const { agent } = GetMeResponseSchema.parse(standing.structuredContent)
    expect(agent.profile.operator).toBeNull()
    await close()
  })

  it('refuses a rename rather than ignoring it', async () => {
    const { colony, apiKey } = await citizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.profile.update',
      arguments: { name: 'someone-else' },
    })
    const standing = await client.callTool({ name: 'kolonie.me', arguments: {} })

    expect(result.isError).toBe(true)
    // Distinguishable, and it names the field. "Validation failed" alone would
    // send an agent hunting for a formatting mistake in a body that was formed
    // perfectly well.
    const error = JSON.stringify(result.content)
    expect(error).toContain('validation_failed')
    expect(error).toContain('name')
    const { agent } = GetMeResponseSchema.parse(standing.structuredContent)
    expect(agent.profile.name).toBe('canary')
    await close()
  })

  it('refuses a platform change the same way', async () => {
    const { colony, apiKey } = await citizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.profile.update',
      arguments: { platform: 'claude' },
    })

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('platform')
    await close()
  })

  it('cannot be called without a key — the tool is not there to call', async () => {
    const { client, close } = await anonymousClient()

    const result = await client.callTool({
      name: 'kolonie.profile.update',
      arguments: { capabilities: ['typescript'] },
    })

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('not found')
    await close()
  })

  it('stops writing the moment a key is revoked, mid-session', async () => {
    const { colony, apiKey } = await citizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
    colony.revoke(apiKey)

    const result = await client.callTool({
      name: 'kolonie.profile.update',
      arguments: { capabilities: ['typescript'] },
    })

    // A read served from a stale handshake is a stale read; a write served from
    // one is a revoked citizen editing the Colony's records. Hence the second
    // resolve inside the handler.
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('unauthorized')
    await close()
  })

  it('shares one implementation with PATCH /v1/agents/me', async () => {
    const colony = fakeColony()
    const app = buildApp(colony)
    await app.ready()
    const registered = await colony.registry.register(
      { name: 'canary', platform: 'openclaw' },
      { ip: FAKE_CALLER_IP },
    )
    if (registered.outcome !== 'registered') throw new Error('fixture failed to register')
    const { apiKey } = registered.response.credentials

    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
    await client.callTool({
      name: 'kolonie.profile.update',
      arguments: { capabilities: ['typescript'] },
    })
    const overHttp = await app.inject({
      method: 'GET',
      url: '/v1/agents/me',
      headers: { authorization: `Bearer ${apiKey}` },
    })

    // The property #17 asks for: not that both surfaces exist, but that a write
    // through one is a fact for the other. One code path, two doors.
    const { agent } = GetMeResponseSchema.parse(overHttp.json())
    expect(agent.profile.capabilities).toEqual(['typescript'])
    await close()
    await app.close()
  })
})

/**
 * A citizen with the key it was actually issued, from one Colony both surfaces
 * read. Two unrelated fakes could prove a round trip that never happened.
 */
const registeredCitizen = async () => {
  const colony = fakeColony()
  const registered = await colony.registry.register(
    { name: 'canary', platform: 'openclaw' },
    { ip: FAKE_CALLER_IP },
  )
  if (registered.outcome !== 'registered') throw new Error('fixture failed to register')

  const { agent, credentials } = registered.response
  return { colony, agent, apiKey: credentials.apiKey }
}

describe('kolonie.tasks.list', () => {
  it('gates the list on the caller’s own skills, whatever the caller sends', async () => {
    const { colony, apiKey, agent } = await registeredCitizen()
    const catalogue = fakeCatalogue()
    const { client, close } = await connectedClient({ ...colony, catalogue }, `Bearer ${apiKey}`)

    // A subject in the arguments is stripped by the input schema rather than
    // honoured: there is no such parameter, on purpose.
    await client.callTool({
      name: 'kolonie.tasks.list',
      arguments: { agentId: randomUUID(), skills: ['builder'] },
    })

    // The subject comes from the credential, exactly as `GET /v1/tasks` takes it
    // — the difference between a filter and a permission (D-014, D-030).
    expect(catalogue.lastQuery()?.agentId).toBe(agent.id)
    await close()
  })

  it('carries each task’s instructions in the text, not only in the structure', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const catalogue = fakeCatalogue()
    const task = aTask({ instructions: 'Set at least one capability on your profile.' })
    catalogue.answers({ outcome: 'listed', page: { items: [task], nextCursor: null } })
    const { client, close } = await connectedClient({ ...colony, catalogue }, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.tasks.list', arguments: {} })

    // A model reads the text half. An agent that has to make a second call to
    // find out what a task wants will guess instead.
    const text = JSON.stringify(result.content)
    expect(text).toContain('Set at least one capability on your profile.')
    expect(text).toContain(String(task.id))
    expect(text).toContain('kolonie.tasks.submit')
    expect(result.structuredContent).toMatchObject({ items: [{ id: task.id }], nextCursor: null })
    await close()
  })

  describe('where the agent already stands', () => {
    it('tells an agent waiting on a verdict to wait rather than resubmit', async () => {
      const { colony, apiKey } = await registeredCitizen()
      const catalogue = fakeCatalogue()
      const task = aTask({
        submission: {
          id: SubmissionIdSchema.parse(randomUUID()),
          status: 'pending',
          attempt: 1,
          submittedAt: new Date().toISOString(),
          verifiedAt: null,
        },
      })
      catalogue.answers({ outcome: 'listed', page: { items: [task], nextCursor: null } })
      const { client, close } = await connectedClient({ ...colony, catalogue }, `Bearer ${apiKey}`)

      const result = await client.callTool({ name: 'kolonie.tasks.list', arguments: {} })

      // The one mistake this line exists to prevent. A model handed the bare
      // word "pending" has to know the Colony's lifecycle to act on it, and the
      // wrong guess costs the agent an attempt and the Colony a verification.
      const text = JSON.stringify(result.content)
      expect(text).toContain('with the verifier')
      expect(text).toContain('rather than submitting again')
      await close()
    })

    it('tells an agent whose attempt failed that a retry is open, and which attempt it would be', async () => {
      const { colony, apiKey } = await registeredCitizen()
      const catalogue = fakeCatalogue()
      const now = new Date().toISOString()
      const task = aTask({
        submission: {
          id: SubmissionIdSchema.parse(randomUUID()),
          status: 'failed',
          attempt: 2,
          submittedAt: now,
          verifiedAt: now,
        },
      })
      catalogue.answers({ outcome: 'listed', page: { items: [task], nextCursor: null } })
      const { client, close } = await connectedClient({ ...colony, catalogue }, `Bearer ${apiKey}`)

      const result = await client.callTool({ name: 'kolonie.tasks.list', arguments: {} })

      const text = JSON.stringify(result.content)
      expect(text).toContain('attempt 2 failed')
      expect(text).toContain('attempt 3')
      await close()
    })

    /**
     * The overwhelmingly common row. A line repeated on every task of every page
     * is one a model learns to skip, and it would take the two above with it.
     */
    it('says nothing at all about a task never submitted to', async () => {
      const { colony, apiKey } = await registeredCitizen()
      const catalogue = fakeCatalogue()
      catalogue.answers({
        outcome: 'listed',
        page: { items: [aTask({ submission: null })], nextCursor: null },
      })
      const { client, close } = await connectedClient({ ...colony, catalogue }, `Bearer ${apiKey}`)

      const result = await client.callTool({ name: 'kolonie.tasks.list', arguments: {} })

      expect(JSON.stringify(result.content)).not.toContain('you:')
      await close()
    })

    it('carries the submission in the structured half as well as the text', async () => {
      const { colony, apiKey } = await registeredCitizen()
      const catalogue = fakeCatalogue()
      const submissionId = SubmissionIdSchema.parse(randomUUID())
      const task = aTask({
        submission: {
          id: submissionId,
          status: 'pending',
          attempt: 1,
          submittedAt: new Date().toISOString(),
          verifiedAt: null,
        },
      })
      catalogue.answers({ outcome: 'listed', page: { items: [task], nextCursor: null } })
      const { client, close } = await connectedClient({ ...colony, catalogue }, `Bearer ${apiKey}`)

      const result = await client.callTool({ name: 'kolonie.tasks.list', arguments: {} })

      expect(result.structuredContent).toMatchObject({
        items: [{ id: task.id, submission: { id: submissionId, status: 'pending', attempt: 1 } }],
      })
      await close()
    })
  })

  it('says an empty list means wait, not that the Colony is broken', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.tasks.list', arguments: {} })

    expect(result.isError).toBeFalsy()
    // A rung whose verifier cannot decide stays invisible. An agent told only
    // "0 tasks" concludes it has finished the Academy.
    expect(JSON.stringify(result.content)).toContain('not a refusal')
    await close()
  })

  it('points at the frontier when there is nothing to start', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.tasks.list', arguments: {} })

    // The list is narrow on purpose (D-014), so the empty case has to name the
    // call that explains it — otherwise a graph model is strictly worse than
    // the ladder, where the next step was implied by a number.
    expect(JSON.stringify(result.content)).toContain('kolonie.tasks.frontier')
    await close()
  })

  it('shows what each task requires and grants, so no second call is needed', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const catalogue = fakeCatalogue()
    const task = aTask({ requires: [SkillSchema.parse('profile')], grants: [] })
    catalogue.answers({ outcome: 'listed', page: { items: [task], nextCursor: null } })
    const { client, close } = await connectedClient({ ...colony, catalogue }, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.tasks.list', arguments: {} })

    const text = JSON.stringify(result.content)
    expect(text).toContain('requires profile')
    // A badge says so rather than looking like a rung an agent is waiting on.
    expect(text).toContain('grants nothing')
    await close()
  })

  it('rejects a cursor it never issued in the same vocabulary the endpoint uses', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const catalogue = fakeCatalogue()
    catalogue.answers({ outcome: 'invalid-cursor' })
    const { client, close } = await connectedClient({ ...colony, catalogue }, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.tasks.list',
      arguments: { cursor: 'not-a-cursor' },
    })

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('validation_failed')
    await close()
  })
})

describe('kolonie.tasks.submit', () => {
  it('defaults the payload, so the mistake that failed Level 0 cannot be made', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const submissions = fakeSubmissions()
    const task = aTask()
    const { client, close } = await connectedClient({ ...colony, submissions }, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.tasks.submit',
      arguments: { taskId: task.id },
    })

    // Every task text said "submit with an empty payload ({})" until 2026-07-28,
    // which is a 422 against an endpoint that wants {"payload": {}}. A named
    // argument that defaults has no envelope to get wrong.
    expect(result.isError).toBeFalsy()
    expect(submissions.lastCommand()).toMatchObject({ taskId: task.id, payload: {} })
    await close()
  })

  it('takes the agent from the credential — there is nowhere to put someone else’s', async () => {
    const { colony, agent, apiKey } = await registeredCitizen()
    const submissions = fakeSubmissions()
    const { client, close } = await connectedClient({ ...colony, submissions }, `Bearer ${apiKey}`)

    const { tools } = await client.listTools()
    await client.callTool({
      name: 'kolonie.tasks.submit',
      arguments: { taskId: aTask().id, payload: {} },
    })

    const tool = tools.find((candidate) => candidate.name === 'kolonie.tasks.submit')
    // `report` joined them with #56, and it is in this list rather than only in
    // its own test because the assertion is *what an agent may send* — a field
    // appearing here that the domain does not take is exactly what this catches.
    expect(Object.keys(tool?.inputSchema.properties ?? {}).sort()).toEqual([
      'assistance',
      'payload',
      'report',
      'taskId',
    ])
    expect(submissions.lastCommand()?.agentId).toBe(agent.id)
    await close()
  })

  /**
   * The declaration over MCP (`#39`). The HTTP half is in
   * `routes/submissions.test.ts`, and both surfaces have to take it: a field
   * only one door accepts makes the count `ROADMAP.md` rests on partial by
   * surface rather than by agent.
   */
  it('passes a declared assistance through, and tells the model what it recorded', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const submissions = fakeSubmissions()
    const { client, close } = await connectedClient({ ...colony, submissions }, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.tasks.submit',
      arguments: { taskId: aTask().id, assistance: 'operator-provided' },
    })

    expect(submissions.lastCommand()?.assistance).toBe('operator-provided')
    // In the text as well as the structure: a model that cannot see what was
    // recorded cannot correct it on the next attempt.
    expect(JSON.stringify(result.content)).toContain('operator-provided')
    await close()
  })

  it('records unknown when the agent declares nothing, never none', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const submissions = fakeSubmissions()
    const { client, close } = await connectedClient({ ...colony, submissions }, `Bearer ${apiKey}`)

    await client.callTool({ name: 'kolonie.tasks.submit', arguments: { taskId: aTask().id } })

    // The tool leaves the field out entirely rather than sending `unknown`
    // itself, so what silence means is decided in core and in the column —
    // one place, not three.
    expect(submissions.lastCommand()?.assistance).toBe('unknown')
    await close()
  })

  it('refuses an assisted submission where the task refuses one, with the stable code', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const submissions = fakeSubmissions()
    submissions.answers({ outcome: 'assistance-refused', declared: 'operator-performed' })
    const { client, close } = await connectedClient({ ...colony, submissions }, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.tasks.submit',
      arguments: { taskId: aTask().id, assistance: 'operator-performed' },
    })

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('assistance_refused')
    await close()
  })

  it('tells an agent that declaring honestly costs no more than silence', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const { tools } = await client.listTools()
    const tool = tools.find((candidate) => candidate.name === 'kolonie.tasks.submit')

    // The one thing this field must not do is read as a confession. An agent
    // that worked alone and did not know it could say so is the case that
    // poisons the number.
    const described = JSON.stringify(tool)
    expect(described).toContain('not held against you')
    // Escaped, because this is JSON: the quotes around `none` are the tool's,
    // not the assertion's.
    expect(described).toContain('only \\"none\\" earns the full reward')
    await close()
  })

  it('sends the agent to kolonie.me for the verdict rather than to a path', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.tasks.submit',
      arguments: { taskId: aTask().id },
    })

    // Verification is asynchronous (D-005). An agent that is not told where the
    // answer appears invents a polling loop, and every skill invents a different one.
    const text = JSON.stringify(result.content)
    expect(text).toContain('kolonie.me')
    expect(text).toContain(String(VERDICT_POLL.afterSeconds))
    await close()
  })

  it('names a refusal an agent can branch on', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const submissions = fakeSubmissions()
    submissions.answers({ outcome: 'missing-skills', missing: [SkillSchema.parse('browser')] })
    const { client, close } = await connectedClient({ ...colony, submissions }, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.tasks.submit',
      arguments: { taskId: aTask().id },
    })

    expect(result.isError).toBe(true)
    // The same stable code the endpoint sends, so "wait" and "never" stay
    // distinguishable on both surfaces.
    expect(JSON.stringify(result.content)).toContain('level_locked')
    await close()
  })
})

describe('kolonie.submissions.list', () => {
  it('is not offered to an anonymous caller', async () => {
    const { client, close } = await anonymousClient()

    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).not.toContain('kolonie.submissions.list')
    await close()
  })

  it('appears once a credential is presented', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toContain('kolonie.submissions.list')
    await close()
  })

  it('returns an empty list when the agent has not submitted anything yet', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const submissions = fakeSubmissions()
    submissions.setList([])
    const { client, close } = await connectedClient({ ...colony, submissions }, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.submissions.list', arguments: {} })

    expect(result.isError).toBeFalsy()
    const structured = ListSubmissionsResponseSchema.parse(result.structuredContent)
    expect(structured.submissions).toEqual([])
    // The text tells the agent what to do next, not just that the list is empty.
    const text = JSON.stringify(result.content)
    expect(text).toContain('not submitted')
    await close()
  })

  it('returns submissions with their statuses', async () => {
    const { colony, apiKey, agent } = await registeredCitizen()
    const submissions = fakeSubmissions()
    submissions.setList([
      SubmissionSchema.parse({
        id: randomUUID(),
        taskId: randomUUID(),
        agentId: agent.id,
        payload: {},
        status: 'passed',
        attempt: 1,
        assistance: 'unknown',
        report: null,
        reportOutcome: null,
        submittedAt: '2026-07-29T08:00:00.000Z',
        verifiedAt: '2026-07-29T09:00:00.000Z',
      }),
      SubmissionSchema.parse({
        id: randomUUID(),
        taskId: randomUUID(),
        agentId: agent.id,
        payload: {},
        status: 'failed',
        attempt: 1,
        assistance: 'unknown',
        report: null,
        reportOutcome: null,
        submittedAt: '2026-07-29T10:00:00.000Z',
        verifiedAt: '2026-07-29T11:00:00.000Z',
      }),
      SubmissionSchema.parse({
        id: randomUUID(),
        taskId: randomUUID(),
        agentId: agent.id,
        payload: {},
        status: 'pending',
        attempt: 1,
        assistance: 'unknown',
        report: null,
        reportOutcome: null,
        submittedAt: '2026-07-29T12:00:00.000Z',
        verifiedAt: null,
      }),
    ])
    const { client, close } = await connectedClient({ ...colony, submissions }, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.submissions.list', arguments: {} })

    expect(result.isError).toBeFalsy()
    const structured = ListSubmissionsResponseSchema.parse(result.structuredContent)
    expect(structured.submissions).toHaveLength(3)
    // The text names each status, so a model can tell the agent what to do.
    const text = JSON.stringify(result.content)
    expect(text).toContain('passed')
    expect(text).toContain('failed')
    expect(text).toContain('pending')
    await close()
  })

  it('suggests retrying when a submission has failed', async () => {
    const { colony, apiKey, agent } = await registeredCitizen()
    const submissions = fakeSubmissions()
    submissions.setList([
      SubmissionSchema.parse({
        id: randomUUID(),
        taskId: randomUUID(),
        agentId: agent.id,
        payload: {},
        status: 'failed',
        attempt: 1,
        assistance: 'unknown',
        report: null,
        reportOutcome: null,
        submittedAt: '2026-07-29T10:00:00.000Z',
        verifiedAt: '2026-07-29T11:00:00.000Z',
      }),
    ])
    const { client, close } = await connectedClient({ ...colony, submissions }, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.submissions.list', arguments: {} })

    const text = JSON.stringify(result.content)
    expect(text).toMatch(/retried|retry/i)
    await close()
  })

  /**
   * `#73`. **The moment a submission fails is the moment to ask**, and until this
   * landed nothing in a failed verdict mentioned that the Colony wanted to hear
   * why: production on 2026-07-30 held five failed submissions and one report.
   * This is the population with something to say, at the exact moment they know
   * it.
   *
   * The tool is named rather than described, because an agent cannot call a
   * paraphrase — and the cost is stated, because everything else an agent does
   * here is graded and it is entirely reasonable to assume complaining is too.
   */
  it('tells an agent whose submission failed that it can report what blocked it, and that it is free', async () => {
    const { colony, apiKey, agent } = await registeredCitizen()
    const submissions = fakeSubmissions()
    submissions.setList([
      SubmissionSchema.parse({
        id: randomUUID(),
        taskId: randomUUID(),
        agentId: agent.id,
        payload: {},
        status: 'failed',
        attempt: 1,
        assistance: 'unknown',
        report: null,
        reportOutcome: null,
        submittedAt: '2026-07-29T10:00:00.000Z',
        verifiedAt: '2026-07-29T11:00:00.000Z',
      }),
    ])
    const { client, close } = await connectedClient({ ...colony, submissions }, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.submissions.list', arguments: {} })

    const text = JSON.stringify(result.content)
    expect(text).toContain('kolonie.tasks.struggle.report')
    expect(text).toMatch(/no reward, no reputation and no standing/)
    await close()
  })

  /** The same invitation, at the other place a failure is about to become news. */
  it('names the reporting tool in the reply to a submission, before the verdict arrives', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.tasks.submit',
      arguments: { taskId: randomUUID() },
    })

    expect(JSON.stringify(result.content)).toContain('kolonie.tasks.struggle.report')
    await close()
  })

  /**
   * An agent that has no report of its own still learns what the tool is for from
   * the empty list, which is where an agent looks after being told the tool exists.
   */
  it('invites a report from an agent that has never filed one', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.me.struggles', arguments: {} })

    const text = JSON.stringify(result.content)
    expect(text).toContain('kolonie.tasks.struggle.report')
    expect(text).toMatch(/costs you nothing/)
    await close()
  })
})

describe('kolonie.academy.challenge', () => {
  it('hands back a URL the agent opens, bound to a challenge it did not choose', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.academy.challenge', arguments: {} })

    expect(result.isError).toBeFalsy()
    const { challengeId, url } = result.structuredContent as { challengeId: string; url: string }
    // The id is the credential the browser carries, and the API composes the URL
    // because the host is configuration (D-024, AGENTS.md §3).
    expect(url).toContain(challengeId)
    expect(JSON.stringify(result.content)).toContain(url)
    await close()
  })

  it('takes no arguments — the challenge belongs to whoever holds the key', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const { tools } = await client.listTools()
    const tool = tools.find((candidate) => candidate.name === 'kolonie.academy.challenge')

    // The only argument is *which* challenge. Whose it is comes from the
    // credential — a subject here would be an invitation to mint one for
    // somebody else.
    expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual(['kind'])
    await close()
  })

  it('describes the badge’s page rather than the rung’s when the badge is asked for', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.academy.challenge',
      arguments: { kind: 'captcha' },
    })

    const text = JSON.stringify(result.content)
    // An agent told "it works through its steps on its own" would sit waiting
    // for a page that is waiting for it, and burn a single-use challenge.
    expect(text).toContain('not asked to solve it yourself')
    expect(text).toContain('declining')
    expect(text).not.toContain('works through')
    await close()
  })

  it('tells the agent never to type its key into the page it is being sent to', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.academy.challenge', arguments: {} })

    // Sending an agent to a web page is the one moment the Colony could teach it
    // a habit that gets its credential stolen somewhere else.
    expect(JSON.stringify(result.content)).toContain('Never type your API key')
    await close()
  })

  /**
   * **This assertion was reversed on 2026-07-29, and the reversal is the point.**
   *
   * It used to require the tool to refuse when `HCAPTCHA_SITEKEY` was unset.
   * That was correct while Level 1 *was* the hCaptcha gate — and it is exactly
   * how a third party's configuration came to decide whether the Colony's own
   * promoting rung worked. `kolonie-docs#33` forbids that, so the tool now mints
   * the capability challenge and hCaptcha's absence is none of its business.
   */
  it('still mints a challenge when hCaptcha is not configured', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const academy = { ...fakeAcademy(), unavailableReason: 'HCAPTCHA_SITEKEY is not set' }
    const { client, close } = await connectedClient({ ...colony, academy }, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.academy.challenge', arguments: {} })

    expect(result.isError).toBeFalsy()
    expect(JSON.stringify(result.content)).not.toContain('HCAPTCHA_SITEKEY')
    await close()
  })

  it('refuses with the rung’s own message when the rung itself is not configured', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const academy = {
      ...fakeAcademy(),
      capabilityUnavailableReason: 'CAPABILITY_PAGE_URL not set',
    }
    const { client, close } = await connectedClient({ ...colony, academy }, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.academy.challenge', arguments: {} })

    // The rung degrades; it does not take the surface down. One message for both
    // doors, so an agent is not told two stories about one missing value.
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('CAPABILITY_PAGE_URL not set')
    await close()
  })

  it('leaves the rest of the tier working when the gate is down', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const academy = { ...fakeAcademy(), unavailableReason: 'HCAPTCHA_SITEKEY is not set' }
    const { client, close } = await connectedClient({ ...colony, academy }, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.me', arguments: {} })

    expect(result.isError).toBeFalsy()
    await close()
  })
})

describe('the MCP surface over HTTP', () => {
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
    url: string = MCP_PATH,
  ) => {
    const response = await app.inject({
      method: 'POST',
      url,
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
      email: fakeEmail(),
      registry: fakeRegistry(),
      store: fakeStore(),
      catalogue: fakeCatalogue(),
      submissions: fakeSubmissions(),
      guidance: fakeGuidance(),
      academy: fakeAcademy(),
      keys: fakeKeys(),
      pow: fakePow(),
      github: fakeGithub(),
      social: fakeSocial(),
    })
    await app.ready()

    const response = await rpc('initialize', handshake)

    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('kolonie')
  })

  it('is served unversioned — MCP negotiates its own version', async () => {
    app = buildApp({
      email: fakeEmail(),
      registry: fakeRegistry(),
      store: fakeStore(),
      catalogue: fakeCatalogue(),
      submissions: fakeSubmissions(),
      guidance: fakeGuidance(),
      academy: fakeAcademy(),
      keys: fakeKeys(),
      pow: fakePow(),
      github: fakeGithub(),
      social: fakeSocial(),
    })
    await app.ready()

    const response = await app.inject({ method: 'POST', url: `/v1${MCP_ALIAS_PATH}` })

    expect(response.statusCode).toBe(404)
  })

  /**
   * #18: the guide tells an arriving agent to point its client at the hostname
   * and write down nothing else. That was false — the server required `/mcp` and
   * answered the root with a 404 recommending `/v1/`, which leads away from MCP.
   *
   * The test is on the *documented* address rather than the implemented one, so
   * the guide and the server cannot drift apart again in silence.
   */
  it('completes the handshake at the address the agent guide documents', async () => {
    app = buildApp({
      email: fakeEmail(),
      registry: fakeRegistry(),
      store: fakeStore(),
      catalogue: fakeCatalogue(),
      submissions: fakeSubmissions(),
      guidance: fakeGuidance(),
      academy: fakeAcademy(),
      keys: fakeKeys(),
      pow: fakePow(),
      github: fakeGithub(),
      social: fakeSocial(),
    })
    await app.ready()

    const response = await rpc('initialize', handshake, {}, '/')

    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('kolonie')
  })

  it('still answers at /mcp, so a client configured before the change keeps working', async () => {
    app = buildApp({
      email: fakeEmail(),
      registry: fakeRegistry(),
      store: fakeStore(),
      catalogue: fakeCatalogue(),
      submissions: fakeSubmissions(),
      guidance: fakeGuidance(),
      academy: fakeAcademy(),
      keys: fakeKeys(),
      pow: fakePow(),
      github: fakeGithub(),
      social: fakeSocial(),
    })
    await app.ready()

    const response = await rpc('initialize', handshake, {}, MCP_ALIAS_PATH)

    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('kolonie')
  })

  it('offers the same tools whichever of its addresses is used', async () => {
    app = buildApp({
      email: fakeEmail(),
      registry: fakeRegistry(),
      store: fakeStore(),
      catalogue: fakeCatalogue(),
      submissions: fakeSubmissions(),
      guidance: fakeGuidance(),
      academy: fakeAcademy(),
      keys: fakeKeys(),
      pow: fakePow(),
      github: fakeGithub(),
      social: fakeSocial(),
    })
    await app.ready()

    // An alias that drifts into a second surface is worse than no alias: two
    // agents would be citizens of subtly different colonies.
    const listed = await Promise.all(
      MCP_PATHS.map(async (path) => {
        await rpc('initialize', handshake, {}, path)
        const tools = await rpc('tools/list', {}, {}, path)
        return (tools.result as { tools: { name: string }[] }).tools.map((tool) => tool.name).sort()
      }),
    )

    expect(new Set(listed.map((names) => names.join(','))).size).toBe(1)
  })

  it('greets a caller carrying no credential rather than rejecting it', async () => {
    // A stranger is who this surface exists for. No key must never be a 401,
    // or an arriving agent cannot reach the tool that issues it one.
    app = buildApp({
      email: fakeEmail(),
      registry: fakeRegistry(),
      store: fakeStore(),
      catalogue: fakeCatalogue(),
      submissions: fakeSubmissions(),
      guidance: fakeGuidance(),
      academy: fakeAcademy(),
      keys: fakeKeys(),
      pow: fakePow(),
      github: fakeGithub(),
      social: fakeSocial(),
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

  /**
   * One limit, two doors (#10). The registration limiter is wrapped around the
   * registry in `buildApp`, so an agent that has spent its allowance at `/v1`
   * cannot walk round to MCP and spend it again. Asserted across both surfaces
   * rather than on the limiter, because what could break is the *wiring* — a
   * second, unthrottled registry reaching the MCP tool would pass every
   * single-surface test in this file.
   */
  it('counts a registration over MCP against the same allowance as /v1', async () => {
    const CALLER = '192.0.2.10'
    app = buildApp(fakeColony())
    await app.ready()

    for (let attempt = 0; attempt < REGISTRATION_LIMIT; attempt += 1) {
      const spent = await app.inject({
        method: 'POST',
        url: '/v1/agents/register',
        headers: { 'x-forwarded-for': CALLER },
        payload: { name: `canary-${attempt}`, platform: 'openclaw' },
      })
      expect(spent.statusCode).toBe(201)
    }

    const overMcp = await rpc(
      'tools/call',
      { name: 'kolonie.register', arguments: { name: 'one-too-many', platform: 'openclaw' } },
      { 'x-forwarded-for': CALLER },
    )

    const result = overMcp.result as { isError?: boolean; structuredContent: { error: ApiError } }
    expect(result.isError).toBe(true)
    expect(result.structuredContent.error.code).toBe('rate_limited')
  })

  it('refuses a key that does not resolve, the same way /v1 does', async () => {
    app = buildApp({
      email: fakeEmail(),
      registry: fakeRegistry(),
      store: fakeStore(),
      catalogue: fakeCatalogue(),
      submissions: fakeSubmissions(),
      guidance: fakeGuidance(),
      academy: fakeAcademy(),
      keys: fakeKeys(),
      pow: fakePow(),
      github: fakeGithub(),
      social: fakeSocial(),
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
    const registered = await colony.registry.register(
      { name: 'canary', platform: 'openclaw' },
      { ip: FAKE_CALLER_IP },
    )
    if (registered.outcome !== 'registered') throw new Error('fixture failed to register')
    colony.revoke(registered.response.credentials.apiKey)

    const response = await rpc('initialize', handshake, {
      authorization: `Bearer ${registered.response.credentials.apiKey}`,
    })

    expect(response.statusCode).toBe(401)
  })
})

describe('kolonie.tasks.frontier', () => {
  it('names the missing skill and the task that grants it', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const catalogue = fakeCatalogue()
    const granting = aTask({ title: 'Prove you can drive a browser' })
    catalogue.answersFrontier({
      skills: [SkillSchema.parse('profile')],
      entries: [
        {
          task: aTask({ title: 'Obtain a mailbox', requires: [SkillSchema.parse('browser')] }),
          missingSkill: SkillSchema.parse('browser'),
          grantedBy: [{ id: granting.id, type: granting.type, title: granting.title }],
        },
      ],
    })
    const { client, close } = await connectedClient({ ...colony, catalogue }, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.tasks.frontier', arguments: {} })

    const text = JSON.stringify(result.content)
    expect(text).toContain('browser')
    expect(text).toContain('Prove you can drive a browser')
    // The id as well as the title, because the agent's next move is a submit
    // and an id it has to look up is an id it will guess at.
    expect(text).toContain(String(granting.id))
    expect(FrontierResponseSchema.parse(result.structuredContent).entries).toHaveLength(1)
    await close()
  })

  it('asks on behalf of the credential — there is no subject to send', async () => {
    const { colony, apiKey, agent } = await registeredCitizen()
    const catalogue = fakeCatalogue()
    const { client, close } = await connectedClient({ ...colony, catalogue }, `Bearer ${apiKey}`)

    await client.callTool({
      name: 'kolonie.tasks.frontier',
      arguments: { agentId: randomUUID() },
    })

    expect(catalogue.frontierQueries()).toEqual([agent.id])
    await close()
  })

  it('answers the same thing the endpoint does, from the same call', async () => {
    // D-026: a capability the REST surface has and MCP lacks is a capability
    // foreign agents do not have, because they arrive through a skill that
    // names no endpoints. One implementation, two doors.
    const { colony, apiKey } = await registeredCitizen()
    const catalogue = fakeCatalogue()
    catalogue.answersFrontier({
      skills: [SkillSchema.parse('profile')],
      entries: [
        {
          task: aTask({ title: 'Obtain a mailbox', requires: [SkillSchema.parse('browser')] }),
          missingSkill: SkillSchema.parse('browser'),
          grantedBy: [],
        },
      ],
    })

    const app = buildApp({ ...colony, catalogue })
    await app.ready()
    const overHttp = await app.inject({
      method: 'GET',
      url: '/v1/tasks/frontier',
      headers: { authorization: `Bearer ${apiKey}` },
    })
    await app.close()

    const { client, close } = await connectedClient({ ...colony, catalogue }, `Bearer ${apiKey}`)
    const overMcp = await client.callTool({ name: 'kolonie.tasks.frontier', arguments: {} })
    await close()

    expect(overMcp.structuredContent).toEqual(overHttp.json())
  })

  it('says plainly when nothing is one step away', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.tasks.frontier', arguments: {} })

    expect(result.isError).toBeFalsy()
    expect(JSON.stringify(result.content)).toContain('Nothing is one skill away')
    await close()
  })

  it('is not offered to an anonymous caller', async () => {
    const { colony } = await registeredCitizen()
    const { client, close } = await connectedClient(colony)

    const { tools } = await client.listTools()

    expect(tools.map((tool) => tool.name)).not.toContain('kolonie.tasks.frontier')
    await close()
  })
})

/**
 * The keypair rung over MCP.
 *
 * **A rung only `/v1` can reach is a rung foreign agents do not have** (D-026).
 * #28 and #38 are the same defect one rung apart — the Academy live over HTTP
 * and unreachable from the surface the `kolonie` skill is allowed to know
 * about — and this is the rung where it would hurt most: an agent that cannot
 * drive a browser has no other branch.
 */
describe('kolonie.academy.key.challenge and .sign', () => {
  it('carries an agent from nothing to a proved keypair without touching /v1', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
    const keypair = fakeKeypair()

    const minted = await client.callTool({
      name: 'kolonie.academy.key.challenge',
      arguments: {},
    })
    const nonce = (minted.structuredContent as { nonce: string }).nonce

    const signed = await client.callTool({
      name: 'kolonie.academy.key.sign',
      arguments: {
        algorithm: keypair.algorithm,
        publicKey: keypair.publicKey,
        signature: keypair.sign(nonce),
      },
    })

    expect(minted.isError).toBeFalsy()
    expect(nonce).toMatch(/^[0-9a-f]{64}$/)
    expect(signed.isError).toBeFalsy()
    expect(signed.structuredContent).toEqual({ publicKey: keypair.publicKey })
    await close()
  })

  /**
   * The text a model actually reads, rather than the structured half a client
   * parses. An agent that is about to handle key material should be told what
   * never to send in the same breath as what to send.
   */
  it('tells the model not to send a private key, in the mint and in the tool description', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const { tools } = await client.listTools()
    const minted = await client.callTool({
      name: 'kolonie.academy.key.challenge',
      arguments: {},
    })

    const tool = tools.find((candidate) => candidate.name === 'kolonie.academy.key.challenge')
    expect(tool?.description).toContain('private key is never sent')
    expect(JSON.stringify(minted.content)).toContain('never a private key')
    await close()
  })

  it('refuses a signature over a nonce the Colony never issued', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
    const keypair = fakeKeypair()

    await client.callTool({ name: 'kolonie.academy.key.challenge', arguments: {} })
    const signed = await client.callTool({
      name: 'kolonie.academy.key.sign',
      arguments: {
        algorithm: keypair.algorithm,
        publicKey: keypair.publicKey,
        signature: keypair.sign('a value of my own choosing'),
      },
    })

    expect(signed.isError).toBe(true)
    expect(JSON.stringify(signed.content)).toContain('validation_failed')
    await close()
  })

  it('is not offered to an anonymous caller', async () => {
    const { client, close } = await anonymousClient()

    const { tools } = await client.listTools()

    expect(tools.map((tool) => tool.name)).not.toContain('kolonie.academy.key.sign')
    await close()
  })
})

/**
 * The compute rung over MCP (#37).
 *
 * The one rung whose evidence the agent has to spend something to produce, and
 * the second branch open to an agent that cannot drive a browser.
 */
describe('kolonie.academy.pow.challenge and .solve', () => {
  const withPow = async () => {
    const { colony, apiKey } = await registeredCitizen()
    const challenges = fakePowChallenges()
    const { client, close } = await connectedClient(
      { ...colony, pow: { challenges, difficulty: FAKE_POW_DIFFICULTY } },
      `Bearer ${apiKey}`,
    )
    return { client, challenges, close }
  }

  it('carries an agent from nothing to a solved challenge without touching /v1', async () => {
    const { client, close } = await withPow()

    const minted = await client.callTool({
      name: 'kolonie.academy.pow.challenge',
      arguments: {},
    })
    const { input, difficulty } = minted.structuredContent as {
      input: string
      difficulty: number
    }
    const solved = await client.callTool({
      name: 'kolonie.academy.pow.solve',
      arguments: { nonce: solveChallenge(input, difficulty) },
    })

    expect(minted.isError).toBeFalsy()
    expect(difficulty).toBe(FAKE_POW_DIFFICULTY)
    expect(solved.isError).toBeFalsy()
    expect(solved.structuredContent).toMatchObject({ solved: true, input })
    await close()
  })

  /**
   * The text a model actually reads. An agent whose rules forbid clearing
   * challenges built to keep machines out has to be able to tell that this is
   * not one of those — and the distinction has to be in the tool, not only in a
   * document it may never load.
   */
  it('says in the tool itself that this is not a perceptual challenge', async () => {
    const { client, close } = await withPow()

    const { tools } = await client.listTools()
    const tool = tools.find((candidate) => candidate.name === 'kolonie.academy.pow.challenge')

    expect(tool?.description).toContain('not')
    expect(tool?.description).toContain('perceptual')
    expect(tool?.description).toMatch(/nothing pretends to be human/i)
    await close()
  })

  it('tells the model to count bits rather than hex zeros', async () => {
    const { client, close } = await withPow()

    const minted = await client.callTool({
      name: 'kolonie.academy.pow.challenge',
      arguments: {},
    })

    // The mistake an agent makes first, answered before it makes it.
    const text = JSON.stringify(minted.content)
    expect(text).toContain('BITS')
    expect(text).toMatch(/two hex zeros/i)
    await close()
  })

  it('refuses a nonce below the target and leaves the challenge open', async () => {
    const { client, close } = await withPow()

    const minted = await client.callTool({
      name: 'kolonie.academy.pow.challenge',
      arguments: {},
    })
    const { input, difficulty } = minted.structuredContent as {
      input: string
      difficulty: number
    }
    const missed = await client.callTool({
      name: 'kolonie.academy.pow.solve',
      arguments: { nonce: missingNonce(input, difficulty) },
    })
    const solved = await client.callTool({
      name: 'kolonie.academy.pow.solve',
      arguments: { nonce: solveChallenge(input, difficulty) },
    })

    expect(missed.isError).toBe(true)
    expect(JSON.stringify(missed.content)).toContain('validation_failed')
    // Nothing was spent: the challenge that refused the miss accepts the answer.
    expect(solved.isError).toBeFalsy()
    await close()
  })

  it('refuses a solution when nothing has been minted', async () => {
    const { client, close } = await withPow()

    const solved = await client.callTool({
      name: 'kolonie.academy.pow.solve',
      arguments: { nonce: '0' },
    })

    expect(solved.isError).toBe(true)
    expect(JSON.stringify(solved.content)).toContain('not_found')
    await close()
  })

  it('is not offered to an anonymous caller', async () => {
    const { client, close } = await anonymousClient()

    const { tools } = await client.listTools()
    const names = tools.map((tool) => tool.name)

    expect(names).not.toContain('kolonie.academy.pow.challenge')
    expect(names).not.toContain('kolonie.academy.pow.solve')
    await close()
  })
})

/**
 * The mailbox rung over MCP (#38).
 *
 * One Colony behind both doors, because the property under test is not that the
 * tools exist but that they cannot disagree with the routes: the rung is a round
 * trip through the mail system, and an agent that opened a challenge on one
 * surface and closed it on the other must not find two different challenges.
 *
 * The inbound step is always HTTP, on every one of these tests, and that is the
 * rung rather than a gap in the coverage: it is a Cloudflare Worker handing over
 * a mail that arrived, not an agent doing anything. What the agent touches is
 * the two tools.
 */
describe('kolonie.academy.email.challenge and .code', () => {
  const CLAIMED = 'citizen@example.org'

  /** One store, one set of email challenges, one mailer — behind both doors. */
  const bothDoors = async () => {
    const store = fakeStore()
    const mailer = fakeMailer()
    const email = fakeEmail(fakeEmailChallenges(), mailer)
    const app = buildApp({
      email,
      registry: fakeRegistry(),
      store,
      catalogue: fakeCatalogue(),
      submissions: fakeSubmissions(),
      guidance: fakeGuidance(),
      academy: fakeAcademy(),
      keys: fakeKeys(),
      pow: fakePow(),
      github: fakeGithub(),
      social: fakeSocial(),
    })
    await app.ready()

    const { apiKey } = store.issue({})
    const { client, close } = await connectedClient(
      {
        registry: fakeRegistry(),
        store,
        catalogue: fakeCatalogue(),
        submissions: fakeSubmissions(),
        guidance: fakeGuidance(),
        academy: fakeAcademy(),
        email,
        keys: fakeKeys(),
        pow: fakePow(),
        github: fakeGithub(),
        social: fakeSocial(),
        caller: { ip: FAKE_CALLER_IP },
      },
      `Bearer ${apiKey}`,
    )

    /** What the Worker does when a mail reaches the challenge address. */
    const deliver = (to: string, from = CLAIMED) =>
      app.inject({
        method: 'POST',
        url: `${API_BASE_PATH}/internal/email-inbound`,
        payload: { from, to },
        headers: { 'x-kolonie-inbound-secret': FAKE_INBOUND_SECRET },
      })

    /** The code where the agent reads it: out of the mail, not out of a response. */
    const codeFromMail = () =>
      String(mailer.sent.at(-1)?.text ?? '').match(/\b[0-9A-F]{12}\b/)?.[0] ?? ''

    return {
      app,
      client,
      apiKey: String(apiKey),
      deliver,
      codeFromMail,
      mailer,
      close: async () => {
        await close()
        await app.close()
      },
    }
  }

  it('carries an agent through the whole rung without ever calling /v1', async () => {
    const { client, deliver, codeFromMail, close } = await bothDoors()

    const opened = await client.callTool({
      name: 'kolonie.academy.email.challenge',
      arguments: { email: CLAIMED },
    })
    const { address } = opened.structuredContent as { address: string }
    await deliver(address)
    const closed = await client.callTool({
      name: 'kolonie.academy.email.code',
      arguments: { code: codeFromMail() },
    })

    expect(opened.isError).toBeFalsy()
    // The address the agent is told to write to is minted under the configured
    // domain, and the token is what makes an arriving mail attributable.
    expect(address).toMatch(new RegExp(`^[0-9a-f]+@${FAKE_CHALLENGE_DOMAIN}$`))
    expect(closed.isError).toBeFalsy()
    expect(closed.structuredContent).toEqual({ verified: true, address: CLAIMED })
    await close()
  })

  it('opens over MCP and closes over HTTP — one challenge, two doors', async () => {
    const { client, apiKey, app, deliver, codeFromMail, close } = await bothDoors()

    const opened = await client.callTool({
      name: 'kolonie.academy.email.challenge',
      arguments: { email: CLAIMED },
    })
    await deliver((opened.structuredContent as { address: string }).address)
    const closed = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/academy/email/code`,
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      payload: { code: codeFromMail() },
    })

    expect(closed.statusCode).toBe(200)
    expect(closed.json()).toEqual({ verified: true, address: CLAIMED })
    await close()
  })

  it('opens over HTTP and closes over MCP — the other way round', async () => {
    const { client, apiKey, app, deliver, codeFromMail, close } = await bothDoors()

    const opened = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/academy/email/challenges`,
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      payload: { email: CLAIMED },
    })
    await deliver(opened.json().address)
    const closed = await client.callTool({
      name: 'kolonie.academy.email.code',
      arguments: { code: codeFromMail() },
    })

    expect(closed.isError).toBeFalsy()
    expect(closed.structuredContent).toEqual({ verified: true, address: CLAIMED })
    await close()
  })

  /**
   * The rejection an agent will actually meet: it opens a challenge, sends the
   * mail, and calls back before delivery. The refusal has to say which half is
   * missing, or the agent cannot tell "wait" from "retry".
   */
  it('refuses a code when no mail has reached the Colony yet, and says so', async () => {
    const { client, close } = await bothDoors()

    await client.callTool({
      name: 'kolonie.academy.email.challenge',
      arguments: { email: CLAIMED },
    })
    const closed = await client.callTool({
      name: 'kolonie.academy.email.code',
      arguments: { code: 'ABCDEF123456' },
    })

    expect(closed.isError).toBe(true)
    const text = JSON.stringify(closed.content)
    expect(text).toContain('conflict')
    expect(text).toContain('No mail from your address has reached the Colony yet')
    await close()
  })

  /**
   * The rung degrades to two tools refusing, not to a tier that fails to build.
   * An unconfigured mailer is the Colony's problem, and an agent still holding
   * open branches elsewhere in the graph must keep them.
   */
  it('refuses when the Colony has no way to send the code, and leaves the tier standing', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(
      { ...colony, email: { ...fakeEmail(), mailer: undefined } },
      `Bearer ${apiKey}`,
    )

    const opened = await client.callTool({
      name: 'kolonie.academy.email.challenge',
      arguments: { email: CLAIMED },
    })
    const elsewhere = await client.callTool({
      name: 'kolonie.academy.key.challenge',
      arguments: {},
    })

    expect(opened.isError).toBe(true)
    expect(JSON.stringify(opened.content)).toContain('could never be completed')
    expect(elsewhere.isError).toBeFalsy()
    await close()
  })

  it('is not offered to an anonymous caller', async () => {
    const { client, close } = await anonymousClient()

    const { tools } = await client.listTools()
    const names = tools.map((tool) => tool.name)

    expect(names).not.toContain('kolonie.academy.email.challenge')
    expect(names).not.toContain('kolonie.academy.email.code')
    await close()
  })
})

/**
 * The GitHub rung over MCP.
 *
 * One tool, not two, and that is the rung rather than an omission: the artefact
 * is a gist, it arrives through `kolonie.tasks.submit` like any other result,
 * and the account is read from GitHub by the verifier. A tool that took the
 * agent's word for which account it published from would be D-018 undone.
 */
describe('kolonie.academy.github.challenge', () => {
  it('mints a nonce and tells the agent exactly what to publish', async () => {
    const { colony, agent, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const minted = await client.callTool({
      name: 'kolonie.academy.github.challenge',
      arguments: {},
    })
    const { nonce } = minted.structuredContent as { nonce: string }

    expect(minted.isError).toBeFalsy()
    expect(nonce).toMatch(/^[0-9a-f]{64}$/)

    // Both lines, in the text a model reads. An agent told only the nonce
    // publishes a gist that proves control to the Colony and to nobody else —
    // the id is what makes the claim checkable by anyone (D-031).
    const text = JSON.stringify(minted.content)
    expect(text).toContain(nonce)
    expect(text).toContain(String(agent.id))
    await close()
  })

  it('names the legitimate route for an agent that has no account', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const { tools } = await client.listTools()

    // GitHub's terms forbid automated signup and name the operator-created
    // machine account as the permitted way in. An agent that reads only "prove
    // you control an account" and has none is being invited to break them.
    const tool = tools.find((candidate) => candidate.name === 'kolonie.academy.github.challenge')
    expect(tool?.description).toContain('do not sign up')
    expect(tool?.description).toContain('machine account')
    await close()
  })

  it('is not offered to an anonymous caller', async () => {
    const { client, close } = await anonymousClient()

    const { tools } = await client.listTools()

    expect(tools.map((tool) => tool.name)).not.toContain('kolonie.academy.github.challenge')
    await close()
  })
})
