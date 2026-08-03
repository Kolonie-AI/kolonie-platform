import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fakeDepositDependencies, fakeDeposits } from '../__fixtures__/deposits.js'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app.js'
import { fakeRegistry } from '../__fixtures__/registry.js'
import { fakeStore, type FakeStore } from '../__fixtures__/store.js'
import { fakeCatalogue } from '../__fixtures__/catalogue.js'
import { fakeQuests, type FakeQuestDesk } from '../__fixtures__/quests.js'
import { fakeSubmissions } from '../__fixtures__/submissions.js'
import { fakeGuidance } from '../__fixtures__/guidance.js'
import { fakeSupportDesk } from '../__fixtures__/support.js'
import { support } from '../support.js'
import { fakeAcademy } from '../__fixtures__/academy.js'
import { fakeEmail } from '../__fixtures__/email.js'
import { fakeKeyChallenges } from '../__fixtures__/keys.js'
import { fakeGithub, fakeContributions } from '../__fixtures__/github.js'
import { fakeWakeup } from '../__fixtures__/wakeup.js'
import { fakeOperatorClaim } from '../__fixtures__/operator-claim.js'
import { fakeSocial } from '../__fixtures__/social.js'
import { fakeDomain } from '../__fixtures__/domain.js'
import { fakeWebsite } from '../__fixtures__/website.js'
import { fakeImage } from '../__fixtures__/image.js'
import { fakeScene } from '../__fixtures__/scene.js'
import { fakeInjection } from '../__fixtures__/injection.js'
import { fakeVision } from '../__fixtures__/vision.js'
import { fakePow } from '../__fixtures__/proof-of-work.js'
import { fakeSolana } from '../__fixtures__/solana.js'
import { fakeVault } from '../__fixtures__/vault.js'
import { fakeAccounts } from '../__fixtures__/accounts.js'
import { fakeConsole } from '../__fixtures__/console.js'
import { fakeErasureDesk } from '../__fixtures__/erasure.js'
import { erasure } from '../erasure.js'
import { noObstruction } from '../__fixtures__/obstruction.js'
import { consoleHost, wantsHtml } from './console-pages.js'
import { CONSOLE_HEADERS, escape } from '../console/html.js'

/**
 * The host the console answers on, in this test.
 *
 * A documentation domain (RFC 2606), so nothing here is a real host —
 * `AGENTS.md` §3 keeps those out of the repository, and a fixture is not an
 * exception.
 */
const CONSOLE_URL = 'https://console.example'
const CONSOLE_HOST = 'console.example'
const API_HOST = 'api.example'

let app: FastifyInstance
let store: FakeStore
let quests: FakeQuestDesk
let apiKey: string
let session: string
let agentId: string

beforeEach(async () => {
  store = fakeStore()
  quests = fakeQuests()
  app = buildApp({
    vault: { vault: fakeVault() },
    accounts: fakeAccounts(),
    console: { ...fakeConsole(), consoleUrl: CONSOLE_URL },
    email: fakeEmail(),
    registry: fakeRegistry(),
    store,
    catalogue: fakeCatalogue(),
    quests,
    deposits: fakeDepositDependencies(fakeDeposits()),
    submissions: fakeSubmissions(),
    guidance: fakeGuidance(),
    support: support({ desk: fakeSupportDesk() }),
    erasure: erasure({ desk: fakeErasureDesk() }),
    retesting: { reset: async () => ({ outcome: 'not-a-tester' as const }) },
    keys: { challenges: fakeKeyChallenges(), obstruction: noObstruction },
    solana: fakeSolana(),
    pow: fakePow(),
    vision: fakeVision(),
    github: fakeGithub(),
    contributions: fakeContributions(),
    wakeup: fakeWakeup(),
    social: fakeSocial(),
    operatorClaim: fakeOperatorClaim(),
    domain: fakeDomain(),
    website: fakeWebsite(),
    image: fakeImage(),
    scene: fakeScene(),
    injection: fakeInjection(),
    academy: fakeAcademy(),
  })
  await app.ready()

  const issued = store.issue({})
  apiKey = String(issued.apiKey)
  agentId = String(issued.agent.id)
  session = 'session-value-for-the-console'
  store.signIn(issued.agent.id, session)
})

