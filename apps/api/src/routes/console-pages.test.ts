import { randomUUID } from 'node:crypto'
import { fakeHumans } from '../__fixtures__/humans.js'
import { fakeArtefactChallenges } from '../__fixtures__/artefact.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AccountKindSchema,
  DEFAULT_PLATFORM_FEE_PERCENT,
  ERROR_STATUS,
  noStagesRun,
} from '@kolonie-ai/core'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app.js'
import { noProviderEnquiries, type ProviderEnquiryDesk } from '../provider-enquiries.js'
import { fakeRegistry } from '../__fixtures__/registry.js'
import { fakeStore, type FakeStore } from '../__fixtures__/store.js'
import { fakeCatalogue } from '../__fixtures__/catalogue.js'
import { FAKE_AUDIENCE, fakeQuests, type FakeQuestDesk } from '../__fixtures__/quests.js'
import { fakeSubmissions } from '../__fixtures__/submissions.js'
import { fakeGuidance } from '../__fixtures__/guidance.js'
import { fakeSupportDesk } from '../__fixtures__/support.js'
import { fakeOperatorNotes } from '../__fixtures__/operator-notes.js'
import { fakeOperatorThreads } from '../__fixtures__/operator-threads.js'
import { fakePermissionReports } from '../__fixtures__/permission-reports.js'
import { fakeRotation } from '../__fixtures__/rotation.js'
import { support } from '../support.js'
import { fakeAcademy } from '../__fixtures__/academy.js'
import { fakeEmail } from '../__fixtures__/email.js'
import { fakeSms } from '../__fixtures__/sms.js'
import { fakeKeyChallenges } from '../__fixtures__/keys.js'
import { fakeGithub, fakeContributions } from '../__fixtures__/github.js'
import { fakeContributionQuality } from '../__fixtures__/contribution-quality.js'
import { fakeStandingHints } from '../__fixtures__/hints.js'
import { fakeWakeup } from '../__fixtures__/wakeup.js'
import {
  fakeAutonomy,
  fakeOperatorPages,
  type FakeOperatorPages,
} from '../__fixtures__/autonomy.js'
import { fakeOperatorClaim } from '../__fixtures__/operator-claim.js'
import { fakeSocial } from '../__fixtures__/social.js'
import { fakeDomain } from '../__fixtures__/domain.js'
import { fakeWebServer } from '../__fixtures__/web-server.js'
import { fakeWake } from '../__fixtures__/wake.js'
import { fakeWishList } from '../__fixtures__/account-wishes.js'
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
import {
  fakeAccounts,
  fakeAccountRegister,
  type FakeAccountRegister,
} from '../__fixtures__/accounts.js'
import { fakeAccountOffers } from '../__fixtures__/account-offers.js'
import { fakeConsole, recordingLog, type RecordingLog } from '../__fixtures__/console.js'
import { fakeSettings } from '../__fixtures__/settings.js'
import { fakeErasureDesk } from '../__fixtures__/erasure.js'
import { erasure } from '../erasure.js'
import { noObstruction } from '../__fixtures__/obstruction.js'
import { consoleHost, wantsHtml } from './console-pages.js'
import { CONSOLE_HEADERS, escape } from '../console/html.js'
import { questAsCitizenReads } from '../console/sponsor.js'
import { arrivalReports } from '../arrival-reports.js'
import { fakeArrivalDesk } from '../__fixtures__/arrivals.js'

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
let humans_: ReturnType<typeof fakeHumans>
let enquiries_: ProviderEnquiryDesk
let settings_: ReturnType<typeof fakeSettings>
/**
 * Held rather than inlined, so `#928`'s page can be given accounts to render.
 *
 * The register itself and not the bundle: `fakeAccounts` widens what it is handed
 * to the production interface, which is right for what `buildApp` receives and
 * leaves a test with no way to put a proved row in place.
 */
let register_: FakeAccountRegister
/** The same, for the agent an operator page has to know about (`#452`). */
let pages_: FakeOperatorPages

