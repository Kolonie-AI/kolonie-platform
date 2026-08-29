import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { InjectOptions, Response as InjectResponse } from 'light-my-request'
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose'
import type { JWK, JWTVerifyGetKey, KeyObject } from 'jose'
import {
  ERROR_STATUS,
  WorkplaceBoardIdSchema,
  WORKPLACE_CITIZEN_HEADER,
  type AgentId,
  type WorkplaceBoard,
} from '@kolonie-ai/core'
import { buildApp } from '../app.js'
import { FAKE_CALLER_IP, fakeColony, type FakeColony } from '../__fixtures__/colony/index.js'
import { anAgent, fakeHumanStore, type FakeHumanStore } from '../__fixtures__/humans.js'
import { SESSION_COOKIE } from './console.js'

/**
 * The workplace SPA's bearer-token door (`#1727`).
 *
 * ## Every value here is invented by this file
 *
 * The issuer, the audience and the origin below are made up in front of you,
 * from RFC 2606 documentation names, and the signing key is generated per run.
 * **That is the acceptance criterion rather than tidiness**: `AGENTS.md` §3 and
 * `kolonie-docs`' `workplace-spa-uses-an-access-token.md` both say no tenant
 * value, client identifier, audience string or secret appears in this
 * repository, and a fixture is not an exception. A test that hard-coded the
 * real ones would put them in git while proving they were configuration.
 *
 * ## Why a local key set and not a stubbed verifier
 *
 * The keys are handed to the route through `workplace.keys`, so `jose` performs
 * a real signature check against a real key pair. A fake that answered *this
 * token is valid* would assert that the route calls something, which is the one
 * thing about this door that does not matter — what matters is that a token
 * signed by the wrong key does not get in, and only a real verification can say
 * so.
 */
const ISSUER = 'https://tenant.example.test/'
const AUDIENCE = 'workplace-api-audience-for-tests'
const WORKPLACE_ORIGIN = 'https://workplace.example.test'
const CONSOLE_URL = 'https://console.example.test'
const OTHER_ORIGIN = 'https://not-the-workplace.example.test'

const ME = '/v1/workplace/me'
const ACTOR = '/v1/workplace/actor'
const BOARDS = '/v1/workplace/boards'

/** The `sub` a tenant mints: `<strategy>|<subject>`, as `auth0.ts` records. */
const SUBJECT = 'github|4815162342'

let app: FastifyInstance
let humans: FakeHumanStore
let colony: FakeColony

/** The key the Colony trusts, and one it has never heard of. */
let signing: { privateKey: KeyObject; publicJwk: JWK }
let stranger: { privateKey: KeyObject }

const keyPair = async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true })
  return { privateKey: privateKey as KeyObject, publicJwk: await exportJWK(publicKey) }
}

/** The JWKS the route verifies against: exactly one key, and it is `signing`'s. */
const trustedKeys = (): JWTVerifyGetKey =>
  createLocalJWKSet({ keys: [{ ...signing.publicJwk, alg: 'RS256', use: 'sig' }] })

/**
 * A token, signed and complete unless a test says otherwise.
 *
 * Every rejection case below is this token with **one** thing changed, which is
 * what makes each assertion about the boundary it names rather than about a
 * token that was malformed in several ways at once.
 */
const aToken = async (
  over: {
    issuer?: string
    audience?: string
    subject?: string
    expiresAt?: number
    key?: KeyObject
  } = {},
): Promise<string> => {
  const now = Math.floor(Date.now() / 1000)
  return await new SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    .setSubject(over.subject ?? SUBJECT)
    .setIssuer(over.issuer ?? ISSUER)
    .setAudience(over.audience ?? AUDIENCE)
    .setIssuedAt(now - 60)
    .setExpirationTime(over.expiresAt ?? now + 300)
    .sign(over.key ?? signing.privateKey)
}

