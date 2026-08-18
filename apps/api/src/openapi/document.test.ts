import { fakeHumans } from '../__fixtures__/humans.js'
import { fakeArtefactChallenges } from '../__fixtures__/artefact.js'
import { API_BASE_PATH } from '@kolonie-ai/core'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fakeAcademy } from '../__fixtures__/academy.js'
import { fakeAccounts } from '../__fixtures__/accounts.js'
import { fakeAccountOffers } from '../__fixtures__/account-offers.js'
import { fakeConsole } from '../__fixtures__/console.js'
import { fakeCatalogue } from '../__fixtures__/catalogue.js'
import { fakeQuests } from '../__fixtures__/quests.js'
import { fakeDomain } from '../__fixtures__/domain.js'
import { fakeEmail } from '../__fixtures__/email.js'
import { fakeSms } from '../__fixtures__/sms.js'
import { fakeErasureDesk } from '../__fixtures__/erasure.js'
import { fakeContributions, fakeGithub } from '../__fixtures__/github.js'
import { fakeContributionQuality } from '../__fixtures__/contribution-quality.js'
import { fakeStandingHints } from '../__fixtures__/hints.js'
import { fakeWakeup } from '../__fixtures__/wakeup.js'
import { fakeGuidance } from '../__fixtures__/guidance.js'
import { fakeImage } from '../__fixtures__/image.js'
import { fakeScene } from '../__fixtures__/scene.js'
import { fakeInjection } from '../__fixtures__/injection.js'
import { fakeVetting } from '../__fixtures__/vetting.js'
import { fakeAuthenticator } from '../__fixtures__/authenticator.js'
import { fakeKeys } from '../__fixtures__/keys.js'
import { fakePow } from '../__fixtures__/proof-of-work.js'
import { fakeMemory } from '../__fixtures__/memory.js'
import { fakeRegistry } from '../__fixtures__/registry.js'
import { fakeAutonomy } from '../__fixtures__/autonomy.js'
import { fakeOperatorClaim } from '../__fixtures__/operator-claim.js'
import { fakeSocial } from '../__fixtures__/social.js'
import { fakeSolana } from '../__fixtures__/solana.js'
import { fakeStore } from '../__fixtures__/store.js'
import { fakeSubmissions } from '../__fixtures__/submissions.js'
import { fakeSupportDesk } from '../__fixtures__/support.js'
import { fakeOperatorNotes } from '../__fixtures__/operator-notes.js'
import { fakeOperatorRequests } from '../__fixtures__/operator-requests.js'
import { fakePermissionReports } from '../__fixtures__/permission-reports.js'
import { fakeRotation } from '../__fixtures__/rotation.js'
import { fakeVault } from '../__fixtures__/vault.js'
import { fakeVision } from '../__fixtures__/vision.js'
import { fakeWebServer } from '../__fixtures__/web-server.js'
import { fakeWake } from '../__fixtures__/wake.js'
import { fakeWishList } from '../__fixtures__/account-wishes.js'
import { fakeWebsite } from '../__fixtures__/website.js'
import { buildApp } from '../app.js'
import { erasure } from '../erasure.js'
import { support } from '../support.js'

import { isPublicPath, openApiPath, buildOpenApiDocument } from './document.js'
import { CREDENTIAL_FREE, OPERATIONS, PRIVATE_PREFIXES } from './operations.js'
import { arrivalReports } from '../arrival-reports.js'
import { fakeArrivalDesk } from '../__fixtures__/arrivals.js'

/**
 * `GET /openapi.json` (`#442`), driven through the real server rather than
 * through a list of routes written for the test — the document's whole claim is
 * that it describes what this server actually registered.
 */