beforeEach(async () => {
  store = fakeStore()
  quests = fakeQuests()
  // Priced in single lamports so the invoice split is readable; the payout
  // floor (`#743`) is off here for that reason and is measured where it lives.
  quests.setPriceFloor(0)
  console_ = { ...fakeConsole(), consoleUrl: CONSOLE_URL }
  humans_ = fakeHumans()
  settings_ = fakeSettings()
  // Providers writing in about the Atlas (`#544`). An in-memory desk, so the
  // section can be exercised without a database.
  enquiries_ = noProviderEnquiries()
  register_ = fakeAccountRegister()
  pages_ = fakeOperatorPages()
  app = buildApp({
    arrivals: arrivalReports({ desk: fakeArrivalDesk() }),
    humans: humans_,
    settings: settings_,
    providerEnquiries: enquiries_,
    vault: { vault: fakeVault() },
    accounts: fakeAccounts(register_),
    accountOffers: { offers: fakeAccountOffers() },
    console: console_,
    email: fakeEmail(),
    sms: fakeSms(),
    registry: fakeRegistry(),
    store,
    catalogue: fakeCatalogue(),
    quests,
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
    keys: { challenges: fakeKeyChallenges(), obstruction: noObstruction },
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
    autonomy: fakeAutonomy(pages_),
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
    /**
     * The API's own host answers about the surface that is actually there —
     * anything but a sign-in page, which is the whole of what this test is
     * guarding.
     *
     * **It was a 404 and is now a 405** (`#1005`). `/` is where MCP answers
     * POST, so *no route here* was never true of it; a citizen probing the
     * address before wiring anything up read the status as a dead service and
     * said so. What has not changed is that the console does not leak: the
     * answer is JSON about MCP, it still points at the REST prefix, and there
     * is no HTML in it.
     */
    expect(onApi.statusCode).toBe(405)
    expect(onApi.json().hint).toContain('/v1')
    expect(onApi.body).not.toContain('Sign in')
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
        reward: { reputation: 5, lamports: 0 },
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

    expect(home.body).toContain('Sign in')
    expect(home.body).not.toContain('Signed in as')
  })

  /**
   * **A 404 that renders the front door is a 404 no reader can see** (`#396`).
   *
   * This test asserted the opposite until the mailed sign-in link turned out to
   * point at an unregistered route: every reader who followed one was handed a
   * form, under a status code no browser displays, and read it as *your link
   * expired*. The page still names nothing that exists — that part was right, and
   * a listing would be an oracle for pages a signed-out caller cannot reach.
   */
  it('answers an unknown path with a 404 that says so, not with the sign-in form', async () => {
    const somewhereElse = await asBrowser('/quests/anything')

    expect(somewhereElse.statusCode).toBe(404)
    expect(somewhereElse.body).toContain('No such page')
    expect(somewhereElse.body).not.toContain('<form')
    expect(somewhereElse.body).not.toContain('Sign in with the address')
    // Nothing about what does exist here.
    expect(somewhereElse.body).not.toContain('quests')
  })

  it('carries the security headers on every console response', async () => {
    for (const response of [await asBrowser('/'), await asAgent('/'), await asBrowser('/nope')]) {
      for (const [header, value] of Object.entries(CONSOLE_HEADERS)) {
        expect(response.headers[header]).toBe(value)
      }
    }
  })

  /**
   * `#397`: `default-src 'none'` covers `img-src`, so every badge the operator's
   * page drew was refused by the Colony's own header. The relaxation is exactly
   * one source and it is this one — a policy that grew `data:` or a third party
   * would be a different argument, and this test is where it would have to be
   * made.
   */
  it('allows images from itself and from nowhere else', async () => {
    const policy = CONSOLE_HEADERS['content-security-policy']

    expect(policy).toContain("img-src 'self'")
    expect(policy).not.toContain('data:')
    expect(policy).not.toContain('*')
    // Everything not named is still refused, which is what makes the one
    // relaxation affordable.
    expect(policy).toContain("default-src 'none'")
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
 * The whole path, walked the way a person walks it (`#396`).
 *
 * **Every step here reads the output of the one before it**, and the link is
 * taken out of the mail body rather than typed into the test. That is the
 * difference that matters: a test that injects `/sign-in/redeem` directly passed
 * on every commit of this defect's life, because the route it exercised was
 * never the route the Colony was mailing anybody.
 */
describe('following the link that was actually mailed', () => {
  /** Ask for a link as a browser would, and read the URL back out of the mail. */
  const mailedLink = async (address: string): Promise<URL> => {
    await app.inject({
      method: 'POST',
      url: '/sign-in',
      headers: {
        host: CONSOLE_HOST,
        accept: 'text/html',
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: `email=${encodeURIComponent(address)}`,
    })

    const body = console_.mailer.sent().at(-1)?.text ?? ''
    const found = /https?:\/\/\S+/.exec(body)?.[0]
    if (found === undefined) throw new Error(`no link in the mail: ${body}`)

    return new URL(found)
  }

  /** Follow it exactly as a mail client would: a GET, on the console's host. */
  const follow = (link: URL) =>
    app.inject({
      method: 'GET',
      url: `${link.pathname}${link.search}`,
      headers: { host: CONSOLE_HOST, accept: 'text/html,application/xhtml+xml' },
    })

  it('signs a sponsor in', async () => {
    console_.store.hold('sponsor@example.org')

    const link = await mailedLink('sponsor@example.org')
    const followed = await follow(link)

    expect(link.host).toBe(CONSOLE_HOST)
    expect(followed.statusCode).toBe(303)
    expect(followed.headers['location']).toBe('/')
    expect(String(followed.headers['set-cookie'])).toContain('__Host-kolonie_session=')
    // The token left the address bar with the redirect and never reached the body.
    expect(followed.body).not.toContain(link.searchParams.get('token'))
  })

  it('tells a reader the link was already used, and does not sign them in', async () => {
    console_.store.hold('twice@example.org')

    const link = await mailedLink('twice@example.org')
    await follow(link)
    const again = await follow(link)

    expect(again.statusCode).toBe(ERROR_STATUS.unauthorized)
    expect(again.body).toContain('already been used')
    expect(again.headers['set-cookie']).toBeUndefined()
  })

  it('tells a reader the link expired, and does not sign them in', async () => {
    console_.store.hold('slow@example.org')

    const link = await mailedLink('slow@example.org')
    console_.store.expire(link.searchParams.get('token') ?? '')
    const followed = await follow(link)

    expect(followed.statusCode).toBe(ERROR_STATUS.unauthorized)
    expect(followed.body).toContain('expired')
    expect(followed.body).not.toContain('already been used')
    expect(followed.headers['set-cookie']).toBeUndefined()
  })

  /**
   * The one refusal that stays vague, and it is the only one reachable by
   * guessing. `RefusalReason` in `packages/db` carries the reasoning.
   */
  it('tells a guesser nothing beyond that the link is not valid', async () => {
    const guessed = await app.inject({
      method: 'GET',
      url: '/sign-in/redeem?token=never-minted',
      headers: { host: CONSOLE_HOST, accept: 'text/html' },
    })

    expect(guessed.statusCode).toBe(ERROR_STATUS.unauthorized)
    expect(guessed.body).toContain('not valid')
    expect(guessed.body).not.toContain('already been used')
    expect(guessed.body).not.toContain('expired')
  })

  /** Whatever the refusal, the way out is on the page: ask for another link. */
  it('leaves a refused reader something to do', async () => {
    console_.store.hold('stuck@example.org')

    const link = await mailedLink('stuck@example.org')
    await follow(link)
    const again = await follow(link)

    expect(again.body).toContain('action="/sign-in"')
  })
})

/**
 * `#171` is open on a tool that throws handing the citizen the container's
 * filesystem, and a brand-new surface with its own error rendering is the
 * likeliest place to reproduce it.
 */
describe('when the console throws', () => {
  /**
   * A console whose signed-in home throws, and a log that keeps what it was
   * told.
   *
   * Extracted when `#490` needed a second and a third case against the same
   * arrangement: the dependency list is fifty lines, and three copies of it
   * drift apart in different directions.
   */
  const throwingApp = (boom: Error, log: RecordingLog) => {
    const failing = fakeQuests()
    return buildApp({
      arrivals: arrivalReports({ desk: fakeArrivalDesk() }),
      log,
      humans: fakeHumans(),
      vault: { vault: fakeVault() },
      accounts: fakeAccounts(),
      accountOffers: { offers: fakeAccountOffers() },
      console: { ...fakeConsole(), consoleUrl: CONSOLE_URL },
      email: fakeEmail(),
      sms: fakeSms(),
      registry: fakeRegistry(),
      store,
      catalogue: fakeCatalogue(),
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
      operatorThreads: fakeOperatorThreads(),
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
      academy: fakeAcademy(),
    })
  }

  /** The failure a browser sees. */
  const failAsBrowser = (app2: FastifyInstance) =>
    app2.inject({
      method: 'GET',
      url: '/',
      headers: {
        host: CONSOLE_HOST,
        accept: 'text/html',
        cookie: `__Host-kolonie_session=${session}`,
      },
    })

  /** The same failure asked for as JSON. */
  const failAsJson = (app2: FastifyInstance) =>
    app2.inject({
      method: 'GET',
      url: '/',
      headers: {
        host: CONSOLE_HOST,
        accept: 'application/json',
        cookie: `__Host-kolonie_session=${session}`,
      },
    })

  /**
   * The id the page prints, read back out of the rendered HTML.
   *
   * Matched against the markup `errorPage` actually emits — `Error id: <uuid>`
   * inside a `<p class="note">` — rather than against a constant this test also
   * owns, so that a page that stops printing the id fails here.
   */
  const idFromPage = (body: string): string | undefined =>
    /Error id:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(body)?.[1]

  it('renders an error id and no path, stack or query', async () => {
    const boom = new Error(`ENOENT: no such file, open '${process.cwd()}/secret.txt'`)
    const app2 = throwingApp(boom, recordingLog())
    await app2.ready()

    const response = await failAsBrowser(app2)

    expect(response.statusCode).toBe(500)
    expect(response.body).toContain('Error id:')
    // The whole point, and the grep the issue asks for.
    expect(response.body).not.toContain(process.cwd())
    expect(response.body).not.toContain('ENOENT')
    expect(response.body).not.toContain('secret.txt')

    await app2.close()
  })

  /**
   * `#490`. The page has always said the failure can be looked up; until this
   * passed, the id existed on that page and in no log, no container output and
   * no table. A person reporting a failure believed they had handed over
   * something usable.
   */
  it('writes exactly one error line, carrying the uuid the page shows', async () => {
    const log = recordingLog()
    const app2 = throwingApp(new Error('the database went away'), log)
    await app2.ready()

    const response = await failAsBrowser(app2)
    const shown = idFromPage(response.body)

    const errors = log.lines().filter((line) => line.level === 'error')
    expect(errors).toHaveLength(1)

    /**
     * **Read out of one request, not asserted against a fixture twice.** `#490`
     * is explicit about this: two assertions against two fixtures pass happily
     * with two generators, which is the exact defect being fixed.
     */
    expect(shown).toBeDefined()
    expect(errors[0]?.fields['errorId']).toBe(shown)

    await app2.close()
  })

  it('carries the same field shape as every other 5xx, plus the id', async () => {
    // A second event name for the same kind of failure splits the query a
    // person runs during an incident.
    const log = recordingLog()
    const app2 = throwingApp(new Error('the database went away'), log)
    await app2.ready()

    await failAsBrowser(app2)

    const fields = log.lines().find((line) => line.level === 'error')?.fields
    expect(fields?.['event']).toBe('request.failed')
    expect(fields?.['method']).toBe('GET')
    // The console renders its own 5xx, so it carries the field on its own —
    // and without it every console failure is one signature (`#896`).
    expect(fields?.['route']).toBe('/')
    expect(fields?.['url']).toBe('/')
    expect(fields?.['status']).toBe(500)
    expect(fields?.['requestId']).toEqual(expect.any(String))

    await app2.close()
  })

  it('sends the cause to the log and to no part of the response', async () => {
    const boom = new Error(`ENOENT: no such file, open '${process.cwd()}/secret.txt'`)
    const log = recordingLog()
    const app2 = throwingApp(boom, log)
    await app2.ready()

    const response = await failAsBrowser(app2)
    const logged = log.lines().find((line) => line.level === 'error')

    // It reaches the log…
    expect(logged?.error).toBe(boom)
    // …and `#171` still holds on the way out.
    expect(response.body).not.toContain('ENOENT')
    expect(response.body).not.toContain('secret.txt')

    await app2.close()
  })

  it('gives the JSON representation the same id it logged', async () => {
    const log = recordingLog()
    const app2 = throwingApp(new Error('the database went away'), log)
    await app2.ready()

    const response = await failAsJson(app2)
    const body = response.json() as { errorId?: string }

    expect(response.statusCode).toBe(500)
    expect(body.errorId).toEqual(expect.any(String))
    expect(log.lines().find((line) => line.level === 'error')?.fields['errorId']).toBe(body.errorId)

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
    rewardSol: '0',
    expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10),
    minReputation: '0',
    audience: 'citizens',
    proofVerifier: 'email-inbox',
    ...overrides,
  })

  it('shows the form and how it will be paid for, and offers no targeting input', async () => {
    const page = await asBrowser('/quests/new', { signedIn: true })

    expect(page.statusCode).toBe(200)
    // The balance line went with D-106 (`#553`); what a sponsor needs to know is
    // that it will be invoiced and pays from its own wallet.
    expect(page.body).not.toContain('available balance')
    expect(page.body).toContain('invoices you')
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
   * Nobody meets the platform fee after the work is done (`#463`).
   *
   * The three figures the sponsor decides on — funded, to citizens, the Colony's
   * share — with capacity multiplied through, because *250 per report × 40
   * reports* is the number that changes a mind and *25 %* is not.
   */
  it('shows the invoice and the split before the quest is published', async () => {
    // 0.002 SOL an answer is above the soft and colony-judged ceilings, so this
    // has to be a hard quest to exist at all — which under `#626` means asking
    // for the thing `email-inbox` proves rather than merely naming it.
    const created = await postForm(
      '/quests',
      aForm({
        rewardSol: '0.002',
        slots: '40',
        questions: JSON.stringify([
          {
            key: 'address',
            prompt: 'Which address did you register?',
            required: true,
            format: 'email',
            provenBy: true,
          },
        ]),
      }),
    )
    const draft = await asBrowser(created.headers['location'] as string, { signedIn: true })

    // The rejection case: a figure on this page that is not what the payout
    // computes fails here. Nothing in the console does its own arithmetic.
    // 40 × 0.002 for the answers, and that is the whole invoice — it read
    // 0.0815 until D-114 (`#752`), the extra 0.0015 being an obstacle pool the
    // form published by default and the sponsor had not asked to buy.
    expect(draft.body).toContain('0.08 SOL')
    expect(draft.body).toContain('0.0015 SOL')
    expect(draft.body).toContain('0.0005 SOL')
    // Said before the sponsor commits, because neither can be undone.
    expect(draft.body).toContain('capacity nobody fills is not returned')
  })

  /**
   * At a price small enough that the fee rounds away, the page says the citizen
   * receives the whole amount rather than printing a zero that reads as a
   * charge. One lamport is the smallest such price and the clearest case
   * (`#553` phase C: it used to be the pilot's one cent).
   */
  it('says the Colony takes nothing where the fee rounds to zero', async () => {
    const created = await postForm('/quests', aForm({ rewardSol: '0.000000001', slots: '10' }))
    const draft = await asBrowser(created.headers['location'] as string, { signedIn: true })

    expect(draft.body).toContain('the Colony takes nothing')
    expect(draft.body).not.toContain('platform fee of')
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
        // A draft, so the rate is the one publishing it would write (`#463`).
        feePercent: DEFAULT_PLATFORM_FEE_PERCENT,
      }),
    )
  })

  it('escapes a title that is trying to be markup', async () => {
    const created = await postForm('/quests', aForm({ title: '<script>alert(1)</script>' }))
    const draft = await asBrowser(created.headers['location'] as string, { signedIn: true })

    expect(draft.body).not.toContain('<script>alert(1)</script>')
    expect(draft.body).toContain(escape('<script>alert(1)</script>'))
  })

  /**
   * **The affordability tests are gone with the balance they checked** — D-106
   * (`#540`). A sponsor pays an invoice from its own wallet after publication,
   * so there is no balance for a submission to be short of and nothing here to
   * refuse. What the page says instead — the invoice, the citizen's share, the
   * Colony's share and the warning below the chain minimum — is asserted in
   * `console/quest-form.test.ts`, against the one function that renders it.
   */

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
    expect(page.body).toContain(`${FAKE_AUDIENCE} citizens match`)
    // And an agent sponsor reads the same number without a browser.
    expect((await asAgent(location)).json().audience).toEqual({
      kind: 'exact',
      citizens: FAKE_AUDIENCE,
    })

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

    // Refused by the moderator, which is the only refusal there is (`#693`):
    // the verdict is the decision and no steward is in the path. This test is
    // about what the sponsor is shown afterwards.
    quests.moderate(questId as never, 'rejected', 'The instructions ask for something impossible.')

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

/**
 * The route out of the browser (`#400`).
 *
 * The Colony already said the two surfaces are one identity — `ARCHITECTURE.md`:
 * *"there is one identity table and a row in it may be a human"* — but the arrow
 * pointed one way. An agent with a key could use the browser; a sponsor who
 * started the way the sign-in page invited it to was in the browser permanently,
 * and the moment it wanted to automate it had to open a second account and
 * abandon the first.
 */
describe('a browser sponsor taking an API key (#400)', () => {
  const postKey = (options: { readonly signedIn?: boolean } = {}) =>
    app.inject({
      method: 'POST',
      url: '/key',
      headers: {
        host: CONSOLE_HOST,
        accept: 'text/html',
        'content-type': 'application/x-www-form-urlencoded',
        ...(options.signedIn === false ? {} : { cookie: `__Host-kolonie_session=${session}` }),
      },
      payload: '',
    })

  /** Put the session's identity on record, so there is an address to mail to. */
  const holdAddress = () => console_.store.hold('sponsor@example.org', agentId as never)

  it('offers a key, mails a fresh confirmation, and mints on the link', async () => {
    holdAddress()

    const offer = await asBrowser('/key', { signedIn: true })
    expect(offer.statusCode).toBe(200)
    expect(offer.body).toContain('An API key for this account')

    const asked = await postKey()
    expect(asked.statusCode).toBe(200)
    expect(asked.body).toContain('Check your mail')

    const mail = console_.mailer.sent().at(-1)
    expect(mail?.to).toBe('sponsor@example.org')
    // It describes the act that produced it (`#398`'s lesson), rather than
    // saying somebody asked to sign in to a person who asked for a key.
    expect(mail?.subject).toContain('API key')
    expect(mail?.text).toContain('asked for an API key')

    const token = console_.store.keyMintTokens().at(-1)
    const minted = await asBrowser(`/key/confirm?token=${token}`, { signedIn: true })

    expect(minted.statusCode).toBe(200)
    expect(minted.body).toContain('only time it is shown')
    expect(minted.body).toContain('kol_')
  })

  /**
   * **The load-bearing property.** Minting a key confers no standing. D-039 is
   * untouched — citizenship is `profile` plus a skill whose verifier read
   * something outside the Colony — and this is what keeps `governance/quests.md`'s
   * stake honest.
   */
  it('grants no skill, no reputation, no citizenship and no task access', async () => {
    holdAddress()
    const before = await store.authenticateSession(session)

    await postKey()
    const token = console_.store.keyMintTokens().at(-1)
    await asBrowser(`/key/confirm?token=${token}`, { signedIn: true })

    const after = await store.authenticateSession(session)

    expect(before.outcome).toBe('authenticated')
    expect(after.outcome).toBe('authenticated')
    if (before.outcome !== 'authenticated' || after.outcome !== 'authenticated') return

    expect(after.agent.skills).toEqual(before.agent.skills)
    expect(after.agent.roles).toEqual(before.agent.roles)
    expect(after.agent.status).toBe(before.agent.status)
    expect(after.agent.accountType).toBe(before.agent.accountType)
    // Nothing here is a citizen: the whole of what a key buys is the ability to
    // call, and D-039's bar is a skill whose verifier read something outside.
    expect(after.agent.skills).toEqual([])
  })

  it('refuses the confirmation route without a token, and says to ask again', async () => {
    const refused = await asBrowser('/key/confirm?token=nothing-real', { signedIn: true })

    expect(refused.statusCode).toBe(401)
    expect(refused.body).toContain('Ask for another one')
    expect(refused.body).not.toContain('kol_')
  })

  /**
   * One link, one key. A token that has already been spent buys nothing, which
   * is what stops a mail forwarded to somebody else minting a second credential.
   */
  it('spends the confirmation, so following it twice mints once', async () => {
    holdAddress()
    await postKey()
    const token = console_.store.keyMintTokens().at(-1)

    const first = await asBrowser(`/key/confirm?token=${token}`, { signedIn: true })
    const second = await asBrowser(`/key/confirm?token=${token}`, { signedIn: true })

    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(401)
    expect(second.body).not.toContain('kol_')
  })

  /**
   * The session is what names the identity, and there is no parameter that could
   * name another. A signed-out browser is handed to the not-found handler for
   * the reason this file already states: a `401` here would be an oracle for
   * which console paths are real.
   */
  it('cannot be asked for by somebody who is not signed in', async () => {
    holdAddress()

    const page = await asBrowser('/key')
    const asked = await postKey({ signedIn: false })

    expect(page.statusCode).toBe(404)
    expect(asked.statusCode).toBe(404)
    expect(console_.mailer.sent()).toHaveLength(0)
  })

  /**
   * **The sentence this asserted went with the form it was about** (`#578`).
   *
   * It said *starting in a browser does not shut the other door* — a reassurance
   * to somebody choosing between the sign-up form and registering over MCP. The
   * form is gone, so there is no such choice to reassure anybody about, and what
   * the page must say instead is what the mail door actually signs in.
   */
  it('says the address door signs in an agent rather than opening an account', async () => {
    const signIn = await asBrowser('/')

    expect(signIn.body).toContain('Sign in as an agent, with an address')
    expect(signIn.body).toContain('This opens no account and creates nothing')
    expect(signIn.body).not.toContain('action="/sign-up"')
  })

  /**
   * The door a rotation cannot fix (`#1127`).
   *
   * `kolonie.credential.rotate` re-seals the vault because the caller presents
   * the key that sealed it. This path receives a mint-link token and the
   * citizen's own key exists only as a hash, so there is nothing here to open
   * the envelopes with. `#1127` decided that case says so rather than pretending
   * — and saying so is worth more than silence, because a key that reads an
   * empty vault looks exactly like a vault that was empty.
   */
  it('warns when the minted key will not open entries the account already keeps', async () => {
    holdAddress()
    console_.store.strand(agentId as never, 2)
    await postKey()
    const token = console_.store.keyMintTokens().at(-1)

    const minted = await asBrowser(`/key/confirm?token=${token}`, { signedIn: true })

    expect(minted.statusCode).toBe(200)
    expect(minted.body).toContain('This key does not open your vault')
    expect(minted.body).toContain('2')
  })

  it('says nothing about the vault when there is nothing to strand', async () => {
    holdAddress()
    await postKey()
    const token = console_.store.keyMintTokens().at(-1)

    const minted = await asBrowser(`/key/confirm?token=${token}`, { signedIn: true })

    expect(minted.body).not.toContain('does not open your vault')
  })
})

/**
 * `#486`. There was no page that answered *how is the Colony doing* to the
 * person running it. The nearest thing was `/numbers`, which was neither
 * reachable by a person — it gated on the **agent** role `steward` — nor the
 * whole picture, being one table of aggregates. `#943` deleted it once this page
 * carried the same figures behind a gate a person can pass.
 *
 * What is asserted here is the gate, in all four of its states, and the figures
 * that page used to hold.
 */
describe('the maintainer’s page', () => {
  /** Sign a person in, optionally holding the role. */
  const aPerson = async (options: { readonly maintains?: boolean } = {}) => {
    /**
     * `holdsIdentity` and not `findOrCreate` since `#574`: an unknown identity
     * carrying an address somebody already holds now **attaches** to them, and
     * every person here was made with the same address — so the second call
     * would hand back the first person and every test wanting two would have
     * one. This fixture is making a person, not exercising that resolution.
     */
    const human = humans_.store.holdsIdentity({
      provider: 'github',
      subject: `subject-${randomUUID()}`,
      email: 'someone@example.test',
    })
    if (options.maintains === true) humans_.store.maintains(human.id)
    const { session: cookie } = await humans_.store.openSession(human.id, {})
    return { human, cookie }
  }

  /** `/backend` is the landing page since `#775`; each section takes a path. */
  const backendAs = (cookie: string | undefined, accept = 'text/html', path = '/backend') =>
    app.inject({
      method: 'GET',
      url: path,
      headers: {
        host: CONSOLE_HOST,
        accept,
        ...(cookie === undefined ? {} : { cookie: `__Host-kolonie_session=${cookie}` }),
      },
    })

  it('answers the maintainer, in HTML', async () => {
    const { cookie } = await aPerson({ maintains: true })

    const response = await backendAs(cookie)

    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('The Colony, from the inside')
    // The numbers section, which is the only rendering of these figures.
    expect(response.body).toContain('Accounts, by the way they arrived')
    expect(response.body).toContain('Computed at')
  })

  it('answers the maintainer in JSON when asked for it', async () => {
    const { cookie } = await aPerson({ maintains: true })

    const response = await backendAs(cookie, 'application/json')

    expect(response.statusCode).toBe(200)
    expect(response.json().numbers).toBeDefined()
    expect(response.json().numbers.computedAt).toEqual(expect.any(String))
  })

  /**
   * All three refusals the issue names, and each is a 404 rather than a 403:
   * the page does not announce itself to somebody who cannot have it.
   */
  it('refuses a caller with no session at all', async () => {
    expect((await backendAs(undefined)).statusCode).toBe(404)
  })

  it('refuses a person signed in without the role', async () => {
    const { cookie } = await aPerson()

    expect((await backendAs(cookie)).statusCode).toBe(404)
  })

  /**
   * **An agent's session must not reach it**, which is the property `#485` and
   * `humans.ts` both exist to hold: a bug there does not render a wrong page, it
   * hands somebody a citizen's authority. The session below authenticates
   * perfectly well as an agent on every other console route.
   */
  it('refuses an agent’s console session', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/backend',
      headers: {
        host: CONSOLE_HOST,
        accept: 'text/html',
        cookie: `__Host-kolonie_session=${session}`,
      },
    })

    expect(response.statusCode).toBe(404)
  })

  it('refuses an agent’s API key', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/backend',
      headers: {
        host: CONSOLE_HOST,
        accept: 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
    })

    expect(response.statusCode).toBe(404)
  })

  /**
   * Providers writing in about the Atlas (`#544`).
   *
   * **On the page before the form is announced anywhere**, because an enquiry
   * nobody answers is worse than no form.
   */
  describe('providers writing in', () => {
    /** Its own page since `#775`, and where the POST comes back to. */
    const enquiriesAs = (cookie: string) => backendAs(cookie, 'text/html', '/backend/enquiries')

    const ENQUIRY = {
      product: 'A mailbox service agents can sign up for.',
      url: 'openmail.example',
      contact: 'Jo, jo@openmail.example',
      wants: 'We want to know whether an agent can complete our signup without a person.',
    }

    const markHandled = (cookie: string, id: string) =>
      app.inject({
        method: 'POST',
        url: `/backend/enquiries/${id}/handled`,
        headers: {
          host: CONSOLE_HOST,
          accept: 'text/html',
          cookie: `__Host-kolonie_session=${cookie}`,
        },
      })

    it('shows what a provider wrote, and how to reach them', async () => {
      await enquiries_.record(ENQUIRY)
      const { cookie } = await aPerson({ maintains: true })

      const response = await enquiriesAs(cookie)

      expect(response.body).toContain('Providers writing in')
      expect(response.body).toContain('A mailbox service agents can sign up for.')
      expect(response.body).toContain('Jo, jo@openmail.example')
      expect(response.body).toContain('complete our signup without a person')
    })

    /**
     * **No enquiries is a finding rather than a gap**, and the page says so: it
     * is one of the two answers the form exists to produce.
     */
    it('says what an empty section means', async () => {
      const { cookie } = await aPerson({ maintains: true })

      expect((await enquiriesAs(cookie)).body).toContain('Nobody has written in')
    })

    it('marks one as handled, and stops offering the button for it', async () => {
      const stored = await enquiries_.record(ENQUIRY)
      const { cookie } = await aPerson({ maintains: true })

      const response = await markHandled(cookie, stored.id)

      expect(response.statusCode).toBe(200)
      expect(await enquiries_.waiting()).toBe(0)
      expect(response.body).toContain('Marked as handled')
      expect(response.body).not.toContain(`/backend/enquiries/${stored.id}/handled`)
    })

    /** Pressing it twice is ordinary, and it is not an error. */
    it('says so plainly when it was already handled', async () => {
      const stored = await enquiries_.record(ENQUIRY)
      const { cookie } = await aPerson({ maintains: true })
      await markHandled(cookie, stored.id)

      const again = await markHandled(cookie, stored.id)

      expect(again.statusCode).toBe(200)
      expect(again.body).toContain('already handled')
    })

    /** The write is behind the same gate the page is, and refuses the same way. */
    it('refuses the write to somebody without the role', async () => {
      const stored = await enquiries_.record(ENQUIRY)
      const { cookie } = await aPerson()

      expect((await markHandled(cookie, stored.id)).statusCode).toBe(404)
      expect(await enquiries_.waiting()).toBe(1)
    })
  })

  it('answers on the console host and nowhere else', async () => {
    const { cookie } = await aPerson({ maintains: true })

    const response = await app.inject({
      method: 'GET',
      url: '/backend',
      headers: {
        host: API_HOST,
        accept: 'text/html',
        cookie: `__Host-kolonie_session=${cookie}`,
      },
    })

    expect(response.statusCode).toBe(404)
  })

  describe('the link on the signed-in home', () => {
    const homeAs = (cookie: string) =>
      app.inject({
        method: 'GET',
        url: '/',
        headers: {
          host: CONSOLE_HOST,
          accept: 'text/html',
          cookie: `__Host-kolonie_session=${cookie}`,
        },
      })

    it('is there when the role is held', async () => {
      const { cookie } = await aPerson({ maintains: true })

      expect((await homeAs(cookie)).body).toContain('href="/backend"')
    })

    /**
     * **Absent and not disabled.** A greyed-out link tells a person a surface
     * exists that they may not have, which is a fact about the Colony's shape
     * that a stranger who signed in with GitHub has no reason to be given.
     */
    it('is absent — not disabled — when it is not', async () => {
      const { cookie } = await aPerson()

      const body = (await homeAs(cookie)).body
      expect(body).not.toContain('/backend')
      expect(body).not.toContain('Running the Colony')
    })
  })
})