const build = (configured = true) => {
  humans = fakeHumanStore()
  colony = fakeColony()
  return buildApp({
    ...colony,
    console: { ...colony.console, consoleUrl: CONSOLE_URL },
    humans: { store: humans },
    ...(configured
      ? {
          workplace: {
            issuer: ISSUER,
            audience: AUDIENCE,
            origin: WORKPLACE_ORIGIN,
            keys: trustedKeys(),
          },
        }
      : {}),
  })
}

/** The call the SPA makes: a bearer token and the browser's own `Origin`. */
const asWorkplace = (token?: string, origin: string | undefined = WORKPLACE_ORIGIN) =>
  app.inject({
    method: 'GET',
    url: ME,
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(origin === undefined ? {} : { origin }),
    },
  })

beforeEach(async () => {
  signing = await keyPair()
  stranger = await keyPair()
  app = build()
  await app.ready()
})

afterEach(async () => {
  await app?.close()
})

describe('the workplace door', () => {
  describe('a valid token', () => {
    it('authenticates and answers with the person behind the pair', async () => {
      humans.holdsIdentity({
        provider: 'github',
        subject: '4815162342',
        email: 'someone@example.test',
      })
      const response = await asWorkplace(await aToken())

      expect(response.statusCode).toBe(200)
      const body = response.json() as {
        human: { id: string; identities: { provider: string; subject: string }[] }
        agents: unknown[]
      }
      expect(body.human.identities).toEqual([{ provider: 'github', subject: '4815162342' }])
      expect(body.human.id).toEqual(expect.any(String))
      expect(body.agents).toEqual([])
    })

    /**
     * **Lookup only (`#1764`).** An unknown pair is the same 401 as a bad
     * token — the SPA never mints a Colony human. The console remains the
     * path that writes a person.
     */
    it('refuses an unknown pair the same way it refuses a bad token', async () => {
      const unknown = await asWorkplace(await aToken())
      const bad = await asWorkplace(undefined)

      expect(unknown.statusCode).toBe(ERROR_STATUS.unauthorized)
      expect(unknown.body).toBe(bad.body)
      expect(humans.people()).toHaveLength(0)
    })

    it('resolves the person the console already knows, and creates no second one', async () => {
      const existing = humans.holdsIdentity({
        provider: 'github',
        subject: '4815162342',
        email: 'someone@example.test',
      })

      const response = await asWorkplace(await aToken())

      expect(response.statusCode).toBe(200)
      expect((response.json() as { human: { id: string } }).human.id).toBe(existing.id)
      expect(humans.people()).toHaveLength(1)
    })

    /** The three strategies `auth0.ts` records as disagreeing with their provider. */
    it.each([
      ['google-oauth2|99', 'google'],
      ['twitter|99', 'x'],
      ['auth0|99', 'password'],
    ])('reads %s as the provider %s', async (sub, provider) => {
      const human = humans.holdsIdentity({
        provider: provider as 'google' | 'x' | 'password',
        subject: '99',
        email: null,
      })
      const response = await asWorkplace(await aToken({ subject: sub }))

      expect(response.statusCode).toBe(200)
      const body = response.json() as { human: { id: string; identities: { provider: string }[] } }
      expect(body.human.id).toBe(human.id)
      expect(body.human.identities[0]?.provider).toBe(provider)
    })
  })

  describe('the linked citizens (#1764)', () => {
    const hold = () =>
      humans.holdsIdentity({
        provider: 'github',
        subject: '4815162342',
        email: 'someone@example.test',
      })

    it('answers with an empty list when the human operates nobody', async () => {
      hold()
      const body = (await asWorkplace(await aToken())).json() as { agents: unknown[] }
      expect(body.agents).toEqual([])
    })

    it('lists one linked citizen by id, handle and status', async () => {
      const person = hold()
      const agent = anAgent({ name: 'colette', status: 'citizen' })
      humans.operatesAgent(person.id, agent)

      const body = (await asWorkplace(await aToken())).json() as {
        agents: { id: string; handle: string; status: string }[]
      }
      expect(body.agents).toEqual([{ id: agent.id, handle: 'colette', status: 'citizen' }])
    })

    it('lists two, and never a citizen this human does not operate', async () => {
      const person = hold()
      const first = anAgent({ name: 'alpha', status: 'citizen' })
      const second = anAgent({ name: 'beta', status: 'candidate' })
      const stranger = anAgent({ name: 'gamma', status: 'citizen' })
      humans.operatesAgent(person.id, first)
      humans.operatesAgent(person.id, second)
      const other = humans.holdsIdentity({
        provider: 'google',
        subject: '99',
        email: null,
      })
      humans.operatesAgent(other.id, stranger)

      const body = (await asWorkplace(await aToken())).json() as {
        agents: { handle: string }[]
      }
      expect(body.agents.map((row) => row.handle).sort()).toEqual(['alpha', 'beta'])
    })

    it('lists a candidate — the human may look; board routes then empty', async () => {
      const person = hold()
      humans.operatesAgent(person.id, anAgent({ name: 'newcomer', status: 'candidate' }))

      const body = (await asWorkplace(await aToken())).json() as {
        agents: { status: string }[]
      }
      expect(body.agents[0]?.status).toBe('candidate')
    })

    it('does not require the citizen header', async () => {
      hold()
      const response = await asWorkplace(await aToken())
      expect(response.statusCode).toBe(200)
    })

    it('describes /v1/workplace/me from the core schema, not a parallel spec', async () => {
      const document = (await app.inject({ method: 'GET', url: '/openapi.json' })).json() as {
        paths: Record<string, { get?: { responses?: Record<string, { content?: unknown }> } }>
      }
      const schema = (
        document.paths['/v1/workplace/me']?.get?.responses?.['200'] as {
          content?: { 'application/json'?: { schema?: { properties?: Record<string, unknown> } } }
        }
      )?.content?.['application/json']?.schema
      expect(Object.keys(schema?.properties ?? {}).sort()).toEqual(['agents', 'human'])
    })
  })

  describe('the authorised probe (#1764)', () => {
    const hold = () =>
      humans.holdsIdentity({
        provider: 'github',
        subject: '4815162342',
        email: 'someone@example.test',
      })

    const asActor = (
      token: string | undefined,
      citizen?: string,
      origin: string | undefined = WORKPLACE_ORIGIN,
    ) =>
      app.inject({
        method: 'GET',
        url: ACTOR,
        headers: {
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
          ...(origin === undefined ? {} : { origin }),
          ...(citizen === undefined ? {} : { [WORKPLACE_CITIZEN_HEADER]: citizen }),
        },
      })

    it('accepts a linked citizen and names them', async () => {
      const person = hold()
      const agent = anAgent({ name: 'colette', status: 'citizen' })
      humans.operatesAgent(person.id, agent)

      const response = await asActor(await aToken(), agent.id)
      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ humanId: person.id, citizenId: agent.id })
    })

    it('refuses a missing header as 400, not as an unknown citizen', async () => {
      hold()
      const response = await asActor(await aToken())
      expect(response.statusCode).toBe(400)
      expect(response.json()).toMatchObject({ code: 'validation_failed' })
    })

    it('refuses an unlinked citizen without saying whether the agent exists', async () => {
      const person = hold()
      const linked = anAgent({ name: 'ours' })
      const foreign = anAgent({ name: 'theirs' })
      humans.operatesAgent(person.id, linked)
      const other = humans.holdsIdentity({
        provider: 'google',
        subject: '99',
        email: null,
      })
      humans.operatesAgent(other.id, foreign)

      const unlinked = await asActor(await aToken(), foreign.id)
      const invented = await asActor(await aToken(), 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')

      expect(unlinked.statusCode).toBe(ERROR_STATUS.workplace_unknown_citizen)
      expect(unlinked.json()).toMatchObject({ code: 'workplace_unknown_citizen' })
      expect(unlinked.body).toBe(invented.body)
    })

    it('still requires the header when the human operates exactly one citizen', async () => {
      const person = hold()
      humans.operatesAgent(person.id, anAgent({ name: 'only' }))
      expect((await asActor(await aToken())).statusCode).toBe(400)
    })

    it('refuses a disallowed origin before it looks at the credential or the header', async () => {
      const response = await asActor(undefined, undefined, OTHER_ORIGIN)
      expect(response.statusCode).toBe(ERROR_STATUS.forbidden)
    })
  })

  describe('refusing a credential', () => {
    /**
     * **One answer for every way of failing**, which the five cases below assert
     * as a set rather than one at a time. A door that said *expired* to an
     * expired token would tell a caller holding a harvested one that it was
     * once real.
     */
    const refusals: [string, () => Promise<string | undefined>][] = [
      ['nothing at all', async () => undefined],
      [
        'an expired token',
        async () => await aToken({ expiresAt: Math.floor(Date.now() / 1000) - 1 }),
      ],
      [
        'a signature from a key the Colony does not hold',
        async () => await aToken({ key: stranger.privateKey }),
      ],
      [
        'a token from another issuer',
        async () => await aToken({ issuer: 'https://someone-else.example.test/' }),
      ],
      [
        'a token for another audience',
        async () => await aToken({ audience: 'an-audience-this-api-is-not' }),
      ],
      ['a token carrying no subject at all', async () => await aToken({ subject: '' })],
      ['something that is not a token', async () => 'not-a-jwt'],
    ]

    it.each(refusals)('answers 401 to %s', async (_what, token) => {
      const response = await asWorkplace(await token())

      expect(response.statusCode).toBe(ERROR_STATUS.unauthorized)
      expect(response.json()).toMatchObject({ code: 'unauthorized' })
    })

    /** RFC 7235 requires it on every 401, and this door has more than one path to one. */
    it('carries WWW-Authenticate on every refusal', async () => {
      for (const [, token] of refusals) {
        const response = await asWorkplace(await token())
        expect(response.headers['www-authenticate']).toBe('Bearer')
      }
    })

    /**
     * The oracle test. Every refusal is one response, byte for byte — otherwise
     * a caller learns from the difference which half of its guess was right.
     */
    it('answers every refusal with the same body', async () => {
      const bodies = new Set<string>()
      for (const [, token] of refusals) {
        bodies.add((await asWorkplace(await token())).body)
      }

      expect(bodies.size).toBe(1)
    })

    it('refuses a header in another scheme, and never reads the value after it', async () => {
      const response = await app.inject({
        method: 'GET',
        url: ME,
        headers: { authorization: `Basic ${await aToken()}`, origin: WORKPLACE_ORIGIN },
      })

      expect(response.statusCode).toBe(ERROR_STATUS.unauthorized)
    })

    /** The scheme is case-insensitive in RFC 7235, so a client reading it is not wrong. */
    it('accepts the scheme in any case', async () => {
      humans.holdsIdentity({
        provider: 'github',
        subject: '4815162342',
        email: 'someone@example.test',
      })
      const response = await app.inject({
        method: 'GET',
        url: ME,
        headers: { authorization: `bearer ${await aToken()}`, origin: WORKPLACE_ORIGIN },
      })

      expect(response.statusCode).toBe(200)
    })
  })

  describe('the origin', () => {
    it('permits exactly the configured workplace origin', async () => {
      humans.holdsIdentity({
        provider: 'github',
        subject: '4815162342',
        email: 'someone@example.test',
      })
      const response = await asWorkplace(await aToken())

      expect(response.statusCode).toBe(200)
      expect(response.headers['access-control-allow-origin']).toBe(WORKPLACE_ORIGIN)
      expect(response.headers['vary']).toBe('Origin')
    })

    it('refuses another origin whatever credential it carries', async () => {
      const response = await asWorkplace(await aToken(), OTHER_ORIGIN)

      expect(response.statusCode).toBe(ERROR_STATUS.forbidden)
      expect(response.headers['access-control-allow-origin']).toBeUndefined()
    })

    /**
     * The decision record's own condition: *"must not add the console origin by
     * reflex"*. The console is the neighbouring browser surface on this same
     * server, so it is the origin somebody would allow without noticing.
     */
    it('refuses the console origin', async () => {
      const response = await asWorkplace(await aToken(), CONSOLE_URL)

      expect(response.statusCode).toBe(ERROR_STATUS.forbidden)
    })

    it('never answers with a wildcard origin', async () => {
      for (const origin of [WORKPLACE_ORIGIN, OTHER_ORIGIN, CONSOLE_URL]) {
        const response = await asWorkplace(await aToken(), origin)
        expect(response.headers['access-control-allow-origin']).not.toBe('*')
      }
    })

    /**
     * A refused origin is `403` and not `401`, and that distinction is the whole
     * of what this asserts: the two say different things to the SPA, which signs
     * the person back in on one and cannot fix the other by doing anything.
     */
    it('refuses a disallowed origin before it looks at the credential', async () => {
      const response = await asWorkplace(undefined, OTHER_ORIGIN)

      expect(response.statusCode).toBe(ERROR_STATUS.forbidden)
    })

    /**
     * A non-browser client sends no `Origin`, and the credential is what
     * authorises. Refusing it would refuse the API's own callers on a header
     * the browser decides.
     */
    it('answers a request carrying no Origin on the credential alone', async () => {
      humans.holdsIdentity({
        provider: 'github',
        subject: '4815162342',
        email: 'someone@example.test',
      })
      expect((await asWorkplace(await aToken(), undefined)).statusCode).toBe(200)
      expect((await asWorkplace(undefined, undefined)).statusCode).toBe(ERROR_STATUS.unauthorized)
    })

    describe('the preflight', () => {
      const preflight = (origin?: string) =>
        app.inject({
          method: 'OPTIONS',
          url: ME,
          headers: origin === undefined ? {} : { origin },
        })

      it('answers the allowed origin', async () => {
        const response = await preflight(WORKPLACE_ORIGIN)

        expect(response.statusCode).toBe(204)
        expect(response.headers['access-control-allow-origin']).toBe(WORKPLACE_ORIGIN)
        expect(response.headers['access-control-allow-headers']).toContain('authorization')
        expect(response.headers['access-control-allow-headers']).toContain('x-kolonie-citizen')
        expect(response.headers['access-control-allow-methods']).toContain('POST')
        expect(response.headers['access-control-allow-methods']).toContain('PATCH')
        expect(response.headers['access-control-allow-methods']).toContain('DELETE')
      })

      it('refuses any other origin, and answers no wildcard', async () => {
        for (const origin of [OTHER_ORIGIN, CONSOLE_URL, undefined]) {
          const response = await preflight(origin)
          expect(response.statusCode).toBe(ERROR_STATUS.forbidden)
          expect(response.headers['access-control-allow-origin']).toBeUndefined()
        }
      })

      /**
       * A preflight carries no credential — the browser strips `Authorization`
       * from it — so refusing it as `401` would refuse it for something it was
       * never able to send.
       */
      it('never asks a preflight for a credential', async () => {
        expect((await preflight(OTHER_ORIGIN)).statusCode).not.toBe(ERROR_STATUS.unauthorized)
      })
    })
  })

  describe('an unconfigured deployment', () => {
    beforeEach(async () => {
      await app.close()
      app = build(false)
      await app.ready()
    })

    /**
     * No issuer, no audience, no origin: no SPA door. A `401` here would read as
     * *your token is wrong* about a door that was never built. Board routes
     * still mount for an API-key caller (`#1759`).
     */
    it('serves no SPA workplace route', async () => {
      expect(app.hasRoute({ method: 'GET', url: ME })).toBe(false)
      expect(app.hasRoute({ method: 'GET', url: ACTOR })).toBe(false)
      expect((await asWorkplace(await aToken())).statusCode).toBe(ERROR_STATUS.not_found)
    })

    it('still serves the board collection to an API-key caller', async () => {
      expect(app.hasRoute({ method: 'GET', url: BOARDS })).toBe(true)
      const { apiKey } = await aCitizen()
      const response = await asKey('GET', BOARDS, apiKey)
      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ items: [], nextCursor: null })
    })
  })

  /**
   * The console's cookie authentication is a non-goal of `#1727` and this is
   * what says so out loud: nothing on this door reads a cookie, and nothing it
   * answers sets one. A `Set-Cookie` here would mean the API had acquired the
   * second human session the decision record refused.
   */
  describe('the console session', () => {
    it('is neither read nor written by this door', async () => {
      humans.holdsIdentity({
        provider: 'github',
        subject: '4815162342',
        email: 'someone@example.test',
      })
      const response = await app.inject({
        method: 'GET',
        url: ME,
        headers: {
          authorization: `Bearer ${await aToken()}`,
          origin: WORKPLACE_ORIGIN,
          cookie: `${SESSION_COOKIE}=a-session-this-door-must-ignore`,
        },
      })

      expect(response.statusCode).toBe(200)
      expect(response.headers['set-cookie']).toBeUndefined()
    })

    /** And a console cookie alone gets in nowhere here, whoever holds it. */
    it('does not authenticate a console cookie', async () => {
      const response = await app.inject({
        method: 'GET',
        url: ME,
        headers: {
          origin: WORKPLACE_ORIGIN,
          cookie: `${SESSION_COOKIE}=a-session-this-door-must-ignore`,
        },
      })

      expect(response.statusCode).toBe(ERROR_STATUS.unauthorized)
    })
  })
})

