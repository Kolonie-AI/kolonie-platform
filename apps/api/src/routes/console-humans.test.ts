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
  type FakeTenant,
} from '../__fixtures__/humans.js'
import type { FakeStandingHints } from '../__fixtures__/hints.js'
import { SESSION_COOKIE } from './console.js'
import { OAUTH_CONNECT_COOKIE, OAUTH_STATE_COOKIE } from '../humans/humans.js'

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
let hints: FakeStandingHints

/**
 * The app, with or without a tenant.
 *
 * `withTenant` rather than an optional argument: a default parameter is applied
 * to an explicit `undefined` too, so `build(undefined)` would have quietly built
 * the configured app and the unconfigured case would have tested nothing.
 */
const build = (withTenant = true) => {
  humans = fakeHumanStore()
  const colony = fakeColony()
  // Kept rather than spread and forgotten (`#512`): the fleet's *waiting on*
  // column reads through this, and the tests for it need both to set the answer
  // and to assert that nothing was spent.
  hints = colony.hints as FakeStandingHints
  return buildApp({
    ...colony,
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
    it('offers the doors when a tenant is configured', async () => {
      const response = await asBrowser('/')

      expect(response.body).toContain('/sign-in/github')
      expect(response.body).toContain('Continue with GitHub')
      expect(response.body).toContain('/sign-in/google')
      expect(response.body).toContain('Continue with Google')
    })

    /**
     * The assertion `#568` is actually about, and it is a negative one: GitHub
     * is a developer's login, and an operator is not always a developer. A page
     * offering a second door still fails this issue if the sentence beside the
     * buttons says the first one is how you get in.
     */
    it('names no provider as *the* way in', async () => {
      const response = await asBrowser('/')

      expect(response.body).not.toMatch(/sign in (?:to the console )?with GitHub/i)
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
      const stranger = humans.holdsIdentity({
        provider: 'github',
        subject: 'somebody-else',
        email: null,
      })
      const theirs = await humans.openSession(stranger.id, {})
      const [session] = await humans.listSessions(stranger.id)

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

/**
 * The identity a person writes quests through (`#455`).
 *
 * **It is created the first time they need one and never before.** A population
 * of empty `agents` rows made by people who signed in to look around changes
 * what every citizen figure on the Colony's own website means, and it costs the
 * person nothing to create it while they are already in a form.
 */
describe('the identity a person writes quests through', () => {
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

  const draft = (form: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url: '/quests',
      headers: {
        host: CONSOLE_HOST,
        accept: 'text/html',
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams({
        title: 'A thousand registrations',
        description: 'What this quest is, for a human reading the catalogue.',
        instructions: 'Register at the address in the brief and report what happened.',
        questions: JSON.stringify([{ key: 'went-well', prompt: 'How did it go?', required: true }]),
        slots: '10',
        rewardCredits: '0',
        expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10),
        minReputation: '0',
        audience: 'citizens',
        proofVerifier: 'email-inbox',
        ...form,
      }).toString(),
    })

  const theirs = async () => {
    const [human] = humans.people()
    return human === undefined ? undefined : await humans.sponsorAgent(human.id)
  }

  /**
   * **The rejection case the issue asks for.** Signing in is not needing one,
   * and neither is reading the dashboard.
   */
  it('creates nothing by signing in', async () => {
    expect(await theirs()).toBeUndefined()
  })

  it('creates nothing by visiting the console', async () => {
    await signedIn('/')

    expect(await theirs()).toBeUndefined()
  })

  /**
   * **A form is a page somebody can leave.** Opening it creates no row, and the
   * balance it shows is zero — which is true, because there is no identity and
   * therefore nothing on account.
   */
  it('creates nothing by opening the quest form, and still renders it', async () => {
    const response = await signedIn('/quests/new')

    expect(response.statusCode).toBe(200)
    expect(await theirs()).toBeUndefined()
  })

  it('creates it on the first draft', async () => {
    expect(await theirs()).toBeUndefined()

    await draft()

    expect(await theirs()).toBeDefined()
  })

  /** *Exactly one per human.* The second draft reuses what the first made. */
  it('reuses it on the second', async () => {
    await draft({ title: 'The first' })
    const first = await theirs()

    await draft({ title: 'The second' })

    expect((await theirs())?.id).toBe(first?.id)
  })

  /**
   * **It is not invisible.** An identity that holds a balance and owns quests
   * and appears in no list is the shape `governance/red-lines.md` describes when
   * it refuses *"accounts created to deceive about who is behind them"* — not
   * because anybody here intends that, but because nobody can tell from outside.
   */
  it('appears in the dashboard afterwards, called You', async () => {
    const before = (await signedIn('/')).body
    expect(before).not.toContain('>You<')

    await draft()

    expect((await signedIn('/')).body).toContain('>You<')
  })

  /** And it is one row among the person's agents, not a list of its own. */
  it('is an ordinary row beside the agents they operate', async () => {
    await draft()
    const agentId = '44444444-4444-4444-8444-444444444444' as never
    await app.inject({
      method: 'POST',
      url: '/link/code',
      headers: { host: CONSOLE_HOST, accept: 'text/html', cookie },
    })
    await humans.redeemAsAgent('TEST-0001', agentId)

    const body = (await signedIn('/')).body

    expect(body).toContain('>You<')
    expect(body).toContain(`href="/agents/${agentId}"`)
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

  /**
   * **The obvious gesture now does something** (`#451`).
   *
   * `dashboardPage` used to carry a comment explaining that a name was not a
   * link because `#428` had not landed and a dead call to action would be worse
   * than plain text. `#428` landed, and the code had not been told.
   */
  describe('a name on the dashboard opens the agent', () => {
    const agentId = '33333333-3333-4333-8333-333333333333' as never

    beforeEach(async () => {
      await post('/link/code')
      await humans.redeemAsAgent('TEST-0001', agentId)
    })

    it('links the name to the agent’s own page', async () => {
      const body = (await signedIn('/')).body

      expect(body).toContain(`href="/agents/${agentId}"`)
    })

    /**
     * **It must not read as a handle on the agent.** The dashboard's own rule —
     * *a window rather than a control panel* — is what a clickable name is most
     * likely to make somebody doubt, so it stays on the page and the row says
     * *open* rather than *manage*.
     */
    it('still says what linking does not give you', async () => {
      const body = (await signedIn('/')).body

      expect(body).toContain('a window rather than a control panel')
      expect(body).toContain('Open one to read how it is getting on')
      expect(body).not.toContain('Manage')
    })

    /** And the link is worth nothing without the session it was rendered behind. */
    it('is not reachable without a session', async () => {
      const response = await asBrowser(`/agents/${agentId}/operator`)

      expect(response.statusCode).toBe(404)
    })
  })

  /**
   * The fleet (`#512`). An operator with twelve agents could read about them one
   * at a time; what it could not answer at all is *which of them is waiting on
   * something I can fix*, and that is the column that earns the page.
   */
  describe('reading the whole fleet at once', () => {
    const agentId = '44444444-4444-4444-8444-444444444444' as never

    beforeEach(async () => {
      await post('/link/code')
      await humans.redeemAsAgent('TEST-0001', agentId)
    })

    it('draws the runtime, the model, what it last earned and when it last woke', async () => {
      const body = (await signedIn('/')).body

      expect(body).toContain('<th>Runtime</th>')
      expect(body).toContain('<th>Model</th>')
      expect(body).toContain('<th>Last earned</th>')
      expect(body).toContain('<th>Last awake</th>')
    })

    /**
     * **Zeros and nevers are drawn rather than hidden** (`#423`, restated by
     * `#512`): hiding an agent with nothing means the operator most likely to
     * switch something off sees the least.
     */
    it('draws an agent that has declared nothing and earned nothing', async () => {
      const body = (await signedIn('/')).body

      expect(body).toContain('not declared')
      expect(body).toContain('nothing yet')
      expect(body).toContain('never')
    })

    it('shows what each agent is waiting on', async () => {
      hints.faces('rhythm-undeclared')

      const body = (await signedIn('/')).body

      expect(body).toContain('<th>Waiting on</th>')
      expect(body).toContain('rhythm-undeclared')
    })

    /**
     * **The page must not consume the agent's one line.** It reads through
     * `facing`, which claims nothing; `due` is the MCP guard's and has exactly
     * one caller. A page that spent the slot would silence the agent's own
     * channel every time its operator refreshed a browser tab.
     */
    it('spends nothing the agent was going to be told', async () => {
      hints.faces('rhythm-undeclared')
      hints.answers('rhythm-undeclared')

      await signedIn('/')
      await signedIn('/')

      // `asked` records the calls to `due`, which is the one that spends.
      expect(hints.asked()).toEqual([])
    })

    /**
     * **Not a control panel, and no league table** (`#512`). Both refusals are
     * on the page in words, because the next person to open this file will be
     * adding a column and these are the two they would add.
     */
    it('says outright that it drives nothing and ranks nothing', async () => {
      const body = (await signedIn('/')).body

      expect(body).toMatch(/nothing here to start, stop, configure or instruct/i)
      expect(body).toMatch(/not a league table/i)
    })
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

/**
 * **A second door onto one account** (`#574`).
 *
 * The schema was shaped for this — *"a person who signs in with GitHub today
 * and Google tomorrow is one person"* — and nothing ever wrote the second
 * identity, so they were two. These are the seams where being wrong hands over
 * an account, so each is a route test rather than a reading of the storage.
 */
describe('attaching a second provider', () => {
  let tenant: FakeTenant

  /**
   * One tenant that can answer differently, rather than two apps.
   *
   * A second door is a different identity from the same tenant. Rebuilding the
   * app around a second `fakeTenant` would throw the store away with it, so the
   * person who just signed in would stop existing — and every assertion about
   * *one account, two doors* would be about two empty stores.
   */
  beforeEach(async () => {
    humans = fakeHumanStore()
    const colony = fakeColony()
    hints = colony.hints as FakeStandingHints
    tenant = fakeTenant({ provider: 'github', subject: 'first', email: 'one@example.test' })
    app = buildApp({
      ...colony,
      console: { ...fakeConsole(), consoleUrl: CONSOLE_URL },
      humans: { store: humans, tenant },
    })
    await app.ready()
  })

  /** Sign in through the front door and keep the session cookie handed back. */
  const signedInSession = async (): Promise<string> => {
    const started = await asBrowser('/sign-in/github')
    const state = new URL(started.headers['location'] as string).searchParams.get('state') as string
    const back = await asBrowser(`/sign-in/callback?code=abc&state=${state}`, {
      cookie: `${OAUTH_STATE_COOKIE}=${state}`,
    })
    const session = cookieNamed(back.headers['set-cookie'], SESSION_COOKIE) as string
    return session.split(';')[0] as string
  }

  const startConnect = async (session: string) => {
    const started = await app.inject({
      method: 'POST',
      url: '/account/connect/github',
      headers: { host: CONSOLE_HOST, accept: 'text/html', cookie: session },
    })
    return new URL(started.headers['location'] as string).searchParams.get('state') as string
  }

  describe('starting it', () => {
    /**
     * **A `POST`, and that is a security property rather than a convention.**
     * Signing in cannot be done *to* somebody; attaching an identity to their
     * account can, so a `GET` here would be a state change any third-party page
     * could trigger by embedding a link.
     */
    it('is not reachable with a GET', async () => {
      const session = await signedInSession()

      const response = await app.inject({
        method: 'GET',
        url: '/account/connect/github',
        headers: { host: CONSOLE_HOST, accept: 'text/html', cookie: session },
      })

      expect(response.statusCode).toBe(404)
    })

    it('refuses a stranger, before sending them to a provider at all', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/account/connect/github',
        headers: { host: CONSOLE_HOST, accept: 'text/html' },
      })

      expect(response.statusCode).toBe(ERROR_STATUS.unauthorized)
      expect(response.headers['location']).toBeUndefined()
    })

    /**
     * **A cookie of its own**, which is what lets one callback tell the two
     * handovers apart. A callback that cannot is a callback that attaches an
     * identity to whoever is holding the browser.
     */
    it('remembers the state under a name of its own, not the sign-in one', async () => {
      const session = await signedInSession()

      const response = await app.inject({
        method: 'POST',
        url: '/account/connect/github',
        headers: { host: CONSOLE_HOST, accept: 'text/html', cookie: session },
      })

      expect(response.statusCode).toBe(303)
      expect(cookieNamed(response.headers['set-cookie'], OAUTH_CONNECT_COOKIE)).toBeDefined()
      expect(cookieNamed(response.headers['set-cookie'], OAUTH_STATE_COOKIE)).toBeUndefined()
    })

    it('offers no door this build does not know', async () => {
      const session = await signedInSession()

      const response = await app.inject({
        method: 'POST',
        url: '/account/connect/myspace',
        headers: { host: CONSOLE_HOST, accept: 'text/html', cookie: session },
      })

      expect(response.statusCode).toBe(404)
    })
  })

  describe('coming back', () => {
    it('attaches the identity, and either door then reaches the same person', async () => {
      const session = await signedInSession()
      const before = humans.people().length

      tenant.answersWith({ provider: 'google', subject: 'second', email: 'two@example.test' })
      const state = await startConnect(session)
      const response = await asBrowser(`/sign-in/callback?code=abc&state=${state}`, {
        cookie: `${session}; ${OAUTH_CONNECT_COOKIE}=${state}`,
      })

      expect(response.statusCode).toBe(303)
      expect(response.headers['location']).toBe('/account?connected=attached')
      // One account, not two.
      expect(humans.people()).toHaveLength(before)
      expect(humans.people()[0]?.identities).toHaveLength(2)
    })

    it('is a no-op that says so when they already hold it', async () => {
      const session = await signedInSession()

      const state = await startConnect(session)
      const response = await asBrowser(`/sign-in/callback?code=abc&state=${state}`, {
        cookie: `${session}; ${OAUTH_CONNECT_COOKIE}=${state}`,
      })

      expect(response.headers['location']).toBe('/account?connected=already-theirs')
      expect(humans.people()[0]?.identities).toHaveLength(1)
    })

    /**
     * **The branch where being wrong hands over an account.** Neither account is
     * touched, and this session survives — the person did nothing wrong, and
     * signing them out would read as a punishment for a mistake.
     */
    it('refuses an identity that belongs to somebody else, and keeps the session', async () => {
      const session = await signedInSession()
      const stranger = humans.holdsIdentity({
        provider: 'google',
        subject: 'theirs',
        email: 'theirs@example.test',
      })

      tenant.answersWith({ provider: 'google', subject: 'theirs', email: 'theirs@example.test' })
      const state = await startConnect(session)
      const response = await asBrowser(`/sign-in/callback?code=abc&state=${state}`, {
        cookie: `${session}; ${OAUTH_CONNECT_COOKIE}=${state}`,
      })

      expect(response.headers['location']).toBe('/account?connected=taken')
      expect(humans.people()[0]?.identities).toHaveLength(1)
      expect(stranger.identities).toHaveLength(1)
      // The session is untouched: the account page still answers.
      expect((await asBrowser('/account', { cookie: session })).statusCode).toBe(200)
    })

    /**
     * **The session is re-read on the way back, not trusted from the way out.**
     * `#574` names this: a person may sign out, or the session may expire, while
     * they are at the provider. Nothing is attached.
     */
    it('attaches nothing when the session ended mid-flight', async () => {
      const session = await signedInSession()
      const state = await startConnect(session)

      const response = await asBrowser(`/sign-in/callback?code=abc&state=${state}`, {
        cookie: `${OAUTH_CONNECT_COOKIE}=${state}`,
      })

      expect(response.statusCode).toBe(ERROR_STATUS.validation_failed)
      expect(response.body).toContain('was not made')
      expect(humans.people()[0]?.identities).toHaveLength(1)
    })

    it('refuses a state that did not start in this browser', async () => {
      const session = await signedInSession()
      await startConnect(session)

      const response = await asBrowser('/sign-in/callback?code=abc&state=somebody-elses', {
        cookie: `${session}; ${OAUTH_CONNECT_COOKIE}=mine`,
      })

      expect(response.statusCode).toBe(ERROR_STATUS.validation_failed)
      expect(humans.people()[0]?.identities).toHaveLength(1)
    })
  })

  /**
   * **The automatic path**: an unknown identity whose verified address already
   * reaches exactly one person attaches to them, and more than one is refused
   * with nothing written.
   */
  describe('arriving with an address the Colony already knows', () => {
    it('signs them into the account that address reaches, without a second one', async () => {
      await signedInSession()

      tenant.answersWith({ provider: 'google', subject: 'second', email: 'one@example.test' })
      const session = await signedInSession()

      expect(humans.people()).toHaveLength(1)
      expect(humans.people()[0]?.identities).toHaveLength(2)

      const page = await asBrowser('/account', { cookie: session })
      expect(page.statusCode).toBe(200)
      expect(page.body).toContain('How you sign in')
      expect(page.body).toContain('google')
    })

    it('refuses, signs nobody in and writes nothing when it reaches two', async () => {
      await signedInSession()
      humans.holdsIdentity({ provider: 'apple', subject: 'other', email: 'one@example.test' })
      const before = humans.people().length

      tenant.answersWith({ provider: 'google', subject: 'third', email: 'one@example.test' })
      const started = await asBrowser('/sign-in/github')
      const state = new URL(started.headers['location'] as string).searchParams.get(
        'state',
      ) as string
      const response = await asBrowser(`/sign-in/callback?code=abc&state=${state}`, {
        cookie: `${OAUTH_STATE_COOKIE}=${state}`,
      })

      expect(response.statusCode).toBe(ERROR_STATUS.validation_failed)
      expect(response.body).toContain('more than one account')
      expect(cookieNamed(response.headers['set-cookie'], SESSION_COOKIE)).toBeUndefined()
      expect(humans.people()).toHaveLength(before)
    })

    /**
     * **`null` is not a match**, and this is `#426`'s private-GitHub-address
     * case: two people who both hold no address are not each other.
     */
    it('creates an account for an identity with no address', async () => {
      await signedInSession()

      tenant.answersWith({ provider: 'google', subject: 'fourth', email: null })
      await signedInSession()

      expect(humans.people()).toHaveLength(2)
    })
  })
})
