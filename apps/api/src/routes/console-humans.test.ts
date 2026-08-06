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

describe('a person who is signed in', () => {
  /** Sign in and keep the cookie, which is what every test below needs. */
  const signedInCookie = async (): Promise<string> => {
    const started = await asBrowser('/sign-in/github')
    const state = new URL(started.headers['location'] as string).searchParams.get('state') as string
    const back = await asBrowser(`/sign-in/callback?code=abc&state=${state}`, {
      cookie: `${OAUTH_STATE_COOKIE}=${state}`,
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:129.0) Gecko/20100101 Firefox/129.0',
    })
    const cookie = cookieNamed(back.headers['set-cookie'], SESSION_COOKIE) as string
    return cookie.slice(0, cookie.indexOf(';'))
  }

  let cookie: string

  beforeEach(async () => {
    app = build()
    await app.ready()
    cookie = await signedInCookie()
  })

  const signedIn = (url: string) => asBrowser(url, { cookie })

  const post = (url: string) =>
    app.inject({
      method: 'POST',
      url,
      headers: { host: CONSOLE_HOST, accept: 'text/html', cookie },
    })

  it('lands on a page of their own rather than on the sign-in form', async () => {
    const response = await signedIn('/')

    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('No agents yet')
    expect(response.body).not.toContain('Send a sign-in link')
  })

  it('gets the header on a page a session authorised, and nowhere else', async () => {
    const inside = await signedIn('/')
    const outside = await asBrowser('/')

    expect(inside.body).toContain('class="console-header"')
    expect(inside.body).toContain('action="/sign-out"')
    expect(outside.body).not.toContain('class="console-header"')
  })

  describe('signing out', () => {
    it('ends the session server-side, so replaying the cookie fails', async () => {
      const response = await post('/sign-out')

      expect(response.statusCode).toBe(303)
      expect((await signedIn('/')).body).toContain('Send a sign-in link')
    })

    it('clears the cookie with the attributes that set it', async () => {
      const response = await post('/sign-out')
      const cleared = cookieNamed(response.headers['set-cookie'], SESSION_COOKIE) ?? ''

      // A clearing cookie that differs in any of these writes a second cookie
      // rather than replacing the first, and the browser keeps presenting the
      // old one.
      expect(cleared).toContain('Max-Age=0')
      expect(cleared).toContain('Path=/')
      expect(cleared).toContain('Secure')
      expect(cleared).toContain('HttpOnly')
      expect(cleared).toContain('SameSite=Lax')
    })

    it('answers the same to somebody who was not signed in', async () => {
      await post('/sign-out')

      expect((await post('/sign-out')).statusCode).toBe(303)
    })

    /**
     * A sign-out reachable by `GET` is one anybody can trigger from an image tag
     * on somebody else's page.
     */
    it('is not reachable by following a link', async () => {
      expect((await signedIn('/sign-out')).statusCode).toBe(404)
    })
  })

  describe('the sessions a person holds', () => {
    it('lists them and marks the one being read', async () => {
      const response = await signedIn('/sessions')

      expect(response.statusCode).toBe(200)
      expect(response.body).toContain('this one')
      expect(response.body).toContain('Firefox on Linux')
    })

    it('says the two things ending one does not do', async () => {
      const response = await signedIn('/sessions')

      expect(response.body).toContain('does not sign you out')
      expect(response.body).toContain('operator')
    })

    it('is not a page a stranger can read', async () => {
      const response = await asBrowser('/sessions')

      expect(response.statusCode).toBe(ERROR_STATUS.unauthorized)
      expect(response.body).toContain('Send a sign-in link')
    })

    it('ends one the person named', async () => {
      const second = await humans.openSession(humans.people()[0]!.id, {})
      const [other] = (await humans.listSessions(humans.people()[0]!.id)).filter(
        (session) => session.browser === null,
      )

      const response = await post(`/sessions/${String(other?.id)}/end`)

      expect(response.statusCode).toBe(303)
      expect(await humans.authenticate(second.session)).toEqual({ outcome: 'ended' })
      // And the browser doing the asking is still signed in.
      expect((await signedIn('/')).body).toContain('No agents yet')
    })

    /**
     * The whole authorisation surface of this page: the id comes from the
     * request and is checked against the person in the statement that ends it.
     */
    it('ends nothing when the session named belongs to somebody else', async () => {
      const stranger = await humans.findOrCreate({
        provider: 'github',
        subject: 'somebody-else',
        email: null,
      })
      const theirs = await humans.openSession(stranger.human.id, {})
      const [session] = await humans.listSessions(stranger.human.id)

      await post(`/sessions/${String(session?.id)}/end`)

      expect(await humans.authenticate(theirs.session)).toMatchObject({
        outcome: 'authenticated',
      })
    })

    it('ends every session including the one asking, and says so first', async () => {
      await humans.openSession(humans.people()[0]!.id, {})

      const page = await signedIn('/sessions')
      expect(page.body).toContain('including the one you are reading this in')

      const response = await post('/sessions/end-all')

      expect(response.statusCode).toBe(303)
      expect(await humans.listSessions(humans.people()[0]!.id)).toEqual([])
      expect((await signedIn('/')).body).toContain('Send a sign-in link')
    })
  })
})

