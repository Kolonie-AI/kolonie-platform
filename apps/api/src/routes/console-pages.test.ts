import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ERROR_STATUS } from '@kolonie-ai/core'
import { fakeDepositDependencies, fakeDeposits } from '../__fixtures__/deposits.js'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app.js'
import { fakeRegistry } from '../__fixtures__/registry.js'
import { fakeStore, type FakeStore } from '../__fixtures__/store.js'
import { fakeCatalogue } from '../__fixtures__/catalogue.js'
import { FAKE_AUDIENCE, fakeQuests, type FakeQuestDesk } from '../__fixtures__/quests.js'
import { fakeSubmissions } from '../__fixtures__/submissions.js'
import { fakeGuidance } from '../__fixtures__/guidance.js'
import { fakeSupportDesk } from '../__fixtures__/support.js'
import { fakeOperatorNotes } from '../__fixtures__/operator-notes.js'
import { fakeOperatorRequests } from '../__fixtures__/operator-requests.js'
import { fakePermissionReports } from '../__fixtures__/permission-reports.js'
import { fakeRotation } from '../__fixtures__/rotation.js'
import { support } from '../support.js'
import { fakeAcademy } from '../__fixtures__/academy.js'
import { fakeEmail } from '../__fixtures__/email.js'
import { fakeKeyChallenges } from '../__fixtures__/keys.js'
import { fakeGithub, fakeContributions } from '../__fixtures__/github.js'
import { fakeStandingHints } from '../__fixtures__/hints.js'
import { fakeWakeup } from '../__fixtures__/wakeup.js'
import { fakeAutonomy } from '../__fixtures__/autonomy.js'
import { fakeOperatorClaim } from '../__fixtures__/operator-claim.js'
import { fakeSocial } from '../__fixtures__/social.js'
import { fakeDomain } from '../__fixtures__/domain.js'
import { fakeWebServer } from '../__fixtures__/web-server.js'
import { fakeWebsite } from '../__fixtures__/website.js'
import { fakeImage } from '../__fixtures__/image.js'
import { fakeScene } from '../__fixtures__/scene.js'
import { fakeInjection } from '../__fixtures__/injection.js'
import { fakeVetting } from '../__fixtures__/vetting.js'
import { fakeAuthenticator } from '../__fixtures__/authenticator.js'
import { fakeVision } from '../__fixtures__/vision.js'
import { fakePow } from '../__fixtures__/proof-of-work.js'
import { fakeMemory } from '../__fixtures__/memory.js'
import { fakeSolana } from '../__fixtures__/solana.js'
import { fakeVault } from '../__fixtures__/vault.js'
import { fakeAccounts } from '../__fixtures__/accounts.js'
import { fakeConsole } from '../__fixtures__/console.js'
import { fakeErasureDesk } from '../__fixtures__/erasure.js'
import { erasure } from '../erasure.js'
import { noObstruction } from '../__fixtures__/obstruction.js'
import { consoleHost, wantsHtml } from './console-pages.js'
import { CONSOLE_HEADERS, escape } from '../console/html.js'
import { questAsCitizenReads } from '../console/sponsor.js'

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
let console_: ReturnType<typeof fakeConsole>