afterEach(async () => {
  await app.close()
})

/** A browser: prefers HTML, carries a cookie, sends no bearer token. */
const asBrowser = (url: string, options: { readonly signedIn?: boolean } = {}) =>
  app.inject({
    method: 'GET',
    url,
    headers: {
      host: CONSOLE_HOST,
      accept: 'text/html,application/xhtml+xml',
      ...(options.signedIn === true && { cookie: `__Host-kolonie_session=${session}` }),
    },
  })

/** An agent: an API key, and JSON. */
const asAgent = (url: string) =>
  app.inject({
    method: 'GET',
    url,
    headers: { host: CONSOLE_HOST, accept: 'application/json', authorization: `Bearer ${apiKey}` },
  })

describe('the console surface', () => {
  it('answers on its own host and nowhere else', async () => {
    const onConsole = await asBrowser('/')
    const onApi = await app.inject({
      method: 'GET',
      url: '/',
      headers: { host: API_HOST, accept: 'text/html' },
    })

    expect(onConsole.statusCode).toBe(200)
    expect(onConsole.body).toContain('Sign in')
    // The API's own host still answers as it always did: a 404 that names the
    // REST prefix rather than a sign-in page.
    expect(onApi.statusCode).toBe(404)
    expect(onApi.json().message).toContain('/v1')
  })

  it('leaves the existing API routes unmoved', async () => {
    const index = await app.inject({
      method: 'GET',
      url: '/v1/',
      headers: { host: API_HOST },
    })

    expect(index.statusCode).toBe(200)
    expect(index.json().version).toBe('v1')
  })

  it('serves one route as HTML to a browser and JSON to an agent', async () => {
    quests.credit(agentId as never, 1_000_000)
    await quests.create({
      authorId: agentId as never,
      draft: {
        title: 'A thousand registrations',
        description: 'We want to know whether agents can register.',
        instructions: 'Register and report.',
        reward: { credits: 0, reputation: 5 },
        slots: 10,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        questions: [{ key: 'what-happened', prompt: 'What happened?' }],
      },
    })

    const browser = await asBrowser('/', { signedIn: true })
    const agent = await asAgent('/')

    // The same underlying data, in two representations.
    expect(browser.headers['content-type']).toContain('text/html')
    expect(browser.body).toContain('A thousand registrations')
    expect(agent.headers['content-type']).toContain('application/json')
    expect(agent.json().quests[0].title).toBe('A thousand registrations')
    expect(agent.json().signedIn).toBe(true)
  })

  it('gives an agent that sends no Accept the JSON, never a page', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/',
      headers: { host: CONSOLE_HOST, authorization: `Bearer ${apiKey}` },
    })

    expect(response.headers['content-type']).toContain('application/json')
    expect(wantsHtml({ headers: {} })).toBe(false)
  })

  it('shows a signed-out browser the sign-in page and nothing else', async () => {
    const home = await asBrowser('/')
    const somewhereElse = await asBrowser('/quests/anything')

    expect(home.body).toContain('Sign in')
    expect(home.body).not.toContain('Signed in as')
    // Every other path answers as the front door: a 404 listing what exists
    // would be an oracle for pages a signed-out caller cannot reach anyway.
    expect(somewhereElse.statusCode).toBe(404)
    expect(somewhereElse.body).toContain('Sign in')
  })

  it('carries the security headers on every console response', async () => {
    for (const response of [await asBrowser('/'), await asAgent('/'), await asBrowser('/nope')]) {
      for (const [header, value] of Object.entries(CONSOLE_HEADERS)) {
        expect(response.headers[header]).toBe(value)
      }
    }
  })

  it('puts no session value, token or secret in the rendered page', async () => {
    const response = await asBrowser('/', { signedIn: true })

    expect(response.body).not.toContain(session)
    expect(response.body).not.toContain(apiKey)
    // And no script at all, which is what lets the CSP be as strict as it is.
    expect(response.body).not.toContain('<script')
  })

  it('escapes what a stranger wrote', () => {
    expect(escape('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('serves no console at all when none is configured', () => {
    expect(consoleHost('')).toBeUndefined()
    expect(consoleHost('not a url')).toBeUndefined()
    expect(consoleHost(CONSOLE_URL)).toBe(CONSOLE_HOST)
  })
})