/**
 * `#487`. The two sections on `/backend`, from the route's side.
 *
 * The orderings and the twenty-row cap are SQL and are asserted against a real
 * Postgres in `packages/db`. What is asserted here is what the route is
 * responsible for: that both sections reach both representations, that each
 * carries its own moment, and that the gate covers them as it covers the page.
 */
describe('who arrived and what is waiting', () => {
  const aMaintainer = async () => {
    const human = humans_.store.holdsIdentity({
      provider: 'github',
      subject: `subject-${randomUUID()}`,
      email: 'someone@example.test',
    })
    humans_.store.maintains(human.id)
    const { session: cookie } = await humans_.store.openSession(human.id, {})
    return cookie
  }

  /**
   * Each section is its own page since `#775`, so the path is an argument. The
   * point of the split is that a request pays for the section it asked for, and
   * a test that still fetched one page for all of them would be asserting the
   * shape this replaced.
   */
  const backend = (cookie: string, path: string, accept = 'text/html') =>
    app.inject({
      method: 'GET',
      url: path,
      headers: { host: CONSOLE_HOST, accept, cookie: `__Host-kolonie_session=${cookie}` },
    })

  beforeEach(() => {
    quests.showsOnBackend({
      /**
       * `#607` replaced the name-time-and-path row with one that says enough to
       * notice a script. The fixture carries the whole shape; what these tests
       * assert is unchanged — that the section is rendered and gated.
       */
      arrivals: {
        agents: [
          {
            name: 'newest-arrival',
            registeredAt: '2026-08-06T12:00:00Z',
            path: 'mcp',
            runtime: 'openclaw',
            model: null,
            country: 'DE',
            origins: 1,
            originKey: 'origin-one',
            operated: false,
            operatorAgents: 0,
            operatorKey: null,
            mailboxDomain: null,
            calls: 3,
            attempts: 1,
            skills: 0,
            lastSeenAt: '2026-08-06T13:00:00Z',
            status: 'citizen',
            reputation: 5,
          },
          {
            name: 'earlier-arrival',
            registeredAt: '2026-08-01T12:00:00Z',
            path: 'web',
            runtime: 'claude',
            model: null,
            country: null,
            origins: 0,
            originKey: null,
            operated: false,
            operatorAgents: 0,
            operatorKey: null,
            mailboxDomain: null,
            calls: 0,
            attempts: 0,
            skills: 0,
            // The lost-key shape (`#1270`): never here, nothing done, nothing
            // earned — all four readable without leaving the page.
            lastSeenAt: null,
            status: 'candidate',
            reputation: 0,
          },
        ],
        people: [],
      },
      tickets: [
        { subject: 'waiting the longest', openedAt: '2026-07-01T12:00:00Z', status: 'open' },
        { subject: 'waiting less long', openedAt: '2026-08-01T12:00:00Z', status: 'open' },
      ],
    })
  })

  it('renders both sections for the maintainer, each on its own page', async () => {
    const cookie = await aMaintainer()

    const arrivals = (await backend(cookie, '/backend/arrivals')).body
    expect(arrivals).toContain('Who arrived')
    expect(arrivals).toContain('newest-arrival')
    expect(arrivals).toContain('earlier-arrival')

    const tickets = (await backend(cookie, '/backend/tickets')).body
    expect(tickets).toContain('Waiting to be read')
    expect(tickets).toContain('waiting the longest')
  })

  /**
   * **And neither page carries the other's read** (`#775`). This is the property
   * the split exists for: the section a maintainer opens is the only one the
   * request pays for, so the arrivals page must not contain a ticket.
   */
  it('pays for the section it was asked for and no other', async () => {
    const cookie = await aMaintainer()

    expect((await backend(cookie, '/backend/arrivals')).body).not.toContain('waiting the longest')
    expect((await backend(cookie, '/backend/tickets')).body).not.toContain('newest-arrival')
    // And the landing page is the numbers, not the nine sections it used to be.
    const landing = (await backend(cookie, '/backend')).body
    expect(landing).toContain('Computed at')
    expect(landing).not.toContain('newest-arrival')
    expect(landing).not.toContain('waiting the longest')
  })

  /** The order the sections arrive in is the order they are shown in. */
  it('shows the longest-waiting ticket above the others', async () => {
    const body = (await backend(await aMaintainer(), '/backend/tickets')).body

    expect(body.indexOf('waiting the longest')).toBeLessThan(body.indexOf('waiting less long'))
  })

  /**
   * `#487` drew the line at name, timestamp and path. **`#607` moved it**, with
   * the argument that nothing on that row could tell a citizen from forty
   * accounts opened by a script — and it moved it to a *domain, never an
   * address; a count, never a list of who*. So what is asserted here is the new
   * line rather than the old one.
   */
  it('shows what the richer row is for, and no balance', async () => {
    const body = (await backend(await aMaintainer(), '/backend/arrivals')).body

    expect(body).toContain('<th>How</th>')
    expect(body).toContain('<th>Runtime</th>')
    expect(body).toContain('<th>Origins</th>')
    expect(body).not.toContain('Balance')
  })

  /**
   * **The rejection case `#607` asks for: nothing here reaches a published
   * figure.** `kolonie-docs#216` decides what may be shown outside, and this
   * section changes none of it — so the Colony's own aggregates, the nearest
   * thing to a published surface, must carry none of the new fields.
   *
   * **Read off `/backend` since `#943`**, which deleted the `/numbers` page this
   * used to ask. Same figures, same query, one gate fewer.
   */
  it('reaches no published figure', async () => {
    const numbers = await backend(await aMaintainer(), '/backend', 'application/json')

    const serialised = JSON.stringify(numbers.json().numbers)
    for (const field of ['originKey', 'operatorKey', 'mailboxDomain', 'emailDomain', 'arrivals']) {
      expect(serialised).not.toContain(field)
    }
  })

  /**
   * **One JSON body per question** (`#775`). Asking for arrivals returns
   * arrivals: before the split a caller wanting one section was handed all nine
   * and paid nine queries for it.
   */
  it('carries each section in its own JSON representation, with its own moment', async () => {
    const cookie = await aMaintainer()

    const arrivals = (await backend(cookie, '/backend/arrivals', 'application/json')).json()
    expect(arrivals.arrivals.agents).toHaveLength(2)
    expect(arrivals.arrivals.computedAt).toEqual(expect.any(String))
    expect(arrivals.tickets).toBeUndefined()

    const tickets = (await backend(cookie, '/backend/tickets', 'application/json')).json()
    expect(tickets.tickets.rows).toHaveLength(2)
    expect(tickets.tickets.computedAt).toEqual(expect.any(String))

    // And the numbers keep their own, which is a third and is not shared.
    const numbers = (await backend(cookie, '/backend', 'application/json')).json()
    expect(numbers.numbers.computedAt).toEqual(expect.any(String))
    expect(numbers.arrivals).toBeUndefined()
  })

  /**
   * Where the Colony knows nothing (`#611`).
   *
   * *Forty briefings* reads as coverage; this names the tasks with no reports
   * and puts the attempt count beside each, which is what separates *nobody has
   * tried this* from *nobody ever struggles with it*.
   */
  it('names the tasks nobody has reported on, with their attempt counts', async () => {
    quests.showsOnBackend({
      unreported: [
        { taskId: randomUUID(), title: 'Come back the way you said you would', attempts: 12 },
      ],
    })

    const body = (await backend(await aMaintainer(), '/backend/unreported')).body

    expect(body).toContain('What nobody has reported on')
    expect(body).toContain('Come back the way you said you would')
    expect(body).toContain('>12<')
  })

  it('says so plainly when there is nothing in either', async () => {
    quests.showsOnBackend({ arrivals: { agents: [], people: [] }, tickets: [] })
    const cookie = await aMaintainer()

    expect((await backend(cookie, '/backend/tickets')).body).toContain('Nothing is waiting')
    expect((await backend(cookie, '/backend/arrivals')).body).toContain(
      'something is wrong rather than quiet',
    )
  })

  /**
   * The sections are behind the same gate as the landing page, not beside it —
   * and `#775` made that nine gates rather than one, so every one is asked.
   */
  it('shows no section to somebody without the role', async () => {
    const human = humans_.store.holdsIdentity({
      provider: 'github',
      subject: `subject-${randomUUID()}`,
      email: 'someone@example.test',
    })
    const { session: cookie } = await humans_.store.openSession(human.id, {})

    for (const path of [
      '/backend',
      '/backend/arrivals',
      '/backend/quests',
      '/backend/moderation',
      '/backend/briefings',
      '/backend/unreported',
      '/backend/tickets',
      '/backend/enquiries',
      '/backend/wanted',
      '/backend/atlas',
      '/backend/settings',
    ]) {
      const response = await backend(cookie, path)

      expect(response.statusCode).toBe(404)
      expect(response.body).not.toContain('newest-arrival')
      expect(response.body).not.toContain('waiting the longest')
    }
  })
})

