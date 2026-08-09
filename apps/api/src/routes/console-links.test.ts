import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app.js'
import { fakeColony } from '../__fixtures__/colony/index.js'
import { fakeConsole } from '../__fixtures__/console.js'
import { fakeStore } from '../__fixtures__/store.js'
import { fakeHumanStore, fakeTenant, type FakeHumanStore } from '../__fixtures__/humans.js'
import {
  fakeAutonomyMailer,
  fakeAutonomyStore,
  fakeOperatorPages,
} from '../__fixtures__/autonomy.js'
import { fakeOperatorRequests } from '../__fixtures__/operator-requests.js'
import { fakeOperatorNotes } from '../__fixtures__/operator-notes.js'
import { SESSION_COOKIE } from './console.js'
import { OAUTH_STATE_COOKIE } from '../humans/humans.js'

/**
 * **No link the console emits may answer 404** (`#605`).
 *
 * `/funding` sat in the console's navigation for as long as it took somebody to
 * click it: the route was deleted on purpose with the deposit module (`#506`,
 * D-106) and `html.ts` was not told. Measured on the deployment 2026-08-08, the
 * navigation of a page a person reaches **after signing in** carried a dead
 * link — so the first thing the product said to somebody who had just decided to
 * trust it with an account was that a page it offered does not exist.
 *
 * A deletion in one file and a link in another is not a defect anybody can be
 * asked to remember. `#605`: *"a test that fetches every link the console emits
 * and fails on a 404 is the thing that stops this recurring, and it is small."*
 * This is that test.
 *
 * ## It crawls rather than listing
 *
 * A list of the links to check is a second record of what the console renders,
 * and it goes stale in exactly the direction that matters: a link added to a
 * page and not to the list is the case this exists to catch. So the pages are
 * fetched, their `href`s are read out of the rendered HTML, and each one is
 * fetched in turn.
 *
 * ## What it does not do
 *
 * **It does not submit forms.** A `POST` is a state change and a test that fires
 * every one of them signs itself out on the first page. Form targets are checked
 * against the router instead — `hasRoute` answers whether the path is
 * registered, which is the same question a 404 asks and costs no side effect.
 *
 * **It does not follow links off the console.** `kolonie.ai` is a different
 * deployment and reaching it from a unit test would be a network call.
 */
const CONSOLE_URL = 'https://console.example'
const CONSOLE_HOST = 'console.example'

let app: FastifyInstance
let humans: FakeHumanStore

beforeEach(async () => {
  humans = fakeHumanStore()
  const pages = fakeOperatorPages()

  app = buildApp({
    ...fakeColony(),
    store: fakeStore(),
    console: { ...fakeConsole(), consoleUrl: CONSOLE_URL },
    humans: { store: humans, tenant: fakeTenant() },
    autonomy: {
      store: fakeAutonomyStore(),
      pages,
      mailer: fakeAutonomyMailer(),
      formBaseUrl: CONSOLE_URL,
    },
    operatorRequests: fakeOperatorRequests({ pages }),
    operatorNotes: fakeOperatorNotes({ pages }),
  })
  await app.ready()
})

afterEach(async () => {
  await app?.close()
})

const signedInCookie = async (): Promise<string> => {
  const started = await app.inject({
    method: 'GET',
    url: '/sign-in/github',
    headers: { host: CONSOLE_HOST, accept: 'text/html' },
  })
  const state = new URL(started.headers['location'] as string).searchParams.get('state') as string
  const back = await app.inject({
    method: 'GET',
    url: `/sign-in/callback?code=abc&state=${state}`,
    headers: { host: CONSOLE_HOST, accept: 'text/html', cookie: `${OAUTH_STATE_COOKIE}=${state}` },
  })
  const raw = back.headers['set-cookie']
  const all = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw]
  const cookie = all.find((one) => one.startsWith(`${SESSION_COOKIE}=`)) as string
  return cookie.slice(0, cookie.indexOf(';'))
}

/**
 * Every `href` in a document that points somewhere on this console.
 *
 * Absolute URLs to the console's own origin count — the operator flow builds
 * some from `consoleUrl` — and everything else is another deployment's problem.
 * A bare `#`, a `mailto:` and a `data:` are not routes.
 */
const linksIn = (html: string, origin: string): string[] => {
  const found = new Set<string>()
  for (const match of html.matchAll(/href="([^"]+)"/g)) {
    const raw = match[1]
    if (raw === undefined) continue
    const value = raw.replaceAll('&amp;', '&')
    if (value.startsWith('/')) found.add(value)
    else if (value.startsWith(`${origin}/`)) found.add(value.slice(origin.length))
  }
  return [...found]
}

/** Every `action` a form on the page posts to, by the same rule. */
const formActionsIn = (html: string, origin: string): string[] => {
  const found = new Set<string>()
  for (const match of html.matchAll(/action="([^"]+)"/g)) {
    const raw = match[1]
    if (raw === undefined) continue
    const value = raw.replaceAll('&amp;', '&')
    if (value.startsWith('/')) found.add(value)
    else if (value.startsWith(`${origin}/`)) found.add(value.slice(origin.length))
  }
  return [...found]
}

