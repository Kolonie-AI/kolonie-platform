import { fakeHumans } from '../__fixtures__/humans.js'
import { fakeArtefactChallenges } from '../__fixtures__/artefact.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app.js'
import { fakeRegistry } from '../__fixtures__/registry.js'
import { fakeStore, type FakeStore } from '../__fixtures__/store.js'
import { fakeCatalogue } from '../__fixtures__/catalogue.js'
import { fakeQuests } from '../__fixtures__/quests.js'
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
import { fakeKeys } from '../__fixtures__/keys.js'
import { fakeSolana } from '../__fixtures__/solana.js'
import { fakeVision } from '../__fixtures__/vision.js'
import { fakePow } from '../__fixtures__/proof-of-work.js'
import { fakeMemory } from '../__fixtures__/memory.js'
import { fakeGithub, fakeContributions } from '../__fixtures__/github.js'
import { fakeStandingHints } from '../__fixtures__/hints.js'
import { fakeWakeup } from '../__fixtures__/wakeup.js'
import { fakeAutonomy } from '../__fixtures__/autonomy.js'
import { fakeOperatorClaim } from '../__fixtures__/operator-claim.js'
import { fakeSocial } from '../__fixtures__/social.js'
import { fakeDomainChallenges } from '../__fixtures__/domain.js'
import { fakeWebServer } from '../__fixtures__/web-server.js'
import { fakeWake } from '../__fixtures__/wake.js'
import { fakeWishList } from '../__fixtures__/account-wishes.js'
import { fakeWebsite } from '../__fixtures__/website.js'
import { fakeImage } from '../__fixtures__/image.js'
import { fakeScene } from '../__fixtures__/scene.js'
import { fakeInjection } from '../__fixtures__/injection.js'
import { fakeVetting } from '../__fixtures__/vetting.js'
import { fakeAuthenticator } from '../__fixtures__/authenticator.js'
import { fakeVault } from '../__fixtures__/vault.js'
import { fakeAccounts } from '../__fixtures__/accounts.js'
import { fakeConsole } from '../__fixtures__/console.js'
import { fakeErasureDesk } from '../__fixtures__/erasure.js'
import { erasure } from '../erasure.js'
import { noObstruction } from '../__fixtures__/obstruction.js'

import { fixedWindowLimiter } from '../rate-limit.js'
import type { ReachabilityFetch } from '../reachability.js'

/**
 * The route half of `#394` — that the tool is authenticated, that the allowance
 * refuses with a time, and that a citizen which has only ever called this holds
 * nothing.
 *
 * Every address is a documentation example. Nothing here touches a network: the
 * fetch is injected, and the tests about refusals inject one that throws if it
 * is called at all.
 */
let app: FastifyInstance
let store: FakeStore
let apiKey: string
let issued: ReturnType<FakeStore['issue']>

/** Answers 200 and never touches a network. */
const answering: ReachabilityFetch = async () => new Response(null, { status: 200 })

/** Nothing may call this. Passed where the point is that no request is made. */
const forbidden: ReachabilityFetch = async () => {
  throw new Error('the Colony made a request it should have refused')
}

let reachabilityFetch: ReachabilityFetch = answering
/**
 * Deliberately tiny here, where the real allowance is sixty (`REACHABILITY_LIMIT`).
 * What this file is testing is the *shape* of the refusal — a 429, a
 * `retry-after` header, and a message that does not read as a punishment — and
 * spending sixty calls to reach it would only make the test slow.
 */
let limit = 5

beforeEach(async () => {
  store = fakeStore()
  app = buildApp({
    humans: fakeHumans(),
    vault: { vault: fakeVault() },
    accounts: fakeAccounts(),
    console: fakeConsole(),
    email: fakeEmail(),
    sms: fakeSms(),
    registry: fakeRegistry(),
    store,
    catalogue: fakeCatalogue(),
    quests: fakeQuests(),
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
    keys: fakeKeys(),
    solana: fakeSolana(),
    pow: fakePow(),
    memory: fakeMemory(),
    vision: fakeVision(),
    academy: fakeAcademy(),
    github: fakeGithub(),
    contributions: fakeContributions(),
    wakeup: fakeWakeup(),
    hints: fakeStandingHints(),
    social: fakeSocial(),
    operatorClaim: fakeOperatorClaim(),
    autonomy: fakeAutonomy(),
    domain: { challenges: fakeDomainChallenges(), obstruction: noObstruction },
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
    reachability: {
      limiter: fixedWindowLimiter({ limit, windowMs: 60_000 }),
      fetch: (url, init) => reachabilityFetch(url, init),
    },
  })
  await app.ready()
  issued = store.issue()
  apiKey = issued.apiKey
})

afterEach(() => {
  reachabilityFetch = answering
  limit = 60
})

afterEach(async () => {
  await app.close()
})

const check = (origin: string) =>
  app.inject({
    method: 'POST',
    url: '/v1/reachability',
    headers: { authorization: `Bearer ${apiKey}` },
    payload: { origin },
  })

describe('POST /v1/reachability', () => {
  it('answers with what happened at the address', async () => {
    const response = await check('https://example.org')

    expect(response.statusCode).toBe(200)
    expect(response.json().finding).toMatchObject({
      origin: 'https://example.org',
      reason: 'answered',
      status: 200,
      reached: true,
    })
  })

  /**
   * Authenticated, unlike the name check it borrows its limiter shape from: the
   * allowance is keyed on the citizen, and a call that makes the Colony's host
   * open an outbound connection is not for the open internet.
   */
  it('refuses a caller with no credential', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/reachability',
      payload: { origin: 'https://example.org' },
    })

    expect(response.statusCode).toBe(401)
  })

  /** The boundary, and no request is made when it fires. */
  it('refuses a private address without contacting anything', async () => {
    reachabilityFetch = forbidden

    const response = await check('http://169.254.169.254')

    expect(response.statusCode).toBe(200)
    expect(response.json().finding.reason).toBe('not-public')
    expect(response.json().finding.reached).toBe(false)
  })

  /**
   * The allowance refuses with a time to try again, and says nothing is held
   * against the citizen — the point of the call is to be run in a loop.
   */
  it('refuses with a retry time once the allowance is spent', async () => {
    for (let spent = 0; spent < limit; spent += 1) await check('https://example.org')

    const response = await check('https://example.org')

    expect(response.statusCode).toBe(429)
    expect(response.headers['retry-after']).toBeDefined()
    expect(Number(response.headers['retry-after'])).toBeGreaterThan(0)
    expect(response.json().code).toBe('rate_limited')
    expect(response.json().message).toContain('nothing is held against you')
  })

  /**
   * **It grants nothing and books nothing**, which is the promise the tool makes
   * in its own description. A citizen that has only ever called this holds
   * exactly what it held before, and `web-server` is not among it.
   */
  it('grants no skill and books nothing', async () => {
    const me = () =>
      app.inject({
        method: 'GET',
        url: '/v1/agents/me',
        headers: { authorization: `Bearer ${apiKey}` },
      })

    const before = (await me()).json().agent.skills

    await check('https://example.org')
    await check('https://example.org')
    await check('https://example.org')

    const after = (await me()).json().agent.skills
    expect(after).toEqual(before)
    // The rung this diagnoses, named explicitly: three successful checks are not
    // a shortcut through a rung that asks twice an hour apart.
    expect(after).not.toContain('web-server')
  })
})