/** `#814`: the verdicts the Colony reached about quests, readable without psql. */
describe('the Colony’s quest moderation history', () => {
  const aMaintainer = async () => {
    const human = humans_.store.holdsIdentity({
      provider: 'github',
      subject: `subject-${randomUUID()}`,
      email: 'someone@example.test',
    })
    humans_.store.maintains(human.id)
    const { session: cookie } = await humans_.store.openSession(human.id, {})
    return cookie
  }

  const backend = (cookie: string, path = '/backend/moderation', accept = 'text/html') =>
    app.inject({
      method: 'GET',
      url: path,
      headers: { host: CONSOLE_HOST, accept, cookie: `__Host-kolonie_session=${cookie}` },
    })

  const rejectedStages = () => ({
    ...noStagesRun(),
    redLine: { outcome: 'crossed', reason: 'The quest asks for a credential.' },
  })

  it('shows the verdict, model, stages and monthly refusal rate without the judged text', async () => {
    quests.showsOnBackend({
      moderations: [
        {
          subject: { id: randomUUID() as never, title: 'A billing question' },
          decision: 'rejected',
          refusalReason: 'The quest asks for a credential.',
          refusedAt: 'redLine',
          model: 'model-two',
          stages: rejectedStages(),
          createdAt: '2026-08-12T10:00:00.000Z' as never,
        },
        {
          subject: { id: randomUUID() as never, title: 'A registration question' },
          decision: 'approved',
          refusalReason: null,
          refusedAt: null,
          model: 'model-one',
          stages: noStagesRun(),
          createdAt: '2026-08-01T10:00:00.000Z' as never,
        },
      ],
    })

    const cookie = await aMaintainer()
    const page = await backend(cookie)

    expect(page.statusCode).toBe(200)
    expect(page.body).toContain('Moderation verdicts')
    expect(page.body).toContain('A billing question')
    expect(page.body).toContain('rejected')
    expect(page.body).toContain('model-two')
    expect(page.body).toContain('The quest asks for a credential.')
    expect(page.body).toContain('2026-08')
    expect(page.body).toContain('50.0%')
    expect(page.body).not.toContain('content_sha256')
    expect(page.body).not.toContain('Text the moderation history must not return')

    const json = (await backend(cookie, '/backend/moderation', 'application/json')).json()
    expect(json.moderations).toHaveLength(2)
    expect(json.trend[0]).toMatchObject({ month: '2026-08', verdicts: 2 })
    expect(JSON.stringify(json)).not.toContain('contentSha256')
  })

  it('filters rows by decision without turning the refusal rate into a tautology', async () => {
    quests.showsOnBackend({
      moderations: [
        {
          subject: { id: randomUUID() as never, title: 'A registration question' },
          decision: 'rejected',
          refusalReason: 'The quest asks for a credential.',
          refusedAt: 'redLine',
          model: 'model-two',
          stages: rejectedStages(),
          createdAt: '2026-08-12T10:00:00.000Z' as never,
        },
        {
          subject: { id: randomUUID() as never, title: 'Another registration question' },
          decision: 'approved',
          refusalReason: null,
          refusedAt: null,
          model: 'model-one',
          stages: noStagesRun(),
          createdAt: '2026-08-01T10:00:00.000Z' as never,
        },
      ],
    })
    const cookie = await aMaintainer()

    const response = await backend(
      cookie,
      '/backend/moderation?subject=registration&decision=rejected',
      'application/json',
    )

    expect(quests.moderationAsked).toEqual([{ subject: 'registration' }])
    expect(response.json().moderations).toHaveLength(1)
    expect(response.json().moderations[0].decision).toBe('rejected')
    expect(response.json().trend[0].refusalRate).toBe(0.5)
  })

  it('rejects an unknown decision before it reaches the store', async () => {
    const response = await backend(
      await aMaintainer(),
      '/backend/moderation?decision=pending',
      'application/json',
    )

    expect(response.statusCode).toBe(ERROR_STATUS.validation_failed)
    expect(response.json().code).toBe('validation_failed')
    expect(quests.moderationAsked).toEqual([])
  })

  it('shows no moderation history to somebody without the role', async () => {
    const human = humans_.store.holdsIdentity({
      provider: 'github',
      subject: `subject-${randomUUID()}`,
      email: 'someone@example.test',
    })
    const { session: cookie } = await humans_.store.openSession(human.id, {})

    const response = await backend(cookie)

    expect(response.statusCode).toBe(404)
    expect(response.body).not.toContain('Moderation verdicts')
    expect(quests.moderationAsked).toEqual([])
  })
})