beforeEach(async () => {
  store = fakeStore()
  quests = fakeQuests()
  console_ = { ...fakeConsole(), consoleUrl: CONSOLE_URL }
  app = buildApp({
    vault: { vault: fakeVault() },
    accounts: fakeAccounts(),
    console: console_,
    email: fakeEmail(),
    registry: fakeRegistry(),
    store,
    catalogue: fakeCatalogue(),
    quests,
    deposits: fakeDepositDependencies(fakeDeposits()),
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
    keys: { challenges: fakeKeyChallenges(), obstruction: noObstruction },
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
    webServer: fakeWebServer(),
    image: fakeImage(),
    scene: fakeScene(),
    injection: fakeInjection(),
    vetting: fakeVetting(),
    authenticator: fakeAuthenticator(),
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
 * The door `#180` left unbuilt, and the criterion it carried into `#266`: an
 * address alone opens an account, and the page says an agent may hold one.
 */
describe('opening a sponsor account', () => {
  const signUp = async (payload: string) =>
    await app.inject({
      method: 'POST',
      url: '/sign-up',
      headers: {
        host: CONSOLE_HOST,
        accept: 'text/html',
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload,
    })

  it('takes an address and nothing else', async () => {
    const response = await signUp('email=stranger%40example.org')

    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('Check your mail')
    expect(console_.store.tokens()).toHaveLength(1)
    expect(console_.mailer.sent()[0]?.to).toBe('stranger@example.org')
  })

  /**
   * **The form must not become an oracle.** A taken address creates nothing and
   * mails nothing, and a stranger cannot tell the two cases apart — which is
   * `signUp`'s own rule, asserted at the surface a stranger actually reaches.
   */
  it('answers a taken address exactly as it answers a fresh one', async () => {
    console_.store.hold('known@example.org')

    const response = await signUp('email=known%40example.org')

    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('Check your mail')
    expect(console_.mailer.sent()).toHaveLength(0)
  })

  it('answers an agent with JSON on the same route', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/sign-up',
      headers: {
        host: CONSOLE_HOST,
        accept: 'application/json',
        'content-type': 'application/json',
      },
      payload: { email: 'an-agent@example.org' },
    })

    expect(response.statusCode).toBe(202)
  })

  it('refuses a body with no address', async () => {
    const response = await signUp('name=just-a-name')

    expect(response.statusCode).toBe(ERROR_STATUS.validation_failed)
  })

  it('states on the page that an agent may hold a sponsor account, and how it signs in', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/',
      headers: { host: CONSOLE_HOST, accept: 'text/html' },
    })

    expect(response.body).toContain('action="/sign-up"')
    expect(response.body).toContain('An agent may hold a sponsor account')
    expect(response.body).toContain('API key')
    // The one field, and no second one asking for a name.
    expect(response.body).toContain('id="sign-up-email"')
    expect(response.body).not.toContain('id="sign-up-name"')
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
      // The operator channel (#236), which this test does not exercise.
      operatorRequests: fakeOperatorRequests(),
      operatorNotes: fakeOperatorNotes(),
      // Blocked by permission rather than by ability (#147), unexercised here.
      permissionReports: fakePermissionReports(),
      // Replacing a leaked key (#211), unexercised here.
      rotation: fakeRotation(),
      erasure: erasure({ desk: fakeErasureDesk() }),
      retesting: { reset: async () => ({ outcome: 'not-a-tester' as const }) },
      keys: { challenges: fakeKeyChallenges(), obstruction: noObstruction },
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
      webServer: fakeWebServer(),
      image: fakeImage(),
      scene: fakeScene(),
      injection: fakeInjection(),
      vetting: fakeVetting(),
      authenticator: fakeAuthenticator(),
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

/**
 * The sponsor's pages (`#180`).
 *
 * The rules a sponsor meets in the form are tested without a server in
 * `console/quest-form.test.ts`; what is tested here is that the routes carry
 * them, that both representations answer, and that one sponsor cannot reach
 * another's quests.
 */
describe('the sponsor’s pages', () => {
  /** Post a form the way a browser does. */
  const postForm = (url: string, form: Record<string, string>) =>
    app.inject({
      method: 'POST',
      url,
      headers: {
        host: CONSOLE_HOST,
        accept: 'text/html',
        cookie: `__Host-kolonie_session=${session}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams(form).toString(),
    })

  const aForm = (overrides: Record<string, string> = {}): Record<string, string> => ({
    title: 'A thousand registrations',
    description: 'What this quest is, for a human reading the catalogue.',
    instructions: 'Register at the address in the brief and report what happened.',
    questions: JSON.stringify([
      { key: 'went-well', prompt: 'How did it go?', required: true },
      { key: 'blocked', prompt: 'Were you blocked?', required: false, options: ['yes', 'no'] },
    ]),
    slots: '10',
    rewardCredits: '0',
    expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10),
    minReputation: '0',
    audience: 'citizens',
    proofVerifier: 'email-inbox',
    ...overrides,
  })

  it('shows the form with the balance, and offers no targeting input', async () => {
    const page = await asBrowser('/quests/new', { signedIn: true })

    expect(page.statusCode).toBe(200)
    expect(page.body).toContain('available balance')
    // Skills are a list of checkboxes and never a text field.
    expect(page.body).toContain('name="requires" value="mailbox"')
    // The two fields with consequences say what the consequence is, in the form.
    expect(page.body).toContain('nothing to lose')
    expect(page.body).toContain('citizen’s own word')
  })

  it('answers the same page as JSON to an API key', async () => {
    const answer = await asAgent('/quests/new')

    expect(answer.statusCode).toBe(200)
    expect(answer.json().fields).toContain('slots')
    expect(answer.json().skills).toContain('mailbox')
    // The promise kolonie-docs#108 makes: no sponsor needs a browser.
    expect(answer.headers['content-type']).toContain('application/json')
  })

  it('refuses a skill the Colony does not mint, and says why', async () => {
    const refused = await postForm('/quests', aForm({ requires: 'mailbocks' }))

    expect(refused.statusCode).toBe(422)
    expect(refused.body).toContain('mailbocks')
  })

  it('refuses an expiry in the past', async () => {
    const past = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)

    expect((await postForm('/quests', aForm({ expiresAt: past }))).statusCode).toBe(422)
  })

  it('refuses a capacity of zero', async () => {
    expect((await postForm('/quests', aForm({ slots: '0' }))).statusCode).toBe(422)
  })

  /**
   * The preview is the citizen's own renderer, so it cannot drift from it.
   *
   * Asserted as the same **string** rather than as the same intent: a preview
   * that matched at review time and diverged afterwards is exactly the failure
   * `#180` asks for a preview to prevent.
   */
  it('previews the quest with the renderer a citizen reads', async () => {
    const created = await postForm('/quests', aForm())
    const location = created.headers['location'] as string

    const draft = await asBrowser(location, { signedIn: true })
    const own = await asAgent(location)
    const quest = own.json().quest

    expect(draft.body).toContain(
      questAsCitizenReads({
        title: quest.title,
        description: quest.description,
        instructions: quest.instructions,
        questions: quest.questions ?? [],
        requires: quest.requires,
        minReputation: quest.minReputation,
        reward: quest.reward,
      }),
    )
  })

  it('escapes a title that is trying to be markup', async () => {
    const created = await postForm('/quests', aForm({ title: '<script>alert(1)</script>' }))
    const draft = await asBrowser(created.headers['location'] as string, { signedIn: true })

    expect(draft.body).not.toContain('<script>alert(1)</script>')
    expect(draft.body).toContain(escape('<script>alert(1)</script>'))
  })

  describe('what a quest costs', () => {
    it('names the shortfall rather than only refusing', async () => {
      const created = await postForm('/quests', aForm({ slots: '10', rewardCredits: '100' }))
      const location = created.headers['location'] as string

      const submitted = await app.inject({
        method: 'POST',
        url: `${location}/submit`,
        headers: {
          host: CONSOLE_HOST,
          accept: 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
      })

      expect(submitted.statusCode).toBe(422)
      // 1000 asked for, nothing available.
      expect(submitted.json().message).toContain('1000')
      expect(submitted.json().message).toContain('short')
    })

    it('submits once the balance covers it', async () => {
      quests.credit(agentId as never, 1000)
      const created = await postForm('/quests', aForm({ slots: '10', rewardCredits: '100' }))
      const location = created.headers['location'] as string

      const submitted = await app.inject({
        method: 'POST',
        url: `${location}/submit`,
        headers: {
          host: CONSOLE_HOST,
          accept: 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
      })

      expect(submitted.statusCode).toBe(200)
      expect(submitted.json().quest.status).toBe('pending_review')
    })
  })

  it('shows one sponsor nothing of another’s', async () => {
    const created = await postForm('/quests', aForm())
    const location = created.headers['location'] as string

    const stranger = store.issue({})
    const asStranger = (url: string) =>
      app.inject({
        method: 'GET',
        url,
        headers: {
          host: CONSOLE_HOST,
          accept: 'application/json',
          authorization: `Bearer ${String(stranger.apiKey)}`,
        },
      })

    // Not found rather than forbidden: a distinguishable refusal would let
    // anybody holding a credential enumerate which task ids are quests.
    expect((await asStranger(location)).statusCode).toBe(404)
    expect((await asStranger(`${location}/results`)).statusCode).toBe(404)
    expect((await asStranger(`${location}/results/export?format=csv`)).statusCode).toBe(404)
  })

  it('exports the answers as CSV and as JSON', async () => {
    const created = await postForm('/quests', aForm())
    const location = created.headers['location'] as string

    const csv = await asAgent(`${location}/results/export?format=csv`)
    const json = await asAgent(`${location}/results/export?format=json`)

    expect(csv.statusCode).toBe(200)
    expect(csv.headers['content-type']).toContain('csv')
    expect(json.statusCode).toBe(200)
    expect(json.headers['content-type']).toContain('json')
  })

  it('shows the answers as they arrive, with a count per closed question', async () => {
    const created = await postForm('/quests', aForm())
    const location = created.headers['location'] as string
    const questId = location.split('/').pop() as string

    // Accepted through the fixture, because only a verdict accepts a report in
    // the real one and the verifier runner is another workspace (`#178`).
    quests.accept({
      taskId: questId as never,
      answers: { 'went-well': 'It took two tries.', blocked: 'no' },
    })
    quests.accept({
      taskId: questId as never,
      answers: { 'went-well': 'Straightforward.', blocked: 'no' },
    })

    const page = await asBrowser(`${location}/results`, { signedIn: true })

    expect(page.statusCode).toBe(200)
    expect(page.body).toContain('2 accepted report(s)')
    expect(page.body).toContain('It took two tries.')
    // Neither the handle nor the runtime is on the page (`#328`): the console
    // and the tool are one promise, and the browser is the same sponsor.
    expect(page.body).not.toContain('first-citizen')
    expect(page.body).not.toContain('openclaw')
    expect(page.body).toContain('You never learn who wrote what')

    // The closed question is counted; counting is the one aggregation that is a
    // fact rather than a reading.
    const json = await asAgent(`${location}/results`)
    expect(json.json().accepted).toBe(2)
    // Every option, including the one nobody chose: a zero is an answer to the
    // sponsor's question and leaving it out would read as a missing option.
    expect(json.json().counts['blocked']).toEqual({ yes: 0, no: 2 })
  })

  /**
   * The audience count reaches the sponsor before it commits anything (`#227`).
   *
   * Two halves, and the second is the one worth a test: that the count is asked
   * about *this quest's* criteria rather than about a default. A number computed
   * from the wrong criteria is worse than none — it is the sponsor's decision,
   * made on a figure nothing supports.
   */
  it('shows the audience the quest reaches, asked about the quest’s own criteria', async () => {
    const created = await postForm('/quests', aForm({ minActivityDays: '' }))
    const location = created.headers['location'] as string

    const page = await asBrowser(location, { signedIn: true })
    expect(page.body).toContain(`${FAKE_AUDIENCE} citizen(s) match`)
    // And an agent sponsor reads the same number without a browser.
    expect((await asAgent(location)).json().audience).toBe(FAKE_AUDIENCE)

    const asked = quests.audienceAsked.at(-1)
    expect(asked?.minActivityDays).toBeNull()
    expect(asked?.audience).toBe('citizens')
  })

  it('says a narrowed quest reaching nobody is still publishable', async () => {
    const created = await postForm('/quests', aForm({ minActivityDays: '1' }))
    const location = created.headers['location'] as string

    const page = await asBrowser(location, { signedIn: true })

    // Zero is an answer rather than a refusal: the population moves, and a quest
    // is open until it fills or expires.
    expect(page.body).toContain('No citizen matches')
    expect(page.body).toContain('may still publish')
    expect(quests.audienceAsked.at(-1)?.minActivityDays).toBe(1)
  })

  it('says why there is nothing to count when every question is free text', async () => {
    const created = await postForm(
      '/quests',
      aForm({
        questions: JSON.stringify([{ key: 'went-well', prompt: 'How did it go?', required: true }]),
      }),
    )
    const page = await asBrowser(`${created.headers['location']}/results`, { signedIn: true })

    expect(page.body).toContain('nothing the Colony can count')
    // The reason, which is the decision `#178` made: a summary is an opinion.
    expect(page.body).toContain('would be an opinion')
  })

  it('offers a refused quest a copy, and leaves the refused row intact', async () => {
    const created = await postForm('/quests', aForm())
    const location = created.headers['location'] as string
    const questId = location.split('/').pop() as string

    quests.moderate(questId as never)
    await app.inject({
      method: 'POST',
      url: `${location}/submit`,
      headers: {
        host: CONSOLE_HOST,
        accept: 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
    })

    // Refused by a steward through the desk rather than through a route: the
    // steward's own pages are `#181`, and this test is about what the sponsor
    // is shown afterwards.
    const steward = store.issue({})
    await quests.refuse({
      stewardId: steward.agent.id,
      taskId: questId as never,
      reason: 'The instructions ask for something impossible.',
      at: new Date().toISOString() as never,
    })

    const draft = await asBrowser(location, { signedIn: true })
    expect(draft.body).toContain('impossible')
    expect(draft.body).toContain('Copy into a new draft')

    const copy = await postForm(`${location}/copy`, {})
    expect(copy.statusCode).toBe(200)
    // The words come across…
    expect(copy.body).toContain('A thousand registrations')
    // …and the refusal is shown as the reason it is being copied.
    expect(copy.body).toContain('impossible')

    // The refused quest is untouched: it keeps its refusal and its status.
    const after = await asAgent(location)
    expect(after.json().rejectionReason).toContain('impossible')
  })
})
