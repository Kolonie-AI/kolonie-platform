import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose'
import type { JWK, JWTVerifyGetKey, KeyObject } from 'jose'
import { ERROR_STATUS } from '@kolonie-ai/core'
import { buildApp } from '../app.js'
import { fakeColony } from '../__fixtures__/colony/index.js'
import { fakeHumanStore, type FakeHumanStore } from '../__fixtures__/humans.js'
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

/** The `sub` a tenant mints: `<strategy>|<subject>`, as `auth0.ts` records. */
const SUBJECT = 'github|4815162342'

let app: FastifyInstance
let humans: FakeHumanStore

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
  const colony = fakeColony()
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
      }
      expect(body.human.identities).toEqual([{ provider: 'github', subject: '4815162342' }])
      expect(body.human.id).toEqual(expect.any(String))
    })

    /**
     * **A first workplace arrival lands on the shared arrival path**, which is
     * the console's own, rather than on one of this door's making.
     *
     * The assertion is that the console afterwards finds *that* person: a door
     * that wrote a SPA-shaped human would also answer `200` here, and only
     * arriving through the other door can tell the two apart. Whether such a
     * person may be created at all is the tenant's decision rather than this
     * route's — it mints a token for whoever it signed in, and both doors take
     * the same answer, which is the whole of *no SPA-specific human identity*.
     */
    it('puts a first arrival on the one human the console also resolves', async () => {
      const first = await asWorkplace(await aToken())
      expect(first.statusCode).toBe(200)

      const throughTheConsole = await humans.findOrCreate({
        provider: 'github',
        subject: '4815162342',
        email: null,
      })

      expect(throughTheConsole.outcome).toBe('returning')
      expect(String(throughTheConsole.human?.id)).toBe(
        (first.json() as { human: { id: string } }).human.id,
      )
      expect(humans.people()).toHaveLength(1)
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
     * No issuer, no audience, no origin: no route. A `401` here would read as
     * *your token is wrong* about a door that was never built.
     */
    it('serves no workplace route at all', async () => {
      expect(app.hasRoute({ method: 'GET', url: ME })).toBe(false)
      expect((await asWorkplace(await aToken())).statusCode).toBe(ERROR_STATUS.not_found)
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
