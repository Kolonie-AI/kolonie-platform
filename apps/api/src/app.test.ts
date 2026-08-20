import { fakeHumans } from './__fixtures__/humans.js'
import { fakeArtefactChallenges } from './__fixtures__/artefact.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from './app.js'
import { mcpProbe } from './mcp/probe.js'
import { fakeRegistry } from './__fixtures__/registry.js'
import { fakeStandingHints } from './__fixtures__/hints.js'
import { fakeWakeup } from './__fixtures__/wakeup.js'
import { fakeSolana } from './__fixtures__/solana.js'
import { fakeKeys } from './__fixtures__/keys.js'
import { fakeVision } from './__fixtures__/vision.js'
import { fakePow } from './__fixtures__/proof-of-work.js'
import { fakeMemory } from './__fixtures__/memory.js'
import { fakeContributions, fakeGithub } from './__fixtures__/github.js'
import { fakeContributionQuality } from './__fixtures__/contribution-quality.js'
import { fakeAutonomy } from './__fixtures__/autonomy.js'
import { fakeOperatorClaim } from './__fixtures__/operator-claim.js'
import { fakeSocial } from './__fixtures__/social.js'
import { fakeDomain } from './__fixtures__/domain.js'
import { fakeWebServer } from './__fixtures__/web-server.js'
import { fakeWake } from './__fixtures__/wake.js'
import { fakeWishList } from './__fixtures__/account-wishes.js'
import { fakeWebsite } from './__fixtures__/website.js'
import { fakeImage } from './__fixtures__/image.js'
import { fakeScene } from './__fixtures__/scene.js'
import { fakeInjection } from './__fixtures__/injection.js'
import { fakeVetting } from './__fixtures__/vetting.js'
import { fakeAuthenticator } from './__fixtures__/authenticator.js'
import { fakeStore } from './__fixtures__/store.js'
import { fakeCatalogue } from './__fixtures__/catalogue.js'
import { fakeQuests } from './__fixtures__/quests.js'
import { fakeSubmissions } from './__fixtures__/submissions.js'
import { fakeGuidance } from './__fixtures__/guidance.js'
import { fakeSupportDesk } from './__fixtures__/support.js'
import { fakeOperatorNotes } from './__fixtures__/operator-notes.js'
import { fakeOperatorThreads } from './__fixtures__/operator-threads.js'
import { fakePermissionReports } from './__fixtures__/permission-reports.js'
import { fakeRotation } from './__fixtures__/rotation.js'
import { fakeErasureDesk } from './__fixtures__/erasure.js'
import { erasure } from './erasure.js'
import { support } from './support.js'
import { fakeAcademy } from './__fixtures__/academy.js'
import { fakeEmail } from './__fixtures__/email.js'
import { fakeSms } from './__fixtures__/sms.js'
import { fakeVault } from './__fixtures__/vault.js'
import { fakeAccounts } from './__fixtures__/accounts.js'
import { fakeAccountOffers } from './__fixtures__/account-offers.js'
import { fakeConsole } from './__fixtures__/console.js'
import { arrivalReports } from './arrival-reports.js'
import { fakeArrivalDesk } from './__fixtures__/arrivals.js'

let app: FastifyInstance