describe('the dashboard and the link code', () => {
  const signedInCookie = async (): Promise<string> => {
    const started = await asBrowser('/sign-in/github')
    const state = new URL(started.headers['location'] as string).searchParams.get('state') as string
    const back = await asBrowser(`/sign-in/callback?code=abc&state=${state}`, {
      cookie: `${OAUTH_STATE_COOKIE}=${state}`,
    })
    const cookie = cookieNamed(back.headers['set-cookie'], SESSION_COOKIE) as string
    return cookie.slice(0, cookie.indexOf(';'))
  }

  let cookie: string

  beforeEach(async () => {
    app = build()
    await app.ready()
    cookie = await signedInCookie()
  })

  const signedIn = (url: string) => asBrowser(url, { cookie })

  const post = (url: string, payload?: Record<string, string>) =>
    app.inject({
      method: 'POST',
      url,
      headers: { host: CONSOLE_HOST, accept: 'text/html', cookie },
      ...(payload === undefined ? {} : { payload }),
    })

  /**
   * The half `#427` calls the more important one: a new account has no agents,
   * and this is the moment the whole feature either works or does not.
   */
  it('shows a new account the join prompt rather than an empty table', async () => {
    const response = await signedIn('/')

    expect(response.body).toContain('No agents yet')
    expect(response.body).toContain('kolonie.about')
    expect(response.body).toContain('over MCP')
  })

  it('mints no code until somebody asks for one', async () => {
    const response = await signedIn('/')

    expect(response.body).toContain('Generate a code')
    expect(response.body).not.toContain('TEST-0001')
  })

  it('shows the code once it has been asked for, and keeps showing the same one', async () => {
    await post('/link/code')

    expect((await signedIn('/')).body).toContain('TEST-0001')
    expect((await signedIn('/')).body).toContain('TEST-0001')
  })

  /**
   * **Every time on this page says which clock it is on** (`#461`).
   *
   * The defect was not the offset. `2026-08-06 10:56` was the right instant
   * rendered as if it were the reader's own time, and the expiry line is the one
   * where believing that costs something: a person abandons a live code, or
   * trusts a dead one.
   */
  describe('the times a person reads', () => {
    const inZone = (url: string, zone?: string) =>
      asBrowser(url, { cookie, ...(zone === undefined ? {} : { 'cf-timezone': zone }) })

    it('renders the code’s expiry in the visitor’s zone, named', async () => {
      await post('/link/code')

      const body = (await inZone('/', 'Europe/Berlin')).body

      expect(body).toContain('Europe/Berlin')
    })

    /**
     * **The rejection case.** No header — a request that never went through
     * Cloudflare — must still produce a labelled time rather than a bare number
     * or a thrown page.
     */
    it('falls back to a time labelled UTC when no zone header arrives', async () => {
      await post('/link/code')

      const response = await inZone('/')

      expect(response.statusCode).toBe(200)
      expect(response.body).toContain('UTC')
      expect(response.body).not.toContain('Europe/Berlin')
    })

    /** And a value that is not a zone is treated as no value at all. */
    it('falls back the same way on a nonsense zone', async () => {
      await post('/link/code')

      const response = await inZone('/', 'Europe/Berlyn')

      expect(response.statusCode).toBe(200)
      expect(response.body).toContain('UTC')
    })

    /**
     * The expiry is minutes away on every real visit, and *in -1 hours* is what
     * an interval formatter does when nobody thinks about the sign.
     *
     * **Asserted as "never backwards" rather than as one exact phrase.** The
     * fixture's code expires sixty seconds out, which is precisely the boundary
     * between *in 1 minute* and *just now* — pinning the wording would make this
     * test fail on a slow machine for a reason that is not a defect.
     */
    it('reads a future expiry forwards', async () => {
      await post('/link/code')

      const body = (await inZone('/', 'Europe/Berlin')).body

      expect(body).toMatch(/stops working (in |just now)/)
      expect(body).not.toContain('in -')
      expect(body).not.toMatch(/stops working[^,]*ago/)
    })
  })

  /**
   * The page tells a human to ask for a tool their agent may not be able to see
   * (`#450`).
   *
   * **A citizen was one habit away from telling its operator the tool did not
   * exist.** A client fetches `tools/list` once, at connect, and `#386` closed
   * by having the server stop advertising a change notification it cannot send —
   * so a tool that shipped mid-session is absent from the list rather than
   * stale in it, and from inside the session absent and non-existent look the
   * same.
   *
   * Asserted rather than reviewed by eye because the instruction and the
   * caveat are two lines in one array: deleting the second leaves a page that
   * still reads correctly and sends the next operator down the same path.
   */
  it('tells the operator what to do when the agent reports no such tool', async () => {
    const { body } = await signedIn('/')

    expect(body).toContain('kolonie.operator.link')
    expect(body).toMatch(/tool list is older than the tool/)
    // Both routes out, because the second one needs no reconnect at all.
    expect(body).toMatch(/reconnect/i)
    expect(body).toMatch(/enter the code it gives you/i)
    // The caveat follows the instruction it qualifies rather than preceding it.
    expect(body.indexOf('kolonie.operator.link')).toBeLessThan(
      body.indexOf('tool list is older than the tool'),
    )
  })

  it('links an agent that redeems the person’s code', async () => {
    await post('/link/code')
    const agentId = '11111111-1111-4111-8111-111111111111' as never

    expect(await humans.redeemAsAgent('TEST-0001', agentId)).toMatchObject({ outcome: 'linked' })

    const response = await signedIn('/')
    expect(response.body).toContain('Your agents')
    expect(response.body).not.toContain('No agents yet')
  })

  it('links an agent whose code the person types in', async () => {
    const agentId = '22222222-2222-4222-8222-222222222222' as never
    const issued = await humans.issueCodeForAgent(agentId)

    const response = await post('/link', { code: issued.code })

    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('Linked')
  })

  /**
   * The refusal says nothing about whether the value exists — the same answer
   * for a code nobody issued and for one issued to somebody else.
   */
  it('refuses a code it is not holding without saying whether it exists', async () => {
    const response = await post('/link', { code: 'ZZZZ-ZZZZ' })

    expect(response.statusCode).toBe(ERROR_STATUS.validation_failed)
    expect(response.body).toContain('not one the Colony is holding')
  })

  it('refuses the code this person generated for their own agent to use', async () => {
    await post('/link/code')

    const response = await post('/link', { code: 'TEST-0001' })

    expect(response.body).toContain('theirs to use')
  })

  it('is not a page or a form a stranger can reach', async () => {
    const stranger = await app.inject({
      method: 'POST',
      url: '/link/code',
      headers: { host: CONSOLE_HOST, accept: 'text/html' },
    })

    expect(stranger.statusCode).toBe(ERROR_STATUS.unauthorized)
  })

  /** The dashboard is a window, and the page says so where somebody will read it. */
  it('says that linking is not control of an agent', async () => {
    const response = await signedIn('/')

    expect(response.body).toContain('does not give you control')
    expect(response.body).toContain('deleted only by itself')
  })
})