describe('the OpenAPI document', () => {
  let app: FastifyInstance
  let document: {
    openapi: string
    info: Record<string, unknown>
    servers: { url: string }[]
    components: Record<string, unknown>
    paths: Record<
      string,
      Record<
        string,
        { security?: unknown[]; requestBody?: unknown; responses: Record<string, unknown> }
      >
    >
  }

  beforeEach(async () => {
    app = buildApp({
      arrivals: arrivalReports({ desk: fakeArrivalDesk() }),
      humans: fakeHumans(),
      quests: fakeQuests(),
      vault: { vault: fakeVault() },
      accounts: fakeAccounts(),
      accountOffers: { offers: fakeAccountOffers() },
      console: fakeConsole(),
      email: fakeEmail(),
      sms: fakeSms(),
      registry: fakeRegistry(),
      store: fakeStore(),
      catalogue: fakeCatalogue(),
      submissions: fakeSubmissions(),
      guidance: fakeGuidance(),
      support: support({ desk: fakeSupportDesk() }),
      // The operator channel (#236), which this test does not exercise.
      operatorRequests: fakeOperatorRequests(),
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
    })

    const response = await app.inject({ method: 'GET', url: '/openapi.json' })
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('application/json')
    document = response.json()
  })

  afterEach(async () => {
    await app?.close()
  })

  it('declares OpenAPI 3.1 and needs no credential to read', async () => {
    expect(document.openapi).toBe('3.1.0')
    const anonymous = await app.inject({ method: 'GET', url: '/openapi.json' })
    expect(anonymous.statusCode).toBe(200)
  })

  /**
   * The one thing about this door a schema cannot describe (`#1002`).
   *
   * A citizen was refused at the edge with a `403` carrying none of the shapes
   * this document promises, read it as the API being shut, and drew the wrong
   * conclusion about why — *bare clients are blocked*, when in fact no
   * `User-Agent` at all is served and one particular value is not. So what is
   * asserted is the signature and the symptom, not the presence of a paragraph:
   * a warning that does not name the header a caller is actually sending leaves
   * that caller exactly where it was.
   */
  it('names the client signature the edge turns away, and what it looks like', () => {
    const description = String(document.info['description'])

    expect(description).toContain('Python-urllib')
    expect(description).toContain('error code: 1010')
    // The half that keeps this from being the advice the reporter asked for and
    // would still have been blocked by: it had a User-Agent.
    expect(description).toMatch(/no user-agent at all is served/i)
  })

  it('describes some of the API at all', () => {
    // An assertion over an empty `paths` passes, and an empty document is
    // exactly what a broken route collector produces.
    expect(Object.keys(document.paths).length).toBeGreaterThan(20)
  })

  it('puts every path under /v1/', () => {
    // The rejection case `#442` asks for: this fails the moment a route
    // outside the published prefix reaches the document.
    for (const path of Object.keys(document.paths)) {
      expect(path.startsWith(`${API_BASE_PATH}/`)).toBe(true)
    }
  })

  it('leaves out the console, the steward pages and the inbound webhook', () => {
    for (const path of Object.keys(document.paths)) {
      for (const prefix of PRIVATE_PREFIXES) {
        expect(path.startsWith(prefix)).toBe(false)
      }
    }
    // Named rather than only ruled out by prefix, so the test still means
    // something if a prefix is renamed.
    expect(document.paths['/v1/console/sign-in']).toBeUndefined()
    expect(document.paths['/v1/internal/email-inbound']).toBeUndefined()
  })

  it('names no origin host, internal service name or IP address', () => {
    const serialised = JSON.stringify(document)
    expect(serialised).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/)
    // Every absolute URL in the document is a published address of the Colony
    // or the JSON Schema dialect the document declares.
    const allowed = ['https://mcp.kolonie.ai', 'https://kolonie.ai', 'https://json-schema.org/']
    for (const url of serialised.match(/https?:\/\/[^"\s]+/g) ?? []) {
      expect(allowed.some((prefix) => url.startsWith(prefix))).toBe(true)
    }
    expect(document.servers).toEqual([{ url: '/' }])
  })

  it('says which routes need no credential, and defaults the rest to needing one', () => {
    const register = document.paths['/v1/agents/register']?.['post']
    expect(register?.security).toEqual([])
    expect(register?.responses['401']).toBeUndefined()

    const me = document.paths['/v1/agents/me']?.['get']
    expect(me?.security).toEqual([{ apiKey: [] }])
    expect(me?.responses['401']).toBeDefined()

    // `#1009`, asserted rather than left to the default because here the
    // default is not merely wrong: this route is the one channel for a caller
    // that could not get a key, and a document promising it a 401 describes it
    // as shut to exactly the agent it was built for.
    const arrival = document.paths['/v1/arrival-reports']?.['post']
    expect(arrival?.security).toEqual([])
    expect(arrival?.responses['401']).toBeUndefined()
  })

  it('carries the request body schema the route already validates against', () => {
    const register = document.paths['/v1/agents/register']?.['post']
    const schema = (
      register?.requestBody as {
        content: Record<string, { schema: { properties?: Record<string, unknown> } }>
      }
    ).content['application/json']?.schema

    // `RegisterAgentRequestSchema` is four fields and strict, and this is the
    // schema itself rather than a copy of it — so the day a field moves, the
    // document moves with it.
    expect(Object.keys(schema?.properties ?? {}).sort()).toEqual([
      'confirm',
      'name',
      'operator',
      'platform',
    ])
  })

  /**
   * **A caller that only reads the schema must be able to see the two-step**
   * (`#875`), or it will read the first refusal as an outage and retry into it.
   *
   * The description travels with the schema rather than being written into the
   * route, so the document and the tool description cannot drift apart: both
   * render what `RegisterAgentRequestSchema` says about itself.
   */
  it('says on the register body that registration is two calls', () => {
    const register = document.paths['/v1/agents/register']?.['post']
    const schema = (
      register?.requestBody as {
        content: Record<
          string,
          {
            schema: { description?: string; properties?: Record<string, { description?: string }> }
          }
        >
      }
    ).content['application/json']?.schema

    expect(schema?.description).toMatch(/two calls/i)
    expect(schema?.description).toMatch(/not an outage/i)
    expect(schema?.properties?.confirm?.description).toMatch(/single-use/i)
  })

  /** The refusal a first call earns has a status, and it is not an error code. */
  it('documents the pause as an answer the register route gives', () => {
    const register = document.paths['/v1/agents/register']?.['post']

    expect(register?.responses['409']).toBeDefined()
  })

  it('turns Fastify parameters into OpenAPI parameters', () => {
    expect(openApiPath('/v1/tasks/:taskId/reports')).toBe('/v1/tasks/{taskId}/reports')
    const task = document.paths['/v1/tasks/{taskId}']?.['get'] as {
      parameters?: { name: string }[]
    }
    expect(task.parameters?.map((parameter) => parameter.name)).toEqual(['taskId'])
  })

  /**
   * The encoding rule reaches the surface a REST caller actually reads.
   *
   * `kolonie-docs#425`: a recommended vault key contains `/`, `{key}` is one
   * path segment, and the 404 a caller collects for the un-encoded spelling
   * says nothing at all. This is the only path parameter carrying prose, so
   * the assertion is on the fact rather than on the sentence.
   */
  it('says how to encode a vault key, which is the one parameter that needs it', () => {
    const parametersOf = (path: string, method: string) =>
      (document.paths[path]?.[method] as { parameters?: { name: string; description?: string }[] })
        ?.parameters ?? []

    for (const [path, method] of [
      ['/v1/vault/{key}', 'get'],
      ['/v1/vault/{key}', 'put'],
      ['/v1/vault/{key}', 'delete'],
      ['/v1/vault/{key}/description', 'put'],
    ] as const) {
      const key = parametersOf(path, method).find((parameter) => parameter.name === 'key')

      expect(key?.description).toMatch(/%2F/)
    }

    // And nowhere else: an id that describes itself gets no sentence, which is
    // what keeps this hook from becoming boilerplate on fifty parameters.
    const task = parametersOf('/v1/tasks/{taskId}', 'get')
    expect(task[0]?.description).toBeUndefined()
  })

  it('leaves out HEAD, which Fastify adds to every GET on its own', () => {
    for (const operations of Object.values(document.paths)) {
      expect(Object.keys(operations)).not.toContain('head')
    }
  })
})

describe('isPublicPath', () => {
  it('accepts the published surface and refuses everything else', () => {
    expect(isPublicPath('/v1/agents/me')).toBe(true)
    expect(isPublicPath('/v1/')).toBe(true)
    expect(isPublicPath('/v1/console/sign-in')).toBe(false)
    expect(isPublicPath('/v1/internal/email-inbound')).toBe(false)
    expect(isPublicPath('/mcp')).toBe(false)
    expect(isPublicPath('/openapi.json')).toBe(false)
    expect(isPublicPath('/badges/x.svg')).toBe(false)
    // Not a prefix match on a longer name: `/v1/consoles` would be public.
    expect(isPublicPath('/v1/consoles')).toBe(true)
  })
})

describe('the operations table', () => {
  it('is a table of schemas and never of paths', () => {
    // Every key names a route; nothing here invents one. The document is built
    // from the router, so a key that matches no route silently describes
    // nothing — this is what notices.
    const document = buildOpenApiDocument(
      Object.keys(OPERATIONS).map((key) => {
        const [method, url] = key.split(' ')
        return { method: method as string, url: url as string }
      }),
      { version: '1.0.0' },
    )
    for (const key of Object.keys(OPERATIONS)) {
      const [method, url] = key.split(' ')
      expect(document.paths).toHaveProperty([
        openApiPath(url as string),
        (method as string).toLowerCase(),
      ])
    }
  })

  it('names only routes that are public', () => {
    for (const key of [...Object.keys(OPERATIONS), ...CREDENTIAL_FREE]) {
      const url = key.split(' ')[1] as string
      expect(isPublicPath(url)).toBe(true)
    }
  })
})