const aCitizen = async (name = 'canary') => {
  const registered = await colony.registry.register(
    { name, platform: 'openclaw' },
    { ip: FAKE_CALLER_IP },
  )
  if (registered.outcome !== 'registered') throw new Error('fixture failed to register')
  return {
    apiKey: registered.response.credentials.apiKey,
    agent: registered.response.agent,
  }
}

const asKey = (
  method: InjectOptions['method'],
  url: string,
  apiKey: string,
  over: { payload?: InjectOptions['payload']; headers?: Record<string, string> } = {},
): Promise<InjectResponse> =>
  app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${apiKey}`,
      ...(over.payload === undefined ? {} : { 'content-type': 'application/json' }),
      ...over.headers,
    },
    payload: over.payload,
  })

const asSpa = (
  method: InjectOptions['method'],
  url: string,
  token: string,
  citizen: string,
  over: {
    payload?: InjectOptions['payload']
    headers?: Record<string, string>
    origin?: string
  } = {},
): Promise<InjectResponse> =>
  app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${token}`,
      [WORKPLACE_CITIZEN_HEADER]: citizen,
      origin: over.origin ?? WORKPLACE_ORIGIN,
      ...(over.payload === undefined ? {} : { 'content-type': 'application/json' }),
      ...over.headers,
    },
    payload: over.payload,
  })