beforeAll(async () => {
  app = buildApp({
    arrivals: arrivalReports({ desk: fakeArrivalDesk() }),
    humans: fakeHumans(),
    email: fakeEmail(),
    sms: fakeSms(),
    registry: fakeRegistry(),
    store: fakeStore(),
    catalogue: fakeCatalogue(),
    quests: fakeQuests(),
    submissions: fakeSubmissions(),
    guidance: fakeGuidance(),
    support: support({ desk: fakeSupportDesk() }),
    // The operator channel (#236), which this test does not exercise.
    operatorThreads: fakeOperatorThreads(),
    operatorNotes: fakeOperatorNotes(),
    // Blocked by permission rather than by ability (#147), unexercised here.
    permissionReports: fakePermissionReports(),
    // Replacing a leaked key (#211), unexercised here.
    rotation: fakeRotation(),
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
    contributionQuality: fakeContributionQuality(),
    wakeup: fakeWakeup(),
    hints: fakeStandingHints(),
    social: fakeSocial(),
    operatorClaim: fakeOperatorClaim(),
    autonomy: fakeAutonomy(),
    domain: fakeDomain(),
    artefact: fakeArtefactChallenges(),
    website: fakeWebsite(),
    webServer: fakeWebServer(),
    wake: fakeWake(),
    wishes: fakeWishList(),
    image: fakeImage(),
    scene: fakeScene(),
    injection: fakeInjection(),
    vetting: fakeVetting(),
    authenticator: fakeAuthenticator(),
    vault: { vault: fakeVault() },
    accounts: fakeAccounts(),
    accountOffers: { offers: fakeAccountOffers() },
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

  /**
   * `#1129`, against the real route table rather than a fixture: what
   * `not-found-hint.test.ts` asserts about the rules, this asserts about the
   * routes this server actually registers. The path is the one the citizen in
   * `kolonie-docs#425` sent — the recommended vault key shape, which has a `/`
   * in it and is therefore a longer path rather than a longer value.
   */
  it('names the pattern a parameter would have matched', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/v1/vault/phone/agentphone.ai/assay',
    })

    expect(response.statusCode).toBe(404)
    expect(response.json().message).toContain('/v1/vault/{key}')
    expect(response.json().message).toContain('%2F')
  })

  /**
   * The half that is answered before any credential is checked, so it is
   * answered to anybody: the hint may name a pattern and may never say whether
   * a value exists. Both requests below are unauthenticated and their bodies
   * have to be identical.
   */
  it('says the same thing whatever the value in the path is', async () => {
    const [stored, absent] = await Promise.all([
      app.inject({ method: 'PATCH', url: '/v1/vault/github~octocat' }),
      app.inject({ method: 'PATCH', url: '/v1/vault/nothing-is-stored-here' }),
    ])

    expect(stored.json().message.replace('github~octocat', '')).toBe(
      absent.json().message.replace('nothing-is-stored-here', ''),
    )
    expect(stored.json().message).toContain('/v1/vault/{key}')
  })

  /**
   * The private prefixes are absent from `/openapi.json` and absent from the
   * hint for the same reason. A 404 that pointed a stranger at the steward
   * pages would be a worse answer than the plain one it replaced.
   */
  it('never names a route a stranger is not invited through', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/steward/queues' })

    expect(response.statusCode).toBe(404)
    // Everything but the echo of what the caller itself sent, which is the one
    // place the path is allowed to appear because the caller already had it.
    const said = response.json().message.replace('/v1/steward/queues', '')
    expect(said).not.toContain('steward')
    expect(said).not.toContain('registered')
  })
})

/**
 * The MCP door, probed with the wrong method (`#1005`).
 *
 * A citizen ran the check every operator runs before wiring anything up — `GET`
 * the address, see whether it answers — and read the 404 as *the service is
 * down*, while `POST` to the same address was returning the tool list. The 404
 * above did say where MCP lives; a probe is judged by its status long before
 * anybody opens the body, which is why the sentence was not enough and the
 * status had to move.
 */