describe('signing in through the console', () => {
  it('takes a form post and answers with the same page a JSON caller gets', async () => {
    const form = await app.inject({
      method: 'POST',
      url: '/sign-in',
      headers: {
        host: CONSOLE_HOST,
        accept: 'text/html',
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: 'email=sponsor%40example.org',
    })

    expect(form.statusCode).toBe(200)
    expect(form.body).toContain('Check your mail')

    const json = await app.inject({
      method: 'POST',
      url: '/sign-in',
      headers: {
        host: CONSOLE_HOST,
        accept: 'application/json',
        'content-type': 'application/json',
      },
      payload: { email: 'sponsor@example.org' },
    })

    expect(json.statusCode).toBe(202)
  })

  it('says the same thing for an address it does not know', async () => {
    const unknown = await app.inject({
      method: 'POST',
      url: '/sign-in',
      headers: {
        host: CONSOLE_HOST,
        accept: 'text/html',
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: 'email=nobody%40example.org',
    })

    expect(unknown.statusCode).toBe(200)
    expect(unknown.body).toContain('Check your mail')
  })
})

/**
 * `#171` is open on a tool that throws handing the citizen the container's
 * filesystem, and a brand-new surface with its own error rendering is the
 * likeliest place to reproduce it.
 */
describe('when the console throws', () => {
  it('renders an error id and no path, stack or query', async () => {
    const failing = fakeQuests()
    const boom = new Error(`ENOENT: no such file, open '${process.cwd()}/secret.txt'`)
    const app2 = buildApp({
      vault: { vault: fakeVault() },
      accounts: fakeAccounts(),
      console: { ...fakeConsole(), consoleUrl: CONSOLE_URL },
      email: fakeEmail(),
      registry: fakeRegistry(),
      store,
      catalogue: fakeCatalogue(),
      deposits: fakeDepositDependencies(fakeDeposits()),
      quests: {
        ...failing,
        listOwn: async () => {
          throw boom
        },
      },
      submissions: fakeSubmissions(),
      guidance: fakeGuidance(),
      support: support({ desk: fakeSupportDesk() }),
      erasure: erasure({ desk: fakeErasureDesk() }),
      retesting: { reset: async () => ({ outcome: 'not-a-tester' as const }) },
      keys: { challenges: fakeKeyChallenges(), obstruction: noObstruction },
      solana: fakeSolana(),
      pow: fakePow(),
      vision: fakeVision(),
      github: fakeGithub(),
      contributions: fakeContributions(),
      wakeup: fakeWakeup(),
      social: fakeSocial(),
      operatorClaim: fakeOperatorClaim(),
      domain: fakeDomain(),
      website: fakeWebsite(),
      image: fakeImage(),
      scene: fakeScene(),
      injection: fakeInjection(),
      academy: fakeAcademy(),
    })
    await app2.ready()

    const response = await app2.inject({
      method: 'GET',
      url: '/',
      headers: {
        host: CONSOLE_HOST,
        accept: 'text/html',
        cookie: `__Host-kolonie_session=${session}`,
      },
    })

    expect(response.statusCode).toBe(500)
    expect(response.body).toContain('Error id:')
    // The whole point, and the grep the issue asks for.
    expect(response.body).not.toContain(process.cwd())
    expect(response.body).not.toContain('ENOENT')
    expect(response.body).not.toContain('secret.txt')

    await app2.close()
  })
})