const aBoard = (
  ownerId: AgentId,
  over: { title?: string; kind?: 'default' | 'additional'; version?: number } = {},
): WorkplaceBoard => {
  const now = new Date().toISOString()
  return {
    id: WorkplaceBoardIdSchema.parse(randomUUID()),
    ownerId,
    title: over.title ?? 'Inbox',
    kind: over.kind ?? 'additional',
    archivedAt: null,
    version: over.version ?? 1,
    createdAt: now,
    updatedAt: now,
  }
}

describe('workplace boards (#1759)', () => {
  describe('an API-key caller', () => {
    it('creates a board and lists it as owner', async () => {
      const { apiKey, agent } = await aCitizen()
      const created = await asKey('POST', BOARDS, apiKey, { payload: { title: 'Shared' } })

      expect(created.statusCode).toBe(201)
      const board = created.json() as WorkplaceBoard
      expect(board.title).toBe('Shared')
      expect(board.kind).toBe('additional')
      expect(board.ownerId).toBe(agent.id)
      expect(created.headers.etag).toBe(String(board.version))

      const listed = await asKey('GET', BOARDS, apiKey)
      expect(listed.statusCode).toBe(200)
      expect(listed.json()).toEqual({ items: [board], nextCursor: null })
    })

    it('reads a board it sits on, with members named', async () => {
      const { apiKey, agent } = await aCitizen('owner-one')
      const board = aBoard(agent.id)
      colony.boards.plant(board, [{ boardId: board.id, citizenId: agent.id, role: 'owner' }])
      colony.boards.named(agent.profile.name, agent.id)

      const response = await asKey('GET', `${BOARDS}/${board.id}`, apiKey)
      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({
        board,
        members: [
          { boardId: board.id, citizenId: agent.id, role: 'owner', handle: agent.profile.name },
        ],
      })
      expect(response.headers.etag).toBe('1')
    })

    it('answers 404 for a board it is not on, the same as a missing one', async () => {
      const { apiKey } = await aCitizen('owner-two')
      const { apiKey: strangerKey } = await aCitizen('stranger')
      const created = await asKey('POST', BOARDS, apiKey, { payload: { title: 'Hidden' } })
      const board = created.json() as WorkplaceBoard

      const hidden = await asKey('GET', `${BOARDS}/${board.id}`, strangerKey)
      const missing = await asKey('GET', `${BOARDS}/${randomUUID()}`, strangerKey)
      expect(hidden.statusCode).toBe(ERROR_STATUS.not_found)
      expect(hidden.body).toBe(missing.body)
    })

    it('renames on a matching If-Match and refuses a stale one', async () => {
      const { apiKey } = await aCitizen('renamer')
      const created = await asKey('POST', BOARDS, apiKey, { payload: { title: 'Old' } })
      const board = created.json() as WorkplaceBoard

      const stale = await asKey('PATCH', `${BOARDS}/${board.id}`, apiKey, {
        payload: { title: 'Too late' },
        headers: { 'if-match': '99' },
      })
      expect(stale.statusCode).toBe(ERROR_STATUS.conflict)

      const renamed = await asKey('PATCH', `${BOARDS}/${board.id}`, apiKey, {
        payload: { title: 'New' },
        headers: { 'if-match': String(board.version) },
      })
      expect(renamed.statusCode).toBe(200)
      expect((renamed.json() as WorkplaceBoard).title).toBe('New')
      expect((renamed.json() as WorkplaceBoard).version).toBe(board.version + 1)
    })

    it('refuses to archive the default board', async () => {
      const { apiKey, agent } = await aCitizen('keeper')
      const board = aBoard(agent.id, { kind: 'default', title: 'My board' })
      colony.boards.plant(board, [{ boardId: board.id, citizenId: agent.id, role: 'owner' }])

      const response = await asKey('POST', `${BOARDS}/${board.id}/archive`, apiKey, {
        headers: { 'if-match': '1' },
      })
      expect(response.statusCode).toBe(ERROR_STATUS.workplace_default_board_protected)
      expect(response.json()).toMatchObject({ code: 'workplace_default_board_protected' })
    })

    it('adds a member by handle', async () => {
      const { apiKey, agent } = await aCitizen('host')
      const { agent: guest } = await aCitizen('guest-handle')
      const created = await asKey('POST', BOARDS, apiKey, { payload: { title: 'Team' } })
      const board = created.json() as WorkplaceBoard
      colony.boards.named(guest.profile.name, guest.id)
      colony.boards.named(agent.profile.name, agent.id)

      const added = await asKey('POST', `${BOARDS}/${board.id}/members`, apiKey, {
        payload: { citizenId: guest.profile.name },
      })
      expect(added.statusCode).toBe(201)
      expect(added.json()).toEqual({
        boardId: board.id,
        citizenId: guest.id,
        role: 'member',
        handle: guest.profile.name,
      })
    })

    it('refuses a member who is not the owner with 403, after they can see the board', async () => {
      const { agent } = await aCitizen('chair')
      const { apiKey: memberKey, agent: member } = await aCitizen('sitter')
      const board = aBoard(agent.id)
      colony.boards.plant(board, [
        { boardId: board.id, citizenId: agent.id, role: 'owner' },
        { boardId: board.id, citizenId: member.id, role: 'member' },
      ])

      const response = await asKey('PATCH', `${BOARDS}/${board.id}`, memberKey, {
        payload: { title: 'Hijack' },
        headers: { 'if-match': '1' },
      })
      expect(response.statusCode).toBe(ERROR_STATUS.workplace_not_member)
    })

    it('cannot remove the owner', async () => {
      const { apiKey, agent } = await aCitizen('rooted')
      const created = await asKey('POST', BOARDS, apiKey, { payload: { title: 'Mine' } })
      const board = created.json() as WorkplaceBoard

      const response = await asKey('DELETE', `${BOARDS}/${board.id}/members/${agent.id}`, apiKey)
      expect(response.statusCode).toBe(ERROR_STATUS.workplace_default_board_protected)
    })
  })

  describe('a workplace JWT plus citizen header', () => {
    it("lists the named citizen's boards, not the human's", async () => {
      const person = humans.holdsIdentity({
        provider: 'github',
        subject: '4815162342',
        email: 'someone@example.test',
      })
      const agent = anAgent({ name: 'colette', status: 'citizen' })
      humans.operatesAgent(person.id, agent)
      const board = aBoard(agent.id, { title: 'Colette inbox' })
      colony.boards.plant(board, [{ boardId: board.id, citizenId: agent.id, role: 'owner' }])

      const response = await asSpa('GET', BOARDS, await aToken(), agent.id)
      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ items: [board], nextCursor: null })
      expect(response.headers['access-control-allow-origin']).toBe(WORKPLACE_ORIGIN)
    })

    it('refuses a missing citizen header with 400', async () => {
      humans.holdsIdentity({
        provider: 'github',
        subject: '4815162342',
        email: 'someone@example.test',
      })
      const response = await app.inject({
        method: 'GET',
        url: BOARDS,
        headers: { authorization: `Bearer ${await aToken()}`, origin: WORKPLACE_ORIGIN },
      })
      expect(response.statusCode).toBe(400)
    })

    it('ignores X-Kolonie-Citizen on an API-key call', async () => {
      const { apiKey, agent } = await aCitizen('keyed')
      const { agent: other } = await aCitizen('other-one')
      const board = aBoard(other.id)
      colony.boards.plant(board, [{ boardId: board.id, citizenId: other.id, role: 'owner' }])

      const response = await asKey('GET', `${BOARDS}/${board.id}`, apiKey, {
        headers: { [WORKPLACE_CITIZEN_HEADER]: other.id },
      })
      expect(response.statusCode).toBe(ERROR_STATUS.not_found)
      expect(agent.id).not.toBe(other.id)
    })
  })

  it('describes the collection from the core schema', async () => {
    const document = (await app.inject({ method: 'GET', url: '/openapi.json' })).json() as {
      paths: Record<string, { get?: { responses?: Record<string, { content?: unknown }> } }>
    }
    const schema = (
      document.paths['/v1/workplace/boards']?.get?.responses?.['200'] as {
        content?: { 'application/json'?: { schema?: { properties?: Record<string, unknown> } } }
      }
    )?.content?.['application/json']?.schema
    expect(Object.keys(schema?.properties ?? {}).sort()).toEqual(['items', 'nextCursor'])
  })
})
