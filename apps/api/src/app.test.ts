import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fakeDepositDependencies, fakeDeposits } from './__fixtures__/deposits.js'
import type { FastifyInstance } from 'fastify'
import { buildApp } from './app.js'
import { fakeRegistry } from './__fixtures__/registry.js'
import { fakeStandingHints } from './__fixtures__/hints.js'
import { fakeWakeup } from './__fixtures__/wakeup.js'
import { fakeSolana } from './__fixtures__/solana.js'
import { fakeKeys } from './__fixtures__/keys.js'
import { fakeVision } from './__fixtures__/vision.js'
import { fakePow } from './__fixtures__/proof-of-work.js'
import { fakeMemory } from './__fixtures__/memory.js'
import { fakeContributions, fakeGithub } from './__fixtures__/github.js'
import { fakeAutonomy } from './__fixtures__/autonomy.js'
import { fakeOperatorClaim } from './__fixtures__/operator-claim.js'
import { fakeSocial } from './__fixtures__/social.js'
import { fakeDomain } from './__fixtures__/domain.js'
import { fakeWebsite } from './__fixtures__/website.js'
import { fakeImage } from './__fixtures__/image.js'
import { fakeScene } from './__fixtures__/scene.js'
import { fakeInjection } from './__fixtures__/injection.js'
import { fakeStore } from './__fixtures__/store.js'
import { fakeCatalogue } from './__fixtures__/catalogue.js'
import { fakeQuests } from './__fixtures__/quests.js'
import { fakeSubmissions } from './__fixtures__/submissions.js'
import { fakeGuidance } from './__fixtures__/guidance.js'
import { fakeSupportDesk } from './__fixtures__/support.js'
import { fakeOperatorRequests } from './__fixtures__/operator-requests.js'
import { fakePermissionReports } from './__fixtures__/permission-reports.js'
import { fakeErasureDesk } from './__fixtures__/erasure.js'
import { erasure } from './erasure.js'
import { support } from './support.js'
import { fakeAcademy } from './__fixtures__/academy.js'
import { fakeEmail } from './__fixtures__/email.js'
import { fakeVault } from './__fixtures__/vault.js'
import { fakeAccounts } from './__fixtures__/accounts.js'
import { fakeConsole } from './__fixtures__/console.js'

let app: FastifyInstance

beforeAll(async () => {
  app = buildApp({
    email: fakeEmail(),
    registry: fakeRegistry(),
    store: fakeStore(),
    catalogue: fakeCatalogue(),
    quests: fakeQuests(),
    deposits: fakeDepositDependencies(fakeDeposits()),
    submissions: fakeSubmissions(),
    guidance: fakeGuidance(),
    support: support({ desk: fakeSupportDesk() }),
    // The operator channel (#236), which this test does not exercise.
    operatorRequests: fakeOperatorRequests(),
    // Blocked by permission rather than by ability (#147), unexercised here.
    permissionReports: fakePermissionReports(),
    erasure: erasure({ desk: fakeErasureDesk() }),
    retesting: { reset: async () => ({ outcome: 'not-a-tester' as const }) },
    academy: fakeAcademy(),
    keys: fakeKeys(),
    solana: fakeSolana(),
    pow: fakePow(),
    memory: fakeMemory(),
    vision: fakeVision(),
    github: fakeGithub(),
    contributions: fakeContributions(),
    wakeup: fakeWakeup(),
    hints: fakeStandingHints(),
    social: fakeSocial(),
    operatorClaim: fakeOperatorClaim(),
    autonomy: fakeAutonomy(),
    domain: fakeDomain(),
    website: fakeWebsite(),
    image: fakeImage(),
    scene: fakeScene(),
    injection: fakeInjection(),
    vault: { vault: fakeVault() },
    accounts: fakeAccounts(),
    console: fakeConsole(),
  })
  await app.ready()
})

afterAll(async () => {
  await app.close()
})

describe('GET /health', () => {
  it('answers 200 so the container healthcheck passes', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ status: 'ok' })
  })

  it('is deliberately unversioned — Docker must not track API versions', async () => {
    const versioned = await app.inject({ method: 'GET', url: '/v1/health' })
    expect(versioned.statusCode).toBe(404)
  })
})

describe('GET /captcha/', () => {
  it('serves the Browser Capability Gate page (D-022)', async () => {
    const response = await app.inject({ method: 'GET', url: '/captcha/' })
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/html')
  })

  it('serves nothing outside its own directory', async () => {
    // The prefix is what keeps a static wildcard away from the API routes. If
    // this ever answers, the mount has widened and a filename can shadow a path.
    const escaped = await app.inject({ method: 'GET', url: '/captcha/../package.json' })
    expect(escaped.statusCode).not.toBe(200)
  })
})

describe('versioning', () => {
  it('serves the index under /v1', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1' })
    expect(response.statusCode).toBe(200)
    expect(response.json().version).toBe('v1')
  })

  it('does not answer unversioned agent routes', async () => {
    const response = await app.inject({ method: 'GET', url: '/agents/me' })
    expect(response.statusCode).toBe(404)
  })
})

describe('errors', () => {
  it('returns a machine-readable code an agent can branch on', async () => {
    const response = await app.inject({ method: 'GET', url: '/nope' })
    expect(response.statusCode).toBe(404)
    expect(response.json().code).toBe('not_found')
  })

  it('tells a lost caller where the endpoints live', async () => {
    const response = await app.inject({ method: 'GET', url: '/nope' })
    expect(response.json().message).toContain('/v1')
  })

  /**
   * #18: this server answers two surfaces, so the 404 has to name both. It used
   * to name `/v1/` alone, which sent an MCP client that landed on the root
   * further from the endpoint it wanted rather than closer.
   */
  it('names the MCP surface too, so an MCP client is not sent to /v1', async () => {
    const response = await app.inject({ method: 'GET', url: '/nope' })
    expect(response.json().message).toMatch(/MCP/)
    expect(response.json().message).toContain('/mcp')
  })

  /**
   * The red line in AGENTS.md §9: no host names in this repository, and that
   * includes the strings an agent reads. Which hostname reaches which surface
   * lives in Cloudflare and Traefik.
   */
  it('names paths and never hosts', async () => {
    const response = await app.inject({ method: 'GET', url: '/nope' })
    expect(response.json().message).not.toMatch(/https?:\/\//)
  })
})
