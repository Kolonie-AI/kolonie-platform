import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ERROR_STATUS } from '@kolonie-ai/core'
import { buildApp } from '../app.js'
import { fakeColony } from '../__fixtures__/colony/index.js'
import { fakeConsole } from '../__fixtures__/console.js'
import {
  fakeHumanStore,
  fakeTenant,
  refusingTenant,
  type FakeHumanStore,
} from '../__fixtures__/humans.js'
import { SESSION_COOKIE } from './console.js'
import { OAUTH_STATE_COOKIE } from '../humans/humans.js'

/**
 * A person signing in with a provider (`#425`).
 *
 * A documentation domain (RFC 2606) — `AGENTS.md` §3 keeps real host names out
 * of this repository, and a fixture is not an exception.
 */
const CONSOLE_URL = 'https://console.example'
const CONSOLE_HOST = 'console.example'
const API_HOST = 'api.example'

let app: FastifyInstance
let humans: FakeHumanStore

/**
 * The app, with or without a tenant.
 *
 * `withTenant` rather than an optional argument: a default parameter is applied
 * to an explicit `undefined` too, so `build(undefined)` would have quietly built
 * the configured app and the unconfigured case would have tested nothing.
 */
const build = (withTenant = true) => {
  humans = fakeHumanStore()
  return buildApp({
    ...fakeColony(),
    console: { ...fakeConsole(), consoleUrl: CONSOLE_URL },
    humans: { store: humans, ...(withTenant ? { tenant: fakeTenant() } : {}) },
  })
}

const asBrowser = (url: string, headers: Record<string, string> = {}) =>
  app.inject({
    method: 'GET',
    url,
    headers: { host: CONSOLE_HOST, accept: 'text/html,application/xhtml+xml', ...headers },
  })

/** Every `Set-Cookie` on a reply, whether Fastify handed back one or many. */
const cookies = (raw: string | string[] | undefined): string[] =>
  raw === undefined ? [] : Array.isArray(raw) ? raw : [raw]

const cookieNamed = (raw: string | string[] | undefined, name: string): string | undefined =>
  cookies(raw).find((cookie) => cookie.startsWith(`${name}=`))

afterEach(async () => {
  await app.close()
})