describe('a probe at the MCP door', () => {
  it('answers 405 rather than 404, on both permanent paths', async () => {
    for (const path of ['/', '/mcp']) {
      const response = await app.inject({ method: 'GET', url: path })
      expect(response.statusCode, path).toBe(405)
    }
  })

  /**
   * The machine-readable half. A status alone cannot say *which* method, and
   * `curl -I` — which is what a probe actually sends — never sees a body.
   */
  it('names the method in a header a HEAD request can still read', async () => {
    const response = await app.inject({ method: 'HEAD', url: '/mcp' })
    expect(response.statusCode).toBe(405)
    expect(response.headers.allow).toBe('POST')
  })

  it('says the service is up, and what it speaks', async () => {
    const body = (await app.inject({ method: 'GET', url: '/' })).json()
    expect(body.status).toBe('ok')
    expect(body.transport).toBe('streamable-http')
    expect(body.method).toBe('POST')
    // Both paths, so a caller that landed on one learns the other exists.
    expect(body.paths).toEqual(['/', '/mcp'])
  })

  /**
   * The other surface the root fronts (`#1057`).
   *
   * Every other field in that body describes MCP, and until this one the REST
   * prefix appeared only in the prose `hint`. A client written against the REST
   * API — which is who the OpenAPI document's own description is addressed to —
   * probes the host root, parses `service`, `transport` and `paths`, and
   * concludes it has found an MCP server. It is right about every field it read
   * and wrong about where it is. `#1005`'s own argument is that a probe is read
   * by its machine fields long before its body, so the prefix had to become one.
   *
   * **Asserted against a route rather than against a literal.** Repeating
   * `'/v1/'` here would still pass on the day the prefix moved and the probe did
   * not follow. Injecting at the prefix the probe names is the assertion that
   * cannot rot: if it is not where REST lives, the app answers 404.
   */
  it('names where the REST surface begins, and it is really there', async () => {
    const body = (await app.inject({ method: 'GET', url: '/' })).json()
    expect(typeof body.rest).toBe('string')
    const response = await app.inject({ method: 'GET', url: body.rest })
    expect(response.statusCode, body.rest).not.toBe(404)
  })

  /**
   * The reason belongs to the method that arrived (`#1058`).
   *
   * The hint used to end *…opens no server-to-client stream, which is what MCP
   * gives `GET`* whatever the caller had sent, so `OPTIONS`, `HEAD`, `PUT` and
   * `DELETE` were each handed `GET`'s reason as though it were their own. This
   * asserts the split in both directions at once: the clause is present for the
   * method it is about and absent for one it is not.
   */
  it('gives GET the reason that is about GET', async () => {
    const body = (await app.inject({ method: 'GET', url: '/' })).json()
    expect(body.hint).toMatch(/stream/)
    expect(body.hint).toMatch(/405/)
  })

  /**
   * `OPTIONS` is the method the old sentence was not merely misattributed to but
   * wrong about: it asked which methods are allowed, and `Allow: POST` beside
   * this body answers exactly that. Being told it had no meaning here was false.
   */
  it('corrects OPTIONS rather than giving it a reason', async () => {
    const response = await app.inject({ method: 'OPTIONS', url: '/mcp' })
    expect(response.headers.allow).toBe('POST')
    expect(response.json().hint).toMatch(/Allow/)
  })

  /**
   * `DELETE` is the other method MCP's transport defines — session termination —
   * so a client that sent it deserves the reason it does not work here, which is
   * that there is no session, not that the request was meaningless.
   */
  it('tells DELETE there is no session to end', async () => {
    const body = (await app.inject({ method: 'DELETE', url: '/mcp' })).json()
    expect(body.hint).toMatch(/session here to end/)
  })

  /**
   * **The rejection case.** A method the transport never gave a meaning to gets
   * the unconditional sentence and nothing more — no stream, no session, no
   * `Allow` correction. This is the assertion that fails if the clause is ever
   * made unconditional again: `PUT` is not `GET`, is not `DELETE` and is not
   * `OPTIONS`, so a hint carrying any of their reasons is carrying somebody
   * else's. `HEAD` takes the same branch and is asserted through `mcpProbe`
   * directly, because `HEAD` has no body for `inject` to read.
   */
  it('never hands a method another method’s reason', async () => {
    const bodies = [
      (await app.inject({ method: 'PUT', url: '/mcp' })).json().hint,
      mcpProbe('HEAD', '/mcp')?.hint,
    ]
    for (const hint of bodies) {
      expect(hint).toMatch(/keeps no session/)
      expect(hint).not.toMatch(/required to answer 405/)
      expect(hint).not.toMatch(/session here to end/)
      expect(hint).not.toMatch(/`Allow` header/)
    }
  })

  /**
   * `AGENTS.md` §9 again, on a new string: which hostname reaches which surface
   * is a routing fact that lives outside this repository.
   */
  it('names paths and never hosts', async () => {
    const body = (await app.inject({ method: 'GET', url: '/mcp' })).json()
    expect(JSON.stringify(body)).not.toMatch(/https?:\/\//)
  })

  /**
   * A health check that turns on a slash is a health check that reports the
   * wrong thing — and a probe written by hand arrives this way about as often as
   * it arrives clean.
   */
  it('is not defeated by a trailing slash or a query string', async () => {
    for (const url of ['/mcp/', '/?probe=1', '/mcp/?probe=1']) {
      expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(405)
    }
  })

  /**
   * The fall-through, which is the half that could go wrong quietly: a caller
   * that asked for a path the Colony does not serve is not helped by being told
   * about a method, and turning every 404 into a 405 would be a worse answer
   * than the one this replaced.
   */
  it('leaves every other path a 404', async () => {
    const response = await app.inject({ method: 'GET', url: '/mcpx' })
    expect(response.statusCode).toBe(404)
    expect(response.json().code).toBe('not_found')
  })

  /**
   * The other half of the fall-through, and the one with teeth: `POST` is the
   * method this surface exists for, so a probe that answered it would be
   * standing in front of the transport rather than beside it. Every field the
   * probe carries — including the REST prefix `#1057` added — must be absent
   * from what a real request gets back.
   */
  it('never answers the method the surface is for', async () => {
    const response = await app.inject({ method: 'POST', url: '/mcp' })
    expect(response.statusCode).not.toBe(405)
    expect(response.body).not.toMatch(/kolonie-mcp/)
  })
})
