import { randomUUID } from 'node:crypto'
import { fakeHumans } from '../__fixtures__/humans.js'
import { fakeArtefactChallenges } from '../__fixtures__/artefact.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_PLATFORM_FEE_PERCENT, ERROR_STATUS, questFeeBreakdown } from '@kolonie-ai/core'
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
import { fakeSms } from '../__fixtures__/sms.js'
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
import { fakeConsole, recordingLog, type RecordingLog } from '../__fixtures__/console.js'
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
let humans_: ReturnType<typeof fakeHumans>

beforeEach(async () => {
  store = fakeStore()
  quests = fakeQuests()
  console_ = { ...fakeConsole(), consoleUrl: CONSOLE_URL }
  humans_ = fakeHumans()
  app = buildApp({
    humans: humans_,
    vault: { vault: fakeVault() },
    accounts: fakeAccounts(),
    console: console_,
    email: fakeEmail(),
    sms: fakeSms(),
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
    artefact: fakeArtefactChallenges(),
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
    expect(response.body).toContain('Your account is open')
    expect(console_.store.tokens()).toHaveLength(1)
    expect(console_.mailer.sent()[0]?.to).toBe('stranger@example.org')
  })

  /**
   * The confirmation describes the act the reader performed (`#398`).
   *
   * It borrowed the sign-in page's *"if that address belongs to an account"* —
   * conditional wording whose whole purpose is to conceal who is registered here,
   * shown to somebody who had just asked to register and knew perfectly well what
   * they had asked for. It answered a question they had not asked and left theirs
   * open.
   */
  it('confirms that an account was opened, and does not borrow the sign-in wording', async () => {
    const response = await signUp('email=plainly%40example.org')

    expect(response.body).toContain('Your account is open')
    expect(response.body).not.toContain('If that address belongs to an account')
    // And what they now have, which is nothing.
    expect(response.body).toContain('no skills, no reputation')
  })

  /**
   * **The sign-in route keeps its ambiguity, and the asymmetry is deliberate.**
   * Sign-up has nothing to conceal — the person asking is the person told — and
   * sign-in has everything to conceal, because anyone may type any address into
   * it. The two pages must not be tidied into one.
   */
  it('leaves the sign-in route unable to say whether an address has an account', async () => {
    console_.store.hold('registered@example.org')

    const known = await app.inject({
      method: 'POST',
      url: '/sign-in',
      headers: {
        host: CONSOLE_HOST,
        accept: 'text/html',
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: 'email=registered%40example.org',
    })

    const stranger = await app.inject({
      method: 'POST',
      url: '/sign-in',
      headers: {
        host: CONSOLE_HOST,
        accept: 'text/html',
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: 'email=nobody%40example.org',
    })

    expect(known.body).toBe(stranger.body)
    expect(known.body).toContain('If that address belongs to an account')
    expect(known.body).not.toContain('Your account is open')
  })

  /**
   * **The form must not become an oracle.** A taken address creates nothing and
   * mails nothing, and a stranger cannot tell the two cases apart — which is
   * `signUp`'s own rule, asserted at the surface a stranger actually reaches.
   */
  it('answers a taken address exactly as it answers a fresh one', async () => {
    console_.store.hold('known@example.org')
    const fresh = await signUp('email=unknown%40example.org')

    const response = await signUp('email=known%40example.org')

    expect(response.statusCode).toBe(200)
    expect(response.body).toBe(fresh.body)
    expect(console_.mailer.sent().map((mail) => mail.to)).toEqual(['unknown@example.org'])
  })

  /**
   * The first mail an account gets says which act produced it (`#398`). A person
   * who clicked *Open an account* and read *somebody asked to sign in* had to
   * work out whether their click had done anything.
   */
  it('mails a new account something other than a sign-in link', async () => {
    await signUp('email=opened%40example.org')
    const opening = console_.mailer.sent()[0]

    console_.store.hold('returning@example.org')
    await app.inject({
      method: 'POST',
      url: '/sign-in',
      headers: {
        host: CONSOLE_HOST,
        accept: 'text/html',
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: 'email=returning%40example.org',
    })
    const returning = console_.mailer.sent()[1]

    expect(opening?.subject).not.toBe(returning?.subject)
    expect(opening?.subject).toContain('account is open')
    expect(opening?.text).toContain('Your Kolonie sponsor account is open')
    expect(opening?.text).not.toContain('asked to sign in')
    expect(returning?.subject).toBe('Your Kolonie sign-in link')
    expect(returning?.text).toContain('asked to sign in')
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
    // The note said *An agent may hold a sponsor account* until `#468`. What it
    // has to carry is the half an agent needs: this page is not the way in.
    expect(response.body).toContain('registered over MCP needs no form at all')
    expect(response.body).toContain('API key')
    // The one field, and no second one asking for a name.
    expect(response.body).toContain('id="sign-up-email"')
    expect(response.body).not.toContain('id="sign-up-name"')
  })

  /**
   * The console stops naming a kind of account the Colony does not have
   * (`#468`).
   *
   * `kolonie-docs#184` settled that there are two kinds of account — a human
   * account and an agent — and that *sponsor* stays a role in a transaction
   * while it stops naming an account, a page, a flag, an audience or a table.
   * The site landed this in `kolonie-website#55`; this is the surface where a
   * person actually met the word.
   *
   * **Asserted against the rendered page rather than the source**, because the
   * source still carries the retired phrase in the comments that explain why it
   * went — and a test that failed on those would be a test nobody could keep.
   */
  it('offers no sponsor account anywhere on the page a stranger arrives at', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/',
      headers: { host: CONSOLE_HOST, accept: 'text/html' },
    })

    // The rejection case: the retired phrase, in any casing, on a rendered page.
    expect(response.body.toLowerCase()).not.toContain('sponsor account')
    expect(response.body.toLowerCase()).not.toContain('open a sponsor')
  })

  /**
   * The form creates an agent, and now says so.
   *
   * `registerWeb` makes an ordinary `agents` row. *Open a sponsor account* was
   * wrong in both halves — it is not opening an account, and there is no sponsor
   * account — so the heading names what is created and the sentence says what it
   * is for.
   */
  it('says the second form creates an agent, and what that agent is for', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/',
      headers: { host: CONSOLE_HOST, accept: 'text/html' },
    })

    expect(response.body).toContain('creates an agent of your own')
    expect(response.body).toContain('Quests and the money that funds them')
    // What it confers is still nothing, which is the sentence `#266` put here
    // and `#184` does not weaken.
    expect(response.body).toContain('no skills, no reputation')
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
      log,
      humans: fakeHumans(),
      vault: { vault: fakeVault() },
      accounts: fakeAccounts(),
      console: { ...fakeConsole(), consoleUrl: CONSOLE_URL },
      email: fakeEmail(),
      sms: fakeSms(),
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
      artefact: fakeArtefactChallenges(),
      website: fakeWebsite(),
      webServer: fakeWebServer(),
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
   * Nobody meets the platform fee after the work is done (`#463`).
   *
   * The three figures the sponsor decides on — funded, to citizens, the Colony's
   * share — with capacity multiplied through, because *250 per report × 40
   * reports* is the number that changes a mind and *25 %* is not.
   */
  it('shows the split before the quest is published, capacity multiplied through', async () => {
    const created = await postForm('/quests', aForm({ rewardCredits: '1000', slots: '40' }))
    const draft = await asBrowser(created.headers['location'] as string, { signedIn: true })

    const split = questFeeBreakdown({
      credits: 1000,
      slots: 40,
      feePercent: DEFAULT_PLATFORM_FEE_PERCENT,
    })

    // The rejection case: a figure on this page that is not what the payout
    // computes fails here. Nothing in the console does its own arithmetic.
    expect(draft.body).toContain(String(split.funded))
    expect(draft.body).toContain(String(split.toCitizens))
    expect(draft.body).toContain(String(split.toColony))
    expect(draft.body).toContain(`${DEFAULT_PLATFORM_FEE_PERCENT}%`)
    // Named, not implied by a bare percentage.
    expect(draft.body).toContain('platform fee')
  })

  /**
   * At the pilot's one cent the fee rounds away, and the page says the citizen
   * receives the whole amount rather than printing a zero that reads as a
   * charge.
   */
  it('says the Colony takes nothing where the fee rounds to zero', async () => {
    const created = await postForm('/quests', aForm({ rewardCredits: '1', slots: '10' }))
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
      // 10 × 100 for the answers plus 150 for the obstacle pool (`#371`), so the
      // balance that covers this quest is larger than it was.
      quests.credit(agentId as never, 1150)
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

  /** The sponsor deciding how to start is told the choice is not permanent. */
  it('says on the sign-in page that starting in a browser is not a one-way door', async () => {
    const signIn = await asBrowser('/')

    expect(signIn.body).toContain('does not shut the other door')
  })
})

/**
 * `#486`. There was no page that answered *how is the Colony doing* to the
 * person running it. `/numbers` is the nearest thing and is neither reachable by
 * a person — it gates on the **agent** role `steward` — nor the whole picture,
 * being one table of aggregates.
 *
 * What is asserted here is the gate, in all four of its states, and that the
 * figures are the steward page's figures rather than a second query.
 */
describe('the maintainer’s page', () => {
  /** Sign a person in, optionally holding the role. */
  const aPerson = async (options: { readonly maintains?: boolean } = {}) => {
    const { human } = await humans_.store.findOrCreate({
      provider: 'github',
      subject: `subject-${randomUUID()}`,
      email: 'someone@example.test',
    })
    if (options.maintains === true) humans_.store.maintains(human.id)
    const { session: cookie } = await humans_.store.openSession(human.id, {})
    return { human, cookie }
  }

  const backendAs = (cookie: string | undefined, accept = 'text/html') =>
    app.inject({
      method: 'GET',
      url: '/backend',
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
    // The numbers section, which is the steward page's own rendering.
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