/**
 * `#776`. Every quest in the Colony, for the person running it.
 *
 * The unscoped reads themselves are SQL and are asserted against a real Postgres
 * in `packages/db` — including that the accepted count and the sponsor's own
 * results page cannot disagree. What is asserted here is what the two routes owe:
 * that a quest nobody signed in wrote is on the list, that the author is named
 * and not linked, that the detail page can change nothing, and that both are
 * behind the same gate as the rest of `/backend`.
 */
describe('every quest in the Colony', () => {
  const aMaintainer = async () => {
    const human = humans_.store.holdsIdentity({
      provider: 'github',
      subject: `subject-${randomUUID()}`,
      email: 'someone@example.test',
    })
    humans_.store.maintains(human.id)
    const { session: cookie } = await humans_.store.openSession(human.id, {})
    return cookie
  }

  const backend = (cookie: string, path: string, accept = 'text/html') =>
    app.inject({
      method: 'GET',
      url: path,
      headers: { host: CONSOLE_HOST, accept, cookie: `__Host-kolonie_session=${cookie}` },
    })

  /** A quest written by the agent, which is nobody the maintainer operates. */
  const aQuest = async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/quests',
      headers: {
        host: CONSOLE_HOST,
        accept: 'text/html',
        cookie: `__Host-kolonie_session=${session}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams({
        title: 'A thousand registrations',
        description: 'What this quest is, for a human reading the catalogue.',
        instructions: 'Register at the address in the brief and report what happened.',
        questions: JSON.stringify([
          { key: 'went-well', prompt: 'How did it go?', required: true },
          { key: 'blocked', prompt: 'Were you blocked?', required: false, options: ['yes', 'no'] },
        ]),
        slots: '10',
        rewardSol: '0',
        expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10),
        minReputation: '0',
        audience: 'citizens',
        proofVerifier: 'email-inbox',
      }).toString(),
    })

    const location = created.headers['location'] as string
    return location.split('/').pop() as string
  }

  it('lists a quest the maintainer did not write, and names its author', async () => {
    quests.setAuthorName(agentId as never, 'first-citizen')
    const questId = await aQuest()

    const body = (await backend(await aMaintainer(), '/backend/quests')).body

    expect(body).toContain('Every quest')
    expect(body).toContain('A thousand registrations')
    expect(body).toContain('first-citizen')
    expect(body).toContain(`href="/backend/quests/${questId}"`)
    /**
     * **Named, never linked** — `/agents/:agentId` is behind `operatedAgent`, so
     * a link from here would be a 404 for every agent this person does not
     * operate, which is what `console-links.test.ts` crawls for.
     */
    expect(body).not.toContain(`href="/agents/${agentId}"`)
  })

  /** Erasure takes the agent row and leaves the quest, so the page says which. */
  it('says so where the author has erased itself', async () => {
    await aQuest()

    const body = (await backend(await aMaintainer(), '/backend/quests')).body

    expect(body).toContain('an erased citizen')
  })

  it('reads one quest to the end, and can change nothing about it', async () => {
    quests.setAuthorName(agentId as never, 'first-citizen')
    const questId = await aQuest()

    const page = await backend(await aMaintainer(), `/backend/quests/${questId}`)

    expect(page.statusCode).toBe(200)
    expect(page.body).toContain('A thousand registrations')
    expect(page.body).toContain('Register at the address in the brief')
    expect(page.body).toContain('went-well')
    /**
     * **The read-only property, asserted rather than intended.** `#776` asks for
     * a page that ends, publishes and refuses nothing — and the only way to keep
     * that true through a later edit is to fail on the first `<form` anybody adds.
     *
     * Scoped to the page's own content: the shell's masthead carries the
     * sign-out, which is a form on every signed-in page and is not this page's.
     */
    const content = page.body.slice(
      page.body.indexOf('<main class="console-main">'),
      page.body.indexOf('</main>'),
    )
    expect(content).toContain('A thousand registrations')
    expect(content).not.toContain('<form')
  })

  /**
   * The criterion `#776` left open until `kolonie-docs#311` was written, and the
   * condition that issue attached to it.
   */
  it('shows the citizens’ answers, and records that they were read', async () => {
    const questId = await aQuest()
    // Accepted through the fixture, because only a verdict accepts a report in
    // the real one and the verifier runner is another workspace (`#178`).
    quests.accept({
      taskId: questId as never,
      answers: { 'went-well': 'The address resolved on the second try.' },
    })
    const maintainer = await aMaintainer()

    const page = await backend(maintainer, `/backend/quests/${questId}`)

    expect(page.body).toContain('The address resolved on the second try.')
    // A rule whose enforcement is invisible to the person it constrains is one
    // they cannot reason about — and this reader is who an auditor will ask.
    expect(page.body).toContain('recorded that you read them')
    expect(quests.reportReads).toHaveLength(1)
    expect(quests.reportReads[0]?.taskId).toBe(questId)
  })

  it('records the read for a JSON caller too, who reads the same text', async () => {
    const questId = await aQuest()
    quests.accept({ taskId: questId as never, answers: { 'went-well': 'It worked.' } })

    const response = await backend(
      await aMaintainer(),
      `/backend/quests/${questId}`,
      'application/json',
    )

    // A record on the HTML branch alone would be a rule that stops applying to
    // whoever asks with an `Accept` header.
    expect(JSON.stringify(response.json())).toContain('It worked.')
    expect(quests.reportReads).toHaveLength(1)
  })

  it('says nothing was written yet rather than showing an empty table', async () => {
    const questId = await aQuest()

    const page = await backend(await aMaintainer(), `/backend/quests/${questId}`)

    // Different from a report the Colony is holding back, which is counted.
    expect(page.body).toContain('No accepted report has been written yet')
  })

  it('answers 404 for a quest that does not exist, and never 403', async () => {
    const page = await backend(await aMaintainer(), `/backend/quests/${randomUUID()}`)

    expect(page.statusCode).toBe(404)
  })

  it('shows neither page to somebody without the role', async () => {
    const questId = await aQuest()
    const human = humans_.store.holdsIdentity({
      provider: 'github',
      subject: `subject-${randomUUID()}`,
      email: 'someone@example.test',
    })
    const { session: cookie } = await humans_.store.openSession(human.id, {})

    for (const path of ['/backend/quests', `/backend/quests/${questId}`]) {
      const response = await backend(cookie, path)

      expect(response.statusCode).toBe(404)
      expect(response.body).not.toContain('A thousand registrations')
    }
  })

  it('carries the list and the quest in their own JSON representations', async () => {
    const questId = await aQuest()
    const cookie = await aMaintainer()

    const list = (await backend(cookie, '/backend/quests', 'application/json')).json()
    expect(list.quests).toHaveLength(1)
    expect(list.limit).toEqual(expect.any(Number))

    const one = (await backend(cookie, `/backend/quests/${questId}`, 'application/json')).json()
    expect(one.quest.title).toBe('A thousand registrations')
    // The reports' text is not in the JSON either, which is where a leak would be.
    expect(JSON.stringify(one)).not.toContain('acceptedAt')
  })
})

