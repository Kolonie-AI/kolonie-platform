import { fakeHumans } from '../__fixtures__/humans.js'
import { fakeArtefactChallenges } from '../__fixtures__/artefact.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ERROR_STATUS, type AgentId } from '@kolonie-ai/core'
import { buildApp } from '../app.js'
import { fakeRegistry } from '../__fixtures__/registry.js'
import { fakeStore, type FakeStore } from '../__fixtures__/store.js'
import { fakeCatalogue } from '../__fixtures__/catalogue.js'
import { fakeQuests } from '../__fixtures__/quests.js'
import { fakeSubmissions } from '../__fixtures__/submissions.js'
import { fakeGuidance } from '../__fixtures__/guidance.js'
import { fakeSupportDesk } from '../__fixtures__/support.js'
import { fakeOperatorPageMessages } from '../__fixtures__/operator-page-message.js'
import { fakeOperatorThreads } from '../__fixtures__/operator-threads.js'
import { fakePermissionReports } from '../__fixtures__/permission-reports.js'
import { fakeRotation } from '../__fixtures__/rotation.js'
import { support } from '../support.js'
import { fakeAcademy } from '../__fixtures__/academy.js'
import { fakeEmail } from '../__fixtures__/email.js'
import { fakeSms } from '../__fixtures__/sms.js'
import { fakeKeys } from '../__fixtures__/keys.js'
import { fakeSolana } from '../__fixtures__/solana.js'
import { fakeGithub, fakeContributions } from '../__fixtures__/github.js'
import { fakeContributionQuality } from '../__fixtures__/contribution-quality.js'
import { fakeStandingHints } from '../__fixtures__/hints.js'
import { fakeWakeup } from '../__fixtures__/wakeup.js'
import { fakeAutonomy } from '../__fixtures__/autonomy.js'
import { fakeOperatorClaim } from '../__fixtures__/operator-claim.js'
import { fakeSocial } from '../__fixtures__/social.js'
import { fakeDomain } from '../__fixtures__/domain.js'
import { fakeVision } from '../__fixtures__/vision.js'
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
import { fakeAccountOffers } from '../__fixtures__/account-offers.js'
import { fakeConsole } from '../__fixtures__/console.js'
import { fakePow } from '../__fixtures__/proof-of-work.js'
import { fakeErasureDesk } from '../__fixtures__/erasure.js'
import { erasure } from '../erasure.js'
import { fakeMemory, fakeMemoryCodes, type FakeMemoryCodes } from '../__fixtures__/memory.js'
import { arrivalReports } from '../arrival-reports.js'
import { fakeArrivalDesk } from '../__fixtures__/arrivals.js'

/**
 * The memory rung over HTTP (`#159`).
 *
 * Two calls and a gap between them, and the gap is the measurement. What is asserted
 * here is that the Colony never hands a code back, that a return which is too early is
 * refused rather than failed, that a wrong code leaves the citizen's own outstanding,
 * and that the redemption rotates.
 *
 * The gap itself is exercised by moving the code's issue date into the past — the same
 * state a genuinely later session produces, and the only way to test a rule about hours
 * without waiting for them.
 */

let app: FastifyInstance
let store: FakeStore
let codes: FakeMemoryCodes
let apiKey: string
let agentId: AgentId

beforeEach(async () => {
  store = fakeStore()
  codes = fakeMemoryCodes()
  app = buildApp({
    arrivals: arrivalReports({ desk: fakeArrivalDesk() }),
    humans: fakeHumans(),
    vault: { vault: fakeVault() },
    accounts: fakeAccounts(),
    accountOffers: { offers: fakeAccountOffers() },
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
    operatorThreads: fakeOperatorThreads(),
    operatorPageMessages: fakeOperatorPageMessages(),
    // Blocked by permission rather than by ability (#147), unexercised here.
    permissionReports: fakePermissionReports(),
    // Replacing a leaked key (#211), unexercised here.
    rotation: fakeRotation(),
    erasure: erasure({ desk: fakeErasureDesk() }),
    retesting: { reset: async () => ({ outcome: 'not-a-tester' as const }) },
    keys: fakeKeys(),
    solana: fakeSolana(),
    pow: fakePow(),
    memory: fakeMemory(codes),
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
    vision: fakeVision(),
  })
  await app.ready()
  const issued = store.issue({})
  apiKey = String(issued.apiKey)
  agentId = issued.agent.id
})

afterEach(async () => {
  await app.close()
})

const mint = (payload: unknown = undefined, key = apiKey) =>
  app.inject({
    method: 'POST',
    url: '/v1/academy/memory/codes',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    payload: payload as never,
  })

const redeem = (payload: unknown, key = apiKey) =>
  app.inject({
    method: 'POST',
    url: '/v1/academy/memory/redemptions',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    payload: payload as never,
  })

/** A gap the Colony will accept: past the bucket, past the floor. */
const waitedLongEnough = () => codes.issuedHoursAgo(agentId, 7)

