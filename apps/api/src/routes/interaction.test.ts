import { fakeHumans } from '../__fixtures__/humans.js'
import { fakeArtefactChallenges } from '../__fixtures__/artefact.js'
import {
  CAPABILITY_STAGE,
  HIT_TOLERANCE_PX,
  INTERACTION_STAGE,
  interactionControlValueFor,
  interactionTargetFor,
} from '@kolonie-ai/core'
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
import { fakeKeys } from '../__fixtures__/keys.js'
import { fakeSolana } from '../__fixtures__/solana.js'
import { fakeVision } from '../__fixtures__/vision.js'
import { fakePow } from '../__fixtures__/proof-of-work.js'
import { fakeMemory } from '../__fixtures__/memory.js'
import { fakeGithub, fakeContributions } from '../__fixtures__/github.js'
import { fakeContributionQuality } from '../__fixtures__/contribution-quality.js'
import { fakeStandingHints } from '../__fixtures__/hints.js'
import { fakeWakeup } from '../__fixtures__/wakeup.js'
import { fakeAutonomy } from '../__fixtures__/autonomy.js'
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
import { fakeAcademy, fakeChallenges, type FakeChallenges } from '../__fixtures__/academy.js'
import { fakeEmail } from '../__fixtures__/email.js'
import { fakeSms } from '../__fixtures__/sms.js'
import { fakeVault } from '../__fixtures__/vault.js'
import { fakeAccounts } from '../__fixtures__/accounts.js'
import { fakeAccountOffers } from '../__fixtures__/account-offers.js'
import { fakeConsole } from '../__fixtures__/console.js'
import { fakeErasureDesk } from '../__fixtures__/erasure.js'
import { erasure } from '../erasure.js'
import type { AcademyDependencies } from '../academy.js'
import { arrivalReports } from '../arrival-reports.js'
import { fakeArrivalDesk } from '../__fixtures__/arrivals.js'

/**
 * The interaction stage's routes (`#163`).
 *
 * What is asserted here is the API's half: that the three measurements are judged and
 * ordered, that a miss carrying the device-pixel-ratio signature is diagnosed rather
 * than merely failed, and that nothing about timing or human-likeness is recorded.
 *
 * The page's half — that its form gate is real, and that a DOM-only fill cannot open
 * it — cannot be asserted without a browser and is exercised against Chromium
 * instead.
 */
let app: FastifyInstance
let store: FakeStore
let challenges: FakeChallenges
let academy: AcademyDependencies

const build = (overrides: Partial<AcademyDependencies> = {}) => {
  store = fakeStore()
  challenges = fakeChallenges()
  academy = { ...fakeAcademy('passed', challenges), ...overrides }
  return buildApp({
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
    academy,
  })
}

beforeEach(async () => {
  app = build()
  await app.ready()
})

afterEach(async () => {
  await app.close()
})

/** An interaction challenge, minted through the route the citizen actually uses. */
const mintInteraction = async () => {
  const { apiKey, agent } = store.issue()
  const response = await app.inject({
    method: 'POST',
    url: '/v1/academy/challenges',
    headers: { authorization: `Bearer ${apiKey}` },
    payload: { kind: 'interaction' },
  })
  return { challengeId: response.json().challengeId as string, response, agent, apiKey }
}

const geometry = { devicePixelRatio: 1, viewport: { width: 900, height: 700 } }

const reportStep = (challengeId: string, payload: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url: `/v1/academy/interaction/${challengeId}/step`,
    payload: { ...geometry, ...payload },
  })

/** All three measurements, done correctly, in order. */
const walkAllThree = async (challengeId: string) => {
  const target = interactionTargetFor(challengeId)
  await reportStep(challengeId, { step: 0, measurement: 'target', asked: target, received: target })
  await reportStep(challengeId, {
    step: 1,
    measurement: 'control',
    asked: interactionControlValueFor(challengeId),
    received: interactionControlValueFor(challengeId),
  })
  return reportStep(challengeId, {
    step: 2,
    measurement: 'form',
    asked: 'both fields',
    received: 'both fields',
  })
}

describe('the interaction stage — what the challenge asks for', () => {
  it('serves the target, the control value and where the citizen has got to', async () => {
    const { challengeId } = await mintInteraction()

    const response = await app.inject({
      method: 'GET',
      url: `/v1/academy/interaction/${challengeId}`,
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      target: interactionTargetFor(challengeId),
      controlValue: interactionControlValueFor(challengeId),
      step: 0,
    })
  })

  /**
   * Never cached. Its url is stable while its answer is not — it carries which
   * measurement is outstanding now, and a cached copy is what made the entry rung
   * unpassable on its third run until `no-store` was added there.
   */
  it('is never cached, because the answer moves while the url does not', async () => {
    const { challengeId } = await mintInteraction()

    const response = await app.inject({
      method: 'GET',
      url: `/v1/academy/interaction/${challengeId}`,
    })

    expect(response.headers['cache-control']).toBe('no-store')
  })

  it('does not recognise a challenge belonging to another stage', async () => {
    const { agent } = store.issue()
    const { id } = await challenges.mint(agent.id, CAPABILITY_STAGE)

    const response = await app.inject({ method: 'GET', url: `/v1/academy/interaction/${id}` })

    expect(response.statusCode).toBe(404)
  })
})

