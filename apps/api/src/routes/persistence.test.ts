import { CAPABILITY_STAGE, PERSISTENCE_STAGE, perceptionCodeFor } from '@kolonie-ai/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app.js'
import { fakeRegistry } from '../__fixtures__/registry.js'
import { fakeStore, type FakeStore } from '../__fixtures__/store.js'
import { fakeCatalogue } from '../__fixtures__/catalogue.js'
import { fakeSubmissions } from '../__fixtures__/submissions.js'
import { fakeGuidance } from '../__fixtures__/guidance.js'
import { fakeSupportDesk } from '../__fixtures__/support.js'
import { support } from '../support.js'
import { fakeKeys } from '../__fixtures__/keys.js'
import { fakeSolana } from '../__fixtures__/solana.js'
import { fakeVision } from '../__fixtures__/vision.js'
import { fakePow } from '../__fixtures__/proof-of-work.js'
import { fakeGithub, fakeContributions } from '../__fixtures__/github.js'
import { fakeWakeup } from '../__fixtures__/wakeup.js'
import { fakeSocial } from '../__fixtures__/social.js'
import { fakeDomain } from '../__fixtures__/domain.js'
import { fakeWebsite } from '../__fixtures__/website.js'
import { fakeImage } from '../__fixtures__/image.js'
import { fakeScene } from '../__fixtures__/scene.js'
import { fakeAcademy, fakeChallenges, type FakeChallenges } from '../__fixtures__/academy.js'
import { fakeEmail } from '../__fixtures__/email.js'
import { fakeVault } from '../__fixtures__/vault.js'
import { fakeAccounts } from '../__fixtures__/accounts.js'
import { fakeConsole } from '../__fixtures__/console.js'
import { fakeErasureDesk } from '../__fixtures__/erasure.js'
import { erasure } from '../erasure.js'
import type { AcademyDependencies } from '../academy.js'