describe('signing in as a person', () => {
  beforeEach(async () => {
    app = build()
    await app.ready()
  })

  describe('the way out', () => {
    it('redirects to the provider and remembers the state in a cookie', async () => {
      const response = await asBrowser('/sign-in/github')

      expect(response.statusCode).toBe(303)
      const location = response.headers['location'] as string
      const state = cookieNamed(response.headers['set-cookie'], OAUTH_STATE_COOKIE)

      expect(location).toContain('connection=github')
      expect(state).toBeDefined()
      // The value in the cookie is the value in the URL: the whole point of it.
      expect(location).toContain(new URL(location).searchParams.get('state') as string)
      expect(state).toContain(new URL(location).searchParams.get('state') as string)
    })

    /**
     * `__Host-` and `SameSite=Lax`, because both are load-bearing: the prefix
     * keeps a sibling host from writing this browser a state of its choosing,
     * and `Lax` is what survives the top-level redirect back.
     */
    it('writes the state cookie with the attributes it depends on', async () => {
      const response = await asBrowser('/sign-in/github')
      const state = cookieNamed(response.headers['set-cookie'], OAUTH_STATE_COOKIE) ?? ''

      expect(state).toContain('Path=/')
      expect(state).toContain('Secure')
      expect(state).toContain('HttpOnly')
      expect(state).toContain('SameSite=Lax')
    })

    it('offers no door this build does not know', async () => {
      expect((await asBrowser('/sign-in/myspace')).statusCode).toBe(404)
    })

    it('is not served on the API host, like every other console path', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/sign-in/github',
        headers: { host: API_HOST, accept: 'text/html' },
      })

      expect(response.statusCode).toBe(404)
    })
  })

  describe('the way back', () => {
    const signIn = async () => {
      const started = await asBrowser('/sign-in/github')
      const state = new URL(started.headers['location'] as string).searchParams.get(
        'state',
      ) as string
      return await asBrowser(`/sign-in/callback?code=abc&state=${state}`, {
        cookie: `${OAUTH_STATE_COOKIE}=${state}`,
      })
    }

    it('creates the account, issues a session and sends the browser to the console', async () => {
      const response = await signIn()

      expect(response.statusCode).toBe(303)
      expect(response.headers['location']).toBe('/')
      expect(humans.people()).toHaveLength(1)
      expect(cookieNamed(response.headers['set-cookie'], SESSION_COOKIE)).toBeDefined()
    })

    it('signs the same person in again rather than making a second account', async () => {
      await signIn()
      await signIn()

      expect(humans.people()).toHaveLength(1)
    })

    it('clears the handover cookie on the way through', async () => {
      const response = await signIn()
      const state = cookieNamed(response.headers['set-cookie'], OAUTH_STATE_COOKIE) ?? ''

      expect(state).toContain('Max-Age=0')
    })

    /**
     * The rejection case this route exists to have: a callback prepared
     * elsewhere and delivered to this browser. Without the state check it signs
     * this person into somebody else's account.
     */
    it('refuses a callback that did not start in this browser', async () => {
      const response = await asBrowser('/sign-in/callback?code=abc&state=someone-elses')

      expect(response.statusCode).toBe(ERROR_STATUS.validation_failed)
      expect(humans.people()).toHaveLength(0)
      expect(cookieNamed(response.headers['set-cookie'], SESSION_COOKIE)).toBeUndefined()
    })

    it('refuses a state that does not match the cookie it was given', async () => {
      const started = await asBrowser('/sign-in/github')
      const state = new URL(started.headers['location'] as string).searchParams.get(
        'state',
      ) as string

      const response = await asBrowser(`/sign-in/callback?code=abc&state=${state}x`, {
        cookie: `${OAUTH_STATE_COOKIE}=${state}`,
      })

      expect(response.statusCode).toBe(ERROR_STATUS.validation_failed)
      expect(humans.people()).toHaveLength(0)
    })

    it('refuses a callback carrying no code at all', async () => {
      const started = await asBrowser('/sign-in/github')
      const state = new URL(started.headers['location'] as string).searchParams.get(
        'state',
      ) as string

      const response = await asBrowser(`/sign-in/callback?error=access_denied&state=${state}`, {
        cookie: `${OAUTH_STATE_COOKIE}=${state}`,
      })

      expect(response.statusCode).toBe(ERROR_STATUS.validation_failed)
      expect(humans.people()).toHaveLength(0)
    })

    /** A replayed code, an expired one and an unknown one look identical here. */
    it('refuses when the provider will not confirm the code', async () => {
      app = buildApp({
        ...fakeColony(),
        console: { ...fakeConsole(), consoleUrl: CONSOLE_URL },
        humans: { store: (humans = fakeHumanStore()), tenant: refusingTenant() },
      })
      await app.ready()

      const started = await asBrowser('/sign-in/github')
      const state = new URL(started.headers['location'] as string).searchParams.get(
        'state',
      ) as string
      const response = await asBrowser(`/sign-in/callback?code=abc&state=${state}`, {
        cookie: `${OAUTH_STATE_COOKIE}=${state}`,
      })

      expect(response.statusCode).toBe(ERROR_STATUS.validation_failed)
      expect(humans.people()).toHaveLength(0)
    })

    /**
     * The session value goes into one `Set-Cookie` and nowhere else — the rule
     * `console.ts` states for the agent's session, which this route now shares.
     */
    it('puts the session in a cookie and never in the body', async () => {
      const response = await signIn()
      const issued = humans.sessions()[0] as string

      expect(response.body).not.toContain(issued)
      expect(response.headers['location']).not.toContain(issued)
    })

    it('records the browser family and never the user-agent string', async () => {
      const started = await asBrowser('/sign-in/github')
      const state = new URL(started.headers['location'] as string).searchParams.get(
        'state',
      ) as string
      await asBrowser(`/sign-in/callback?code=abc&state=${state}`, {
        cookie: `${OAUTH_STATE_COOKIE}=${state}`,
        'user-agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:129.0) Gecko/20100101 Firefox/129.0',
        'cf-ipcountry': 'de',
      })

      const person = humans.people()[0]
      if (person === undefined) throw new Error('nobody was signed in')
      const [session] = await humans.listSessions(person.id)

      expect(session?.browser).toBe('Firefox on Linux')
      expect(session?.location).toBe('DE')
    })
  })

  describe('the page', () => {
    it('offers the door when a tenant is configured', async () => {
      const response = await asBrowser('/')

      expect(response.body).toContain('/sign-in/github')
      expect(response.body).toContain('Continue with GitHub')
    })

    /**
     * And says the thing a reader of this page cannot be expected to know: an
     * account is not a citizen. Finding that out afterwards reads as the Colony
     * having lost something.
     */
    it('says that a person’s account is not a citizen', async () => {
      const response = await asBrowser('/')

      expect(response.body).toContain('is not a citizen')
    })

    it('keeps the mail link, which is the door for somebody with neither', async () => {
      const response = await asBrowser('/')

      expect(response.body).toContain('action="/sign-in"')
    })
  })
})

describe('a deployment with no tenant configured', () => {
  beforeEach(async () => {
    app = build(false)
    await app.ready()
  })

  it('offers no provider door at all', async () => {
    const response = await asBrowser('/')

    expect(response.body).not.toContain('/sign-in/github')
    expect(response.body).toContain('action="/sign-in"')
  })

  it('answers the redirect route exactly as it did before the feature existed', async () => {
    expect((await asBrowser('/sign-in/github')).statusCode).toBe(404)
    expect((await asBrowser('/sign-in/callback?code=a&state=b')).statusCode).toBe(404)
  })
})