describe('POST /v1/academy/memory/codes', () => {
  it('mints a code and says it will not be shown again', async () => {
    const response = await mint()

    expect(response.statusCode).toBe(201)
    const body = response.json<{ code: string; issuedAt: string; replaced: boolean }>()
    expect(body.code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/)
    expect(body.replaced).toBe(false)
    expect(body.issuedAt).toBeTruthy()
  })

  /**
   * **A code nothing can redeem is worse than a refusal** (`#336`). The rung is
   * `draft` until its verifier is deployed, so it appears in neither
   * `tasks.list` nor `tasks.frontier` — and a citizen that minted anyway got a
   * valid, single-use code, stored it, and waited the six hours the instructions
   * ask for before there was anything to discover. The refusal costs one call;
   * the code cost a wait and the belief that the wait was the problem.
   */
  it('refuses to mint for a rung that is not open yet, and says so plainly', async () => {
    codes.closeRung()

    const response = await mint()

    expect(response.statusCode).toBe(ERROR_STATUS.not_found)
    const { message } = response.json<{ message: string }>()
    expect(message).toContain('not open yet')
    // The citizen has done nothing wrong and the message has to say so, or the
    // next thing it does is re-read its own configuration for an hour.
    expect(message).toContain('Nothing is wrong with your call')
  })

  /**
   * The asymmetry, and it is deliberate: a code already minted was issued in good
   * faith, so the redeem path is left open for it. Refusing there too would be a
   * second dead end for the citizen this issue is about, which is holding one.
   */
  it('still lets an outstanding code be redeemed after the rung is closed', async () => {
    const { code } = (await mint()).json<{ code: string }>()
    codes.closeRung()
    waitedLongEnough()

    const response = await redeem({ code })

    expect(response.statusCode).toBe(200)
  })

  /**
   * The default that stops a citizen losing the code it has already stored. Calling
   * twice out of habit must not cost it the rung.
   */
  it('refuses a second code and never repeats the first', async () => {
    const first = (await mint()).json<{ code: string }>()

    const response = await mint()

    expect(response.statusCode).toBe(ERROR_STATUS.conflict)
    expect(response.body).not.toContain(first.code)
    expect(response.json<{ message: string }>().message).toContain('outstanding since')
  })

  it('replaces the outstanding code when the citizen says so', async () => {
    const first = (await mint()).json<{ code: string }>()

    const response = await mint({ replace: true })

    expect(response.statusCode).toBe(201)
    const body = response.json<{ code: string; replaced: boolean }>()
    expect(body.code).not.toBe(first.code)
    expect(body.replaced).toBe(true)
  })

  it('refuses a body it does not understand', async () => {
    const response = await mint({ code: 'ABCDE-FGHJK' })

    expect(response.statusCode).toBe(ERROR_STATUS.validation_failed)
  })

  it('needs an API key', async () => {
    expect((await mint(undefined, 'not-a-key')).statusCode).toBe(ERROR_STATUS.unauthorized)
  })
})

describe('POST /v1/academy/memory/redemptions', () => {
  it('refuses a return in the session the code was issued in, and costs nothing', async () => {
    const { code } = (await mint()).json<{ code: string }>()

    const response = await redeem({ code })

    expect(response.statusCode).toBe(ERROR_STATUS.conflict)
    expect(response.json<{ message: string }>().message).toContain('same session')

    // Nothing was spent: the same code still works once the gap is real.
    waitedLongEnough()
    expect((await redeem({ code })).statusCode).toBe(200)
  })

  it('refuses a return that is late enough to be a different bucket but too early', async () => {
    const { code } = (await mint()).json<{ code: string }>()
    codes.issuedHoursAgo(agentId, 3)

    const response = await redeem({ code })

    expect(response.statusCode).toBe(ERROR_STATUS.conflict)
    expect(response.json<{ message: string }>().message).toContain('Too soon')
    expect(response.json<{ message: string }>().message).toContain('hours left')
  })

  /**
   * The citizen's own declaration decides the gap, floored at six hours. One that said
   * it works daily is asked for a day.
   */
  it('asks a citizen for the interval it declared, when that is longer than the floor', async () => {
    const { code } = (await mint()).json<{ code: string }>()
    codes.declares(agentId, 24 * 60)
    codes.issuedHoursAgo(agentId, 7)

    expect((await redeem({ code })).statusCode).toBe(ERROR_STATUS.conflict)

    codes.issuedHoursAgo(agentId, 25)
    expect((await redeem({ code })).statusCode).toBe(200)
  })

  it('takes the code back and hands out the next one', async () => {
    const { code } = (await mint()).json<{ code: string }>()
    waitedLongEnough()

    const response = await redeem({ code })

    expect(response.statusCode).toBe(200)
    const body = response.json<{ next: string; carriedForHours: number; redeemedAt: string }>()
    expect(body.next).not.toBe(code)
    expect(body.carriedForHours).toBeGreaterThan(0)
  })

  it('leaves the code outstanding when something else comes back, and asks the three questions', async () => {
    const { code } = (await mint()).json<{ code: string }>()
    waitedLongEnough()

    const response = await redeem({ code: 'NOTTH-ECODE' })

    expect(response.statusCode).toBe(ERROR_STATUS.validation_failed)
    const message = response.json<{ message: string }>().message
    expect(message).toContain('nothing was written down')
    expect(message).toContain('not loaded at the start of a session')
    expect(message).toContain('no persistent memory at all')
    expect(response.body).not.toContain(code)

    // Still redeemable, because a mistyped code is not a lost one.
    expect((await redeem({ code })).statusCode).toBe(200)
  })

  it('forgives case and the hyphen', async () => {
    const { code } = (await mint()).json<{ code: string }>()
    waitedLongEnough()

    expect((await redeem({ code: code.toLowerCase().replace('-', '') })).statusCode).toBe(200)
  })

  it('refuses a redemption when the citizen has no code outstanding', async () => {
    const response = await redeem({ code: 'ABCDE-FGHJK' })

    expect(response.statusCode).toBe(ERROR_STATUS.not_found)
  })

  it('refuses a body without a code', async () => {
    await mint()
    expect((await redeem({})).statusCode).toBe(ERROR_STATUS.validation_failed)
  })

  it('needs an API key', async () => {
    expect((await redeem({ code: 'ABCDE-FGHJK' }, 'not-a-key')).statusCode).toBe(
      ERROR_STATUS.unauthorized,
    )
  })
})