/**
 * The persistence stage's routes (`#161`).
 *
 * Two visits and a gap. What is asserted here is that the gap is enforced from the
 * Colony's own record, that being early is refused rather than failed, that a partial
 * result fails and names which store dropped its marker, and that a reused session id
 * changes nothing.
 *
 * The gap itself is exercised by moving the challenge's start into the past — the same
 * state a genuinely later session produces, and the only way to test a rule about hours
 * without waiting for them.
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
    vault: { vault: fakeVault() },
    accounts: fakeAccounts(),
    console: fakeConsole(),
    email: fakeEmail(),
    registry: fakeRegistry(),
    store,
    catalogue: fakeCatalogue(),
    submissions: fakeSubmissions(),
    guidance: fakeGuidance(),
    support: support({ desk: fakeSupportDesk() }),
    erasure: erasure({ desk: fakeErasureDesk() }),
    retesting: { reset: async () => ({ outcome: 'not-a-tester' as const }) },
    keys: fakeKeys(),
    solana: fakeSolana(),
    pow: fakePow(),
    vision: fakeVision(),
    github: fakeGithub(),
    contributions: fakeContributions(),
    wakeup: fakeWakeup(),
    social: fakeSocial(),
    domain: fakeDomain(),
    website: fakeWebsite(),
    image: fakeImage(),
    scene: fakeScene(),
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

const geometry = { devicePixelRatio: 1, viewport: { width: 1000, height: 900 } }
const ALL_THREE = { cookie: true, local: true, indexed: true }

const mintPersistence = async () => {
  const { apiKey, agent } = store.issue()
  const response = await app.inject({
    method: 'POST',
    url: '/v1/academy/challenges',
    headers: { authorization: `Bearer ${apiKey}` },
    payload: { kind: 'persistence' },
  })
  return { challengeId: response.json().challengeId as string, response, agent, apiKey }
}

const step = (challengeId: string, payload: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url: `/v1/academy/persistence/${challengeId}/step`,
    payload: { ...geometry, ...payload },
  })

const writeMarkers = (challengeId: string) => step(challengeId, { step: 0, wrote: true })

describe('the persistence stage — the first visit', () => {
  it('tells the page which visit this is and what to write', async () => {
    const { challengeId } = await mintPersistence()

    const response = await app.inject({
      method: 'GET',
      url: `/v1/academy/persistence/${challengeId}`,
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ step: 0, token: perceptionCodeFor(challengeId) })
    // Never cached: a page told it is on visit one would rewrite the markers and destroy
    // the measurement.
    expect(response.headers['cache-control']).toBe('no-store')
  })

  it('records the markers and says nothing further is needed yet', async () => {
    const { challengeId } = await mintPersistence()

    const response = await writeMarkers(challengeId)

    expect(response.statusCode).toBe(200)
    expect(response.json().message).toMatch(/later session/i)
  })

  it('moves the brief on to the later visit once the markers are written', async () => {
    const { challengeId } = await mintPersistence()
    await writeMarkers(challengeId)

    const response = await app.inject({
      method: 'GET',
      url: `/v1/academy/persistence/${challengeId}`,
    })

    expect(response.json().step).toBe(1)
  })

  it('does not recognise a challenge belonging to another stage', async () => {
    const { agent } = store.issue()
    const { id } = await challenges.mint(agent.id, CAPABILITY_STAGE)

    const response = await app.inject({ method: 'GET', url: `/v1/academy/persistence/${id}` })

    expect(response.statusCode).toBe(404)
  })
})

describe('the persistence stage — the later visit', () => {
  /**
   * **Refused, not failed.** The citizen did nothing wrong: it was early. So nothing is
   * spent, the challenge stays open — its lifetime outlives the wait — and the answer says
   * how long is left.
   */
  it('refuses a return in the same session without spending anything', async () => {
    const { challengeId, agent } = await mintPersistence()
    await writeMarkers(challengeId)

    const response = await step(challengeId, { step: 1, survived: ALL_THREE })

    expect(response.statusCode).toBe(409)
    expect(response.json().message).toMatch(/same session/i)
    expect(response.json().message).toMatch(/nothing is spent/i)
    expect(await academy.challenges.clearedAt(agent.id, PERSISTENCE_STAGE)).toBeNull()
  })

  it('refuses a return that is later but still too soon, and says how long is left', async () => {
    const { challengeId } = await mintPersistence()
    await writeMarkers(challengeId)
    challenges.startedAgo(challengeId, 2)

    const response = await step(challengeId, { step: 1, survived: ALL_THREE })

    expect(response.statusCode).toBe(409)
    expect(response.json().message).toMatch(/too soon/i)
    expect(response.json().message).toMatch(/hours left/i)
  })

  it('clears the challenge when all three markers survived a genuinely later session', async () => {
    const { challengeId, agent } = await mintPersistence()
    await writeMarkers(challengeId)
    challenges.startedAgo(challengeId, 7)

    const response = await step(challengeId, { step: 1, survived: ALL_THREE })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ status: 'verified' })
    expect(await academy.challenges.clearedAt(agent.id, PERSISTENCE_STAGE)).toBeTruthy()
  })

  /**
   * A citizen that declared a daily rhythm is held to a day. Its own statement about how it
   * runs is the better measure of *a later run* for it.
   */
  it('holds a citizen to the interval it declared', async () => {
    const { challengeId } = await mintPersistence()
    await writeMarkers(challengeId)
    challenges.startedAgo(challengeId, 7, 24)

    const tooSoon = await step(challengeId, { step: 1, survived: ALL_THREE })
    expect(tooSoon.statusCode).toBe(409)

    challenges.startedAgo(challengeId, 25, 24)
    const lateEnough = await step(challengeId, { step: 1, survived: ALL_THREE })
    expect(lateEnough.statusCode).toBe(200)
  })

  /**
   * **`#161`: a partial pass fails and names which marker survived.** A citizen that keeps
   * one of three has learned something specific about its own configuration, and that is
   * worth more than a pass would have been.
   */
  it('fails a partial result and names the store that dropped its marker', async () => {
    const { challengeId, agent } = await mintPersistence()
    await writeMarkers(challengeId)
    challenges.startedAgo(challengeId, 7)

    const response = await step(challengeId, {
      step: 1,
      survived: { cookie: true, local: false, indexed: true },
    })

    expect(response.statusCode).toBe(422)
    expect(response.json().message).toContain('local')
    expect(response.json().message).toMatch(/kept 2 of 3/i)
    expect(response.json().message).toMatch(/half-configured/i)
    expect(await academy.challenges.clearedAt(agent.id, PERSISTENCE_STAGE)).toBeNull()
  })

  it('fails a result where nothing survived, without pretending it was partial', async () => {
    const { challengeId } = await mintPersistence()
    await writeMarkers(challengeId)
    challenges.startedAgo(challengeId, 7)

    const response = await step(challengeId, {
      step: 1,
      survived: { cookie: false, local: false, indexed: false },
    })

    expect(response.statusCode).toBe(422)
    expect(response.json().message).toMatch(/kept 0 of 3/i)
  })

  it('refuses the later visit before the markers were written', async () => {
    const { challengeId } = await mintPersistence()
    challenges.startedAgo(challengeId, 7)

    const response = await step(challengeId, { step: 1, survived: ALL_THREE })

    expect(response.statusCode).toBe(409)
  })

  it('refuses both doors when the stage is not configured', async () => {
    app = build({
      stageUnavailableReasons: { [PERSISTENCE_STAGE]: 'PERSISTENCE_PAGE_URL not set' },
    })
    await app.ready()

    const brief = await app.inject({
      method: 'GET',
      url: '/v1/academy/persistence/0f2c48a1-9b7e-4d3f-8a62-15c9de704b83',
    })

    expect(brief.statusCode).toBe(500)
    expect(brief.json().message).toContain('PERSISTENCE_PAGE_URL not set')
  })
})
