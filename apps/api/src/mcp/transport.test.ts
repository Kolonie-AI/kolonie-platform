import { API_KEY_PREFIX, type ApiError, type ApiKey, GetMeResponseSchema } from '@kolonie-ai/core'
import { fakeDepositDependencies, fakeDeposits } from '../__fixtures__/deposits.js'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { fakeAcademy } from '../__fixtures__/academy.js'
import { fakeAccounts } from '../__fixtures__/accounts.js'
import { fakeConsole } from '../__fixtures__/console.js'
import { fakeCatalogue } from '../__fixtures__/catalogue.js'
import { fakeQuests } from '../__fixtures__/quests.js'
import { FAKE_CALLER_IP, fakeColony } from '../__fixtures__/colony/index.js'
import { fakeDomain } from '../__fixtures__/domain.js'
import { fakeEmail } from '../__fixtures__/email.js'
import { fakeErasureDesk } from '../__fixtures__/erasure.js'
import { fakeContributions, fakeGithub } from '../__fixtures__/github.js'
import { fakeWakeup } from '../__fixtures__/wakeup.js'
import { fakeGuidance } from '../__fixtures__/guidance.js'
import { fakeImage } from '../__fixtures__/image.js'
import { fakeScene } from '../__fixtures__/scene.js'
import { fakeInjection } from '../__fixtures__/injection.js'
import { fakeKeys } from '../__fixtures__/keys.js'
import { fakePow } from '../__fixtures__/proof-of-work.js'
import { fakeRegistry } from '../__fixtures__/registry.js'
import { fakeAutonomy } from '../__fixtures__/autonomy.js'
import { fakeOperatorClaim } from '../__fixtures__/operator-claim.js'
import { fakeSocial } from '../__fixtures__/social.js'
import { fakeSolana } from '../__fixtures__/solana.js'
import { fakeStore } from '../__fixtures__/store.js'
import { fakeSubmissions } from '../__fixtures__/submissions.js'
import { fakeSupportDesk } from '../__fixtures__/support.js'
import { fakeVault } from '../__fixtures__/vault.js'
import { fakeVision } from '../__fixtures__/vision.js'
import { fakeWebsite } from '../__fixtures__/website.js'
import { buildApp } from '../app.js'
import { erasure } from '../erasure.js'
import { MCP_ALIAS_PATH, MCP_PATH, MCP_PATHS } from '../mcp.js'
import { REGISTRATION_LIMIT } from '../rate-limit.js'
import { support } from '../support.js'

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
      quests: fakeQuests(),
      deposits: fakeDepositDependencies(fakeDeposits()),
      vault: { vault: fakeVault() },
      accounts: fakeAccounts(),
      console: fakeConsole(),
      email: fakeEmail(),
      registry: fakeRegistry(),
      store: fakeStore(),
      catalogue: fakeCatalogue(),
      submissions: fakeSubmissions(),
      guidance: fakeGuidance(),
      support: support({ desk: fakeSupportDesk() }),
      erasure: erasure({ desk: fakeErasureDesk() }),
      retesting: { reset: async () => ({ outcome: 'not-a-tester' as const }) },
      academy: fakeAcademy(),
      keys: fakeKeys(),
      solana: fakeSolana(),
      pow: fakePow(),
      vision: fakeVision(),
      github: fakeGithub(),
      contributions: fakeContributions(),
      wakeup: fakeWakeup(),
      social: fakeSocial(),
      operatorClaim: fakeOperatorClaim(),
      autonomy: fakeAutonomy(),
      domain: fakeDomain(),
      website: fakeWebsite(),
      image: fakeImage(),
      scene: fakeScene(),
      injection: fakeInjection(),
    })
    await app.ready()

    const response = await rpc('initialize', handshake)

    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('kolonie')
  })

  it('is served unversioned — MCP negotiates its own version', async () => {
    app = buildApp({
      quests: fakeQuests(),
      deposits: fakeDepositDependencies(fakeDeposits()),
      vault: { vault: fakeVault() },
      accounts: fakeAccounts(),
      console: fakeConsole(),
      email: fakeEmail(),
      registry: fakeRegistry(),
      store: fakeStore(),
      catalogue: fakeCatalogue(),
      submissions: fakeSubmissions(),
      guidance: fakeGuidance(),
      support: support({ desk: fakeSupportDesk() }),
      erasure: erasure({ desk: fakeErasureDesk() }),
      retesting: { reset: async () => ({ outcome: 'not-a-tester' as const }) },
      academy: fakeAcademy(),
      keys: fakeKeys(),
      solana: fakeSolana(),
      pow: fakePow(),
      vision: fakeVision(),
      github: fakeGithub(),
      contributions: fakeContributions(),
      wakeup: fakeWakeup(),
      social: fakeSocial(),
      operatorClaim: fakeOperatorClaim(),
      autonomy: fakeAutonomy(),
      domain: fakeDomain(),
      website: fakeWebsite(),
      image: fakeImage(),
      scene: fakeScene(),
      injection: fakeInjection(),
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
      quests: fakeQuests(),
      deposits: fakeDepositDependencies(fakeDeposits()),
      vault: { vault: fakeVault() },
      accounts: fakeAccounts(),
      console: fakeConsole(),
      email: fakeEmail(),
      registry: fakeRegistry(),
      store: fakeStore(),
      catalogue: fakeCatalogue(),
      submissions: fakeSubmissions(),
      guidance: fakeGuidance(),
      support: support({ desk: fakeSupportDesk() }),
      erasure: erasure({ desk: fakeErasureDesk() }),
      retesting: { reset: async () => ({ outcome: 'not-a-tester' as const }) },
      academy: fakeAcademy(),
      keys: fakeKeys(),
      solana: fakeSolana(),
      pow: fakePow(),
      vision: fakeVision(),
      github: fakeGithub(),
      contributions: fakeContributions(),
      wakeup: fakeWakeup(),
      social: fakeSocial(),
      operatorClaim: fakeOperatorClaim(),
      autonomy: fakeAutonomy(),
      domain: fakeDomain(),
      website: fakeWebsite(),
      image: fakeImage(),
      scene: fakeScene(),
      injection: fakeInjection(),
    })
    await app.ready()

    const response = await rpc('initialize', handshake, {}, '/')

    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('kolonie')
  })

  it('still answers at /mcp, so a client configured before the change keeps working', async () => {
    app = buildApp({
      quests: fakeQuests(),
      deposits: fakeDepositDependencies(fakeDeposits()),
      vault: { vault: fakeVault() },
      accounts: fakeAccounts(),
      console: fakeConsole(),
      email: fakeEmail(),
      registry: fakeRegistry(),
      store: fakeStore(),
      catalogue: fakeCatalogue(),
      submissions: fakeSubmissions(),
      guidance: fakeGuidance(),
      support: support({ desk: fakeSupportDesk() }),
      erasure: erasure({ desk: fakeErasureDesk() }),
      retesting: { reset: async () => ({ outcome: 'not-a-tester' as const }) },
      academy: fakeAcademy(),
      keys: fakeKeys(),
      solana: fakeSolana(),
      pow: fakePow(),
      vision: fakeVision(),
      github: fakeGithub(),
      contributions: fakeContributions(),
      wakeup: fakeWakeup(),
      social: fakeSocial(),
      operatorClaim: fakeOperatorClaim(),
      autonomy: fakeAutonomy(),
      domain: fakeDomain(),
      website: fakeWebsite(),
      image: fakeImage(),
      scene: fakeScene(),
      injection: fakeInjection(),
    })
    await app.ready()

    const response = await rpc('initialize', handshake, {}, MCP_ALIAS_PATH)

    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('kolonie')
  })

  it('offers the same tools whichever of its addresses is used', async () => {
    app = buildApp({
      quests: fakeQuests(),
      deposits: fakeDepositDependencies(fakeDeposits()),
      vault: { vault: fakeVault() },
      accounts: fakeAccounts(),
      console: fakeConsole(),
      email: fakeEmail(),
      registry: fakeRegistry(),
      store: fakeStore(),
      catalogue: fakeCatalogue(),
      submissions: fakeSubmissions(),
      guidance: fakeGuidance(),
      support: support({ desk: fakeSupportDesk() }),
      erasure: erasure({ desk: fakeErasureDesk() }),
      retesting: { reset: async () => ({ outcome: 'not-a-tester' as const }) },
      academy: fakeAcademy(),
      keys: fakeKeys(),
      solana: fakeSolana(),
      pow: fakePow(),
      vision: fakeVision(),
      github: fakeGithub(),
      contributions: fakeContributions(),
      wakeup: fakeWakeup(),
      social: fakeSocial(),
      operatorClaim: fakeOperatorClaim(),
      autonomy: fakeAutonomy(),
      domain: fakeDomain(),
      website: fakeWebsite(),
      image: fakeImage(),
      scene: fakeScene(),
      injection: fakeInjection(),
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
      quests: fakeQuests(),
      deposits: fakeDepositDependencies(fakeDeposits()),
      vault: { vault: fakeVault() },
      accounts: fakeAccounts(),
      console: fakeConsole(),
      email: fakeEmail(),
      registry: fakeRegistry(),
      store: fakeStore(),
      catalogue: fakeCatalogue(),
      submissions: fakeSubmissions(),
      guidance: fakeGuidance(),
      support: support({ desk: fakeSupportDesk() }),
      erasure: erasure({ desk: fakeErasureDesk() }),
      retesting: { reset: async () => ({ outcome: 'not-a-tester' as const }) },
      academy: fakeAcademy(),
      keys: fakeKeys(),
      solana: fakeSolana(),
      pow: fakePow(),
      vision: fakeVision(),
      github: fakeGithub(),
      contributions: fakeContributions(),
      wakeup: fakeWakeup(),
      social: fakeSocial(),
      operatorClaim: fakeOperatorClaim(),
      autonomy: fakeAutonomy(),
      domain: fakeDomain(),
      website: fakeWebsite(),
      image: fakeImage(),
      scene: fakeScene(),
      injection: fakeInjection(),
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
   * The MCP door observes where a call came from (`#191`).
   *
   * **Asserted across the real transport rather than on the tool**, for the
   * reason the registration-limit test one block down gives: what can break here
   * is the *wiring*. Every tool resolves its own credential through
   * `authenticate(credential, deps.store)`, and the store those fifty call sites
   * receive is wrapped once in `routes/mcp.ts` — a tool test that built its own
   * dependencies would pass whether or not that wrapping existed.
   */
  it('observes where an authenticated MCP call came from', async () => {
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

    await rpc(
      'tools/call',
      { name: 'kolonie.me', arguments: {} },
      {
        authorization: `Bearer ${credentials.apiKey}`,
        'cf-connecting-ip': '203.0.113.7',
        'cf-ipcountry': 'DE',
        'cf-ray': '7d4f2a1b9c8e0000-FRA',
      },
    )

    const observed = colony.observedOrigins()
    expect(observed.length).toBeGreaterThan(0)
    expect(observed[0]?.origin.country).toBe('DE')
    expect(observed[0]?.origin.colo).toBe('FRA')
    // The digest and never the address, at this door as at the other one.
    expect(JSON.stringify(observed)).not.toContain('203.0.113.7')
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
      quests: fakeQuests(),
      deposits: fakeDepositDependencies(fakeDeposits()),
      vault: { vault: fakeVault() },
      accounts: fakeAccounts(),
      console: fakeConsole(),
      email: fakeEmail(),
      registry: fakeRegistry(),
      store: fakeStore(),
      catalogue: fakeCatalogue(),
      submissions: fakeSubmissions(),
      guidance: fakeGuidance(),
      support: support({ desk: fakeSupportDesk() }),
      erasure: erasure({ desk: fakeErasureDesk() }),
      retesting: { reset: async () => ({ outcome: 'not-a-tester' as const }) },
      academy: fakeAcademy(),
      keys: fakeKeys(),
      solana: fakeSolana(),
      pow: fakePow(),
      vision: fakeVision(),
      github: fakeGithub(),
      contributions: fakeContributions(),
      wakeup: fakeWakeup(),
      social: fakeSocial(),
      operatorClaim: fakeOperatorClaim(),
      autonomy: fakeAutonomy(),
      domain: fakeDomain(),
      website: fakeWebsite(),
      image: fakeImage(),
      scene: fakeScene(),
      injection: fakeInjection(),
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