/**
 * `#489`, against D-104. A maintainer could not change a setting without editing
 * the deploy host and restarting a container.
 *
 * The table, the `on conflict` and the audit row are `packages/db`'s and are
 * asserted there. What is asserted here is what the surface owes: one form per
 * value, the source line, validation before the write, clearing as its own act,
 * and the whole section absent for anybody without the role.
 */
describe('the settings a maintainer turns', () => {
  const aMaintainer = async () => {
    const human = humans_.store.holdsIdentity({
      provider: 'github',
      subject: `subject-${randomUUID()}`,
      email: 'someone@example.test',
    })
    humans_.store.maintains(human.id)
    const { session: cookie } = await humans_.store.openSession(human.id, {})
    return cookie
  }

  /** Its own page since `#775`, and the one the two POSTs come back to. */
  const backend = (cookie: string) =>
    app.inject({
      method: 'GET',
      url: '/backend/settings',
      headers: {
        host: CONSOLE_HOST,
        accept: 'text/html',
        cookie: `__Host-kolonie_session=${cookie}`,
      },
    })

  const set = (cookie: string, name: string, value: string) =>
    app.inject({
      method: 'POST',
      url: `/backend/settings/${name}`,
      headers: {
        host: CONSOLE_HOST,
        accept: 'text/html',
        cookie: `__Host-kolonie_session=${cookie}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: `value=${encodeURIComponent(value)}`,
    })

  const clear = (cookie: string, name: string) =>
    app.inject({
      method: 'POST',
      url: `/backend/settings/${name}/clear`,
      headers: {
        host: CONSOLE_HOST,
        accept: 'text/html',
        cookie: `__Host-kolonie_session=${cookie}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: '',
    })

  it('lists every setting with a sentence, not just its name', async () => {
    const body = (await backend(await aMaintainer())).body

    expect(body).toContain('Settings')
    expect(body).toContain('POLL_INTERVAL_MS')
    // `MODERATION_MODEL` means nothing at two in the morning; the sentence is
    // what the issue asks for and this is it.
    expect(body).toContain('How long a runner waits between passes over its queue')
  })

  /**
   * **Where the value comes from** — the one `#489` calls easy to leave out.
   * Under D-104 the database always wins, so this line is what tells a
   * maintainer their value is *still* the environment's.
   */
  it('says whether each value is the database’s or the environment’s', async () => {
    const cookie = await aMaintainer()
    settings_.environment('TRIAGE_MODEL', 'someone/a-model')
    settings_.overrides('POLL_INTERVAL_MS', '30000')

    const body = (await backend(cookie)).body

    expect(body).toContain('From the environment')
    expect(body).toContain('This is what is in effect')
  })

  it('sets one value and comes back to the page', async () => {
    const cookie = await aMaintainer()

    const response = await set(cookie, 'POLL_INTERVAL_MS', '45000')

    expect(response.statusCode).toBe(303)
    expect(response.headers['location']).toBe('/backend/settings')
    expect(settings_.written()).toEqual([
      expect.objectContaining({ name: 'POLL_INTERVAL_MS', value: '45000' }),
    ])
  })

  /**
   * **Validated against the same schema the reader uses, before the write.** A
   * poll interval of `0` is something a text box will happily accept and a
   * runner will not survive.
   */
  it('refuses a value the runner would not survive, and writes nothing', async () => {
    const cookie = await aMaintainer()

    const response = await set(cookie, 'POLL_INTERVAL_MS', '0')

    expect(response.statusCode).toBe(400)
    expect(settings_.written()).toEqual([])
    // And says what was wrong, on the page they are already looking at.
    expect(response.body).toContain('POLL_INTERVAL_MS')
    expect(response.body).toContain('greater than zero')
  })

  it('refuses a model name that is not a model reference', async () => {
    const cookie = await aMaintainer()

    const response = await set(cookie, 'TRIAGE_MODEL', 'not a model')

    expect(response.statusCode).toBe(400)
    expect(settings_.written()).toEqual([])
  })

  /**
   * **A name outside the allow-list is refused, not unsupported** (D-104). The
   * console's 404 rather than an error naming what it is not — a message
   * confirming that `DATABASE_URL` is *not a setting* is still a message about
   * `DATABASE_URL`.
   */
  it('refuses a name that is not a setting at all', async () => {
    const cookie = await aMaintainer()

    for (const name of ['DATABASE_URL', 'CLOUDFLARE_EMAIL_SEND_TOKEN', 'PORT']) {
      const response = await set(cookie, name, 'anything')
      expect(response.statusCode).toBe(404)
    }
    expect(settings_.written()).toEqual([])
  })

  /**
   * **Clearing is its own action and its own POST**, because putting a value
   * back is not the same as writing the old number — the old number may itself
   * have been an override.
   */
  it('clears one back to the environment’s value', async () => {
    const cookie = await aMaintainer()
    settings_.overrides('POLL_INTERVAL_MS', '30000')

    const response = await clear(cookie, 'POLL_INTERVAL_MS')

    expect(response.statusCode).toBe(303)
    expect(settings_.cleared()).toEqual(['POLL_INTERVAL_MS'])
  })

  /** The clear button is offered only where there is something to clear. */
  it('offers the clear form only for an overridden setting', async () => {
    const cookie = await aMaintainer()

    const before = (await backend(cookie)).body
    expect(before).not.toContain('/backend/settings/POLL_INTERVAL_MS/clear')

    settings_.overrides('POLL_INTERVAL_MS', '30000')
    const after = (await backend(cookie)).body
    expect(after).toContain('/backend/settings/POLL_INTERVAL_MS/clear')
  })

  /**
   * **One form and one POST per value.** A page-wide save writes every setting
   * on it, so a stale tab loaded before somebody else's change silently reverts
   * it — which is the failure this shape exists to make impossible.
   */
  it('gives each setting its own form and its own action', async () => {
    const body = (await backend(await aMaintainer())).body

    expect(body).toContain('action="/backend/settings/POLL_INTERVAL_MS"')
    expect(body).toContain('action="/backend/settings/TRIAGE_MODEL"')
  })

  describe('for somebody without the role', () => {
    const aPerson = async () => {
      const human = humans_.store.holdsIdentity({
        provider: 'github',
        subject: `subject-${randomUUID()}`,
        email: 'someone@example.test',
      })
      const { session: cookie } = await humans_.store.openSession(human.id, {})
      return cookie
    }

    /** *Absent rather than read-only for them*, which is the issue's wording. */
    it('reaches none of it', async () => {
      const cookie = await aPerson()

      expect((await backend(cookie)).statusCode).toBe(404)
      expect((await set(cookie, 'POLL_INTERVAL_MS', '45000')).statusCode).toBe(404)
      expect((await clear(cookie, 'POLL_INTERVAL_MS')).statusCode).toBe(404)
      expect(settings_.written()).toEqual([])
    })

    it('cannot write one with an agent’s key either', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/backend/settings/POLL_INTERVAL_MS',
        headers: {
          host: CONSOLE_HOST,
          accept: 'application/json',
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        payload: { value: '45000' },
      })

      expect(response.statusCode).toBe(404)
      expect(settings_.written()).toEqual([])
    })
  })
})