/**
 * The pages a signed-in person can reach with no state beyond a session.
 *
 * The crawl starts here and follows what it finds, so this is a set of doors
 * rather than the set of pages under test. `/` is the one the navigation is on
 * and is the reason the defect was reachable at all.
 */
const DOORS = ['/', '/quests', '/sessions', '/account'] as const

/**
 * A crawl of the signed-in console, breadth-first from {@link DOORS}.
 *
 * Bounded, because a link with a parameter in it can generate a page with
 * another one on it and a test that runs until it stops finding things is a test
 * that hangs when something goes wrong. The bound is stated rather than silent:
 * if it is ever reached, the count is asserted on so the run says so instead of
 * quietly checking a prefix.
 */
const CRAWL_LIMIT = 200

const crawl = async (
  cookie: string,
): Promise<{
  readonly visited: Map<string, number>
  readonly formActions: Set<string>
}> => {
  const visited = new Map<string, number>()
  const formActions = new Set<string>()
  const queue = [...DOORS] as string[]

  while (queue.length > 0 && visited.size < CRAWL_LIMIT) {
    const url = queue.shift() as string
    if (visited.has(url)) continue

    const response = await app.inject({
      method: 'GET',
      url,
      headers: { host: CONSOLE_HOST, accept: 'text/html', cookie },
    })
    visited.set(url, response.statusCode)

    // A redirect names a page too, and a redirect to a deleted page is the same
    // defect one hop further along.
    const location = response.headers['location']
    if (typeof location === 'string' && location.startsWith('/') && !visited.has(location)) {
      queue.push(location)
    }

    const type = response.headers['content-type']
    if (typeof type !== 'string' || !type.includes('text/html')) continue

    for (const link of linksIn(response.body, CONSOLE_URL)) {
      if (!visited.has(link)) queue.push(link)
    }
    for (const action of formActionsIn(response.body, CONSOLE_URL)) formActions.add(action)
  }

  return { visited, formActions }
}

describe('the console emits no link that answers 404', () => {
  it('reaches its own pages and none of them is missing', async () => {
    const cookie = await signedInCookie()
    const { visited } = await crawl(cookie)

    const missing = [...visited].filter(([, status]) => status === 404).map(([url]) => url)
    expect(missing).toEqual([])

    // The crawl actually walked. Without this the assertion above passes for a
    // crawl that fetched nothing, which is the shape a broken harness takes.
    expect(visited.has('/')).toBe(true)
    expect(visited.has('/quests')).toBe(true)
    expect(visited.has('/sessions')).toBe(true)
    expect(visited.size).toBeLessThan(CRAWL_LIMIT)
  })

  it('has a route behind every form it emits', async () => {
    const cookie = await signedInCookie()
    const { formActions } = await crawl(cookie)

    expect(formActions.size).toBeGreaterThan(0)

    /**
     * **`hasRoute` cannot answer this and injecting can.** A form action is a
     * concrete path — `/sessions/<uuid>/end` — and the route behind it is
     * declared with a parameter, so the router's own `hasRoute` reports a
     * registered route as missing. Reconstructing the declared shape from the
     * rendered path means guessing which segment is a parameter, which is the
     * kind of second record this test exists to avoid.
     *
     * So the request is made, and only the one thing this test is about is
     * asserted: **not 404**. A 400 from an empty body, a 302 to the sign-in
     * page, a 403 — all of those mean the route is there, which is the whole
     * question. Nothing here asserts a form *works*; the tests that own each
     * form do that.
     *
     * The state changes this causes are real and deliberately last: the crawl
     * has finished, and `beforeEach` builds a new app for the next test.
     */
    const missing: string[] = []
    for (const action of formActions) {
      const response = await app.inject({
        method: 'POST',
        url: action,
        headers: { host: CONSOLE_HOST, accept: 'text/html', cookie },
      })
      if (response.statusCode === 404) missing.push(action)
    }
    expect(missing).toEqual([])
  })

  /**
   * The specific dead link, named.
   *
   * The crawl above would catch it again, and this is here anyway: a regression
   * that reintroduces `/funding` should fail with the reason rather than with a
   * list of URLs somebody has to read.
   */
  it('offers no Funding page, which was deleted with the deposit module', async () => {
    const cookie = await signedInCookie()
    const { visited } = await crawl(cookie)

    expect([...visited.keys()]).not.toContain('/funding')

    const gone = await app.inject({
      method: 'GET',
      url: '/funding',
      headers: { host: CONSOLE_HOST, accept: 'text/html', cookie },
    })
    expect(gone.statusCode).toBe(404)
  })

  /**
   * The question `/funding` was in the navigation to answer, answered where a
   * person now has it (`#605`).
   *
   * Removing the link and saying nothing would leave *how do I pay for this*
   * with no answer anywhere a sponsor looks.
   */
  it('says on the quests page how a quest is paid for', async () => {
    const cookie = await signedInCookie()
    const response = await app.inject({
      method: 'GET',
      url: '/quests',
      headers: { host: CONSOLE_HOST, accept: 'text/html', cookie },
    })

    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('nothing to top up here')
    expect(response.body).toContain('from a wallet you control')
  })
})