describe('the interaction stage — the three measurements', () => {
  it('clears the challenge when all three are recorded', async () => {
    const { challengeId, agent } = await mintInteraction()

    const last = await walkAllThree(challengeId)

    expect(last.statusCode).toBe(200)
    expect(last.json()).toMatchObject({ status: 'verified' })
    expect(await academy.challenges.clearedAt(agent.id, INTERACTION_STAGE)).toBeTruthy()
  })

  /**
   * A citizen that completes some and not others is told which — that is what three
   * steps are for, rather than one verdict covering all of them.
   */
  it('says which measurement is next while any remain', async () => {
    const { challengeId, agent } = await mintInteraction()
    const target = interactionTargetFor(challengeId)

    const first = await reportStep(challengeId, {
      step: 0,
      measurement: 'target',
      asked: target,
      received: target,
    })

    expect(first.statusCode).toBe(200)
    expect(first.json().message).toContain('control')
    expect(await academy.challenges.clearedAt(agent.id, INTERACTION_STAGE)).toBeNull()
  })

  it('refuses a measurement reported out of order', async () => {
    const { challengeId } = await mintInteraction()

    const response = await reportStep(challengeId, {
      step: 1,
      measurement: 'control',
      asked: interactionControlValueFor(challengeId),
      received: interactionControlValueFor(challengeId),
    })

    expect(response.statusCode).toBe(409)
  })

  it('refuses a step reporting a measurement that is not the one it is for', async () => {
    const { challengeId } = await mintInteraction()

    const response = await reportStep(challengeId, {
      step: 0,
      measurement: 'control',
      asked: 40,
      received: 40,
    })

    expect(response.statusCode).toBe(422)
    expect(response.json().message).toContain('target')
  })

  it('refuses a click outside the tolerance', async () => {
    const { challengeId, agent } = await mintInteraction()
    const target = interactionTargetFor(challengeId)

    const response = await reportStep(challengeId, {
      step: 0,
      measurement: 'target',
      asked: target,
      received: { x: target.x + HIT_TOLERANCE_PX * 4, y: target.y + HIT_TOLERANCE_PX * 4 },
    })

    expect(response.statusCode).toBe(422)
    expect(await academy.challenges.clearedAt(agent.id, INTERACTION_STAGE)).toBeNull()
  })

  it('accepts a click inside the tolerance', async () => {
    const { challengeId } = await mintInteraction()
    const target = interactionTargetFor(challengeId)

    const response = await reportStep(challengeId, {
      step: 0,
      measurement: 'target',
      asked: target,
      received: { x: target.x + 4, y: target.y - 3 },
    })

    expect(response.statusCode).toBe(200)
  })

  /**
   * **The behaviour this stage exists for, and `#163` requires it not to regress
   * silently.** A miss matching the device pixel ratio is diagnosed in as many words,
   * with the direction named and both fixes given.
   */
  it('diagnoses a device-pixel-ratio miss instead of merely failing it', async () => {
    const { challengeId } = await mintInteraction()
    const target = interactionTargetFor(challengeId)

    const response = await app.inject({
      method: 'POST',
      url: `/v1/academy/interaction/${challengeId}/step`,
      payload: {
        step: 0,
        measurement: 'target',
        asked: target,
        // What an agent that read the target out of an operating-system screenshot at
        // 150 % scaling would send.
        received: { x: target.x * 1.5, y: target.y * 1.5 },
        devicePixelRatio: 1.5,
        viewport: geometry.viewport,
      },
    })

    expect(response.statusCode).toBe(422)
    const { message } = response.json()
    expect(message).toMatch(/device pixel ratio/i)
    expect(message).toMatch(/multiplied by 1\.5/)
    // Both fixes, because either removes the class rather than the instance.
    expect(message).toMatch(/through the browser/i)
    expect(message).toMatch(/click elements rather than coordinates/i)
  })

  /**
   * A miss with no scaling pattern gets a plain answer. Inventing a cause is worse
   * than reporting none: the citizen would go and fix something that was not wrong.
   */
  it('does not claim a scaling cause for a miss that has none', async () => {
    const { challengeId } = await mintInteraction()
    const target = interactionTargetFor(challengeId)

    const response = await reportStep(challengeId, {
      step: 0,
      measurement: 'target',
      asked: target,
      received: { x: 5, y: 310 },
    })

    expect(response.statusCode).toBe(422)
    expect(response.json().message).toMatch(/carries no scaling pattern/i)
  })

  it('refuses a control left where it started', async () => {
    const { challengeId } = await mintInteraction()
    const target = interactionTargetFor(challengeId)
    await reportStep(challengeId, {
      step: 0,
      measurement: 'target',
      asked: target,
      received: target,
    })

    const response = await reportStep(challengeId, {
      step: 1,
      measurement: 'control',
      asked: interactionControlValueFor(challengeId),
      received: 0,
    })

    expect(response.statusCode).toBe(422)
    expect(response.json().message).toMatch(/not at the mark/i)
  })

  /**
   * **`#163` forbids measuring timing, mouse path, jitter or human-likeness, and this
   * is the test that keeps it forbidden.** It is exactly the sort of thing a later
   * reader adds as an obvious improvement, so the prohibition is pinned to the
   * recorded shape rather than left in prose.
   */
  it('records nothing about timing, jitter or human-likeness', async () => {
    const { challengeId } = await mintInteraction()
    await walkAllThree(challengeId)

    const recorded = JSON.stringify(await challenges.observationOf(challengeId))

    for (const forbidden of ['timing', 'duration', 'jitter', 'path', 'speed', 'human', 'dwell']) {
      expect(recorded.toLowerCase()).not.toContain(forbidden)
    }
  })

  it('refuses both doors when the stage is not configured', async () => {
    app = build({
      stageUnavailableReasons: { [INTERACTION_STAGE]: 'INTERACTION_PAGE_URL not set' },
    })
    await app.ready()

    const brief = await app.inject({
      method: 'GET',
      url: '/v1/academy/interaction/0f2c48a1-9b7e-4d3f-8a62-15c9de704b83',
    })

    expect(brief.statusCode).toBe(500)
    expect(brief.json().message).toContain('INTERACTION_PAGE_URL not set')
  })
})