/**
 * `#928`: what the operator's own accounts page reads, and whose (`#452`).
 *
 * The renderer's tests assert what a row looks like. This one asserts the thing
 * a renderer cannot: that the rows are the operated agent's and nobody else's.
 * The guarantee lives in the `where` clause of the read, so it is asked here,
 * through the route, against a register holding two agents' accounts.
 */
describe('the accounts page an operator reads', () => {
  const anOperator = async () => {
    const human = humans_.store.holdsIdentity({
      provider: 'github',
      subject: `subject-${randomUUID()}`,
      email: 'someone@example.test',
    })
    const issued = store.issue({})
    humans_.store.operatesAgent(human.id, issued.agent)
    pages_.exists(issued.agent.id)
    const { session: cookie } = await humans_.store.openSession(human.id, {})

    return { cookie, agent: issued.agent }
  }

  const accountsPage = (cookie: string, id: string) =>
    app.inject({
      method: 'GET',
      url: `/agents/${id}/accounts`,
      headers: {
        host: CONSOLE_HOST,
        accept: 'text/html',
        cookie: `__Host-kolonie_session=${cookie}`,
      },
    })

  it('shows the accounts of the agent whose page it is', async () => {
    const { cookie, agent } = await anOperator()
    register_.proveDirectly(agent.id, {
      kind: AccountKindSchema.parse('mailbox'),
      identifier: 'ariadne@mail.example',
      provider: 'mail.example',
    })

    const body = (await accountsPage(cookie, String(agent.id))).body

    expect(body).toContain('ariadne@mail.example')
    expect(body).toContain('proved — the Colony read it')
  })

  /**
   * The rejection case the issue names, and the reason the read is scoped rather
   * than the markup: another citizen's address on this page would be the Colony
   * publishing something that was never its to publish.
   */
  it('shows no identifier belonging to another agent', async () => {
    const { cookie, agent } = await anOperator()
    const stranger = store.issue({})
    register_.proveDirectly(stranger.agent.id, {
      kind: AccountKindSchema.parse('mailbox'),
      identifier: 'somebody-else@mail.example',
      provider: 'mail.example',
    })

    const body = (await accountsPage(cookie, String(agent.id))).body

    expect(body).not.toContain('somebody-else@mail.example')
    expect(body).toContain('Nothing here yet')
  })
})
