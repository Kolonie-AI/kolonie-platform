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
import { fakeWebServer } from '../__fixtures__/web-server.js'
import { fakeWake } from '../__fixtures__/wake.js'
import { fakeWishList } from '../__fixtures__/account-wishes.js'
import { fakeWebsite } from '../__fixtures__/website.js'
import { fakeImage } from '../__fixtures__/image.js'
import { fakeScene } from '../__fixtures__/scene.js'
import { fakeInjection } from '../__fixtures__/injection.js'
import { fakeVetting } from '../__fixtures__/vetting.js'
import { fakeAuthenticator } from '../__fixtures__/authenticator.js'
import { fakePow } from '../__fixtures__/proof-of-work.js'
import { fakeMemory } from '../__fixtures__/memory.js'
import { fakeVault } from '../__fixtures__/vault.js'
import { fakeAccounts } from '../__fixtures__/accounts.js'
import { fakeAccountOffers } from '../__fixtures__/account-offers.js'
import { fakeConsole } from '../__fixtures__/console.js'
import { fakeErasureDesk } from '../__fixtures__/erasure.js'
import { erasure } from '../erasure.js'
import { noObstruction } from '../__fixtures__/obstruction.js'
import { arrivalReports } from '../arrival-reports.js'
import { fakeArrivalDesk } from '../__fixtures__/arrivals.js'
import {
  fakeVision,
  fakeVisionChallenges,
  type FakeVisionChallenges,
} from '../__fixtures__/vision.js'

let app: FastifyInstance
let store: FakeStore
let challenges: FakeVisionChallenges
let apiKey: string
let agentId: AgentId

beforeEach(async () => {
  store = fakeStore()
  challenges = fakeVisionChallenges()
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
    operatorThreads: fakeOperatorThreads(),
    operatorPageMessages: fakeOperatorPageMessages(),
    permissionReports: fakePermissionReports(),
    rotation: fakeRotation(),
    erasure: erasure({ desk: fakeErasureDesk() }),
    retesting: { reset: async () => ({ outcome: 'not-a-tester' as const }) },
    keys: fakeKeys(),
    solana: fakeSolana(),
    pow: fakePow(),
    memory: fakeMemory(),
    vision: { ...fakeVision(challenges), obstruction: noObstruction },
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
  await app.ready()
  const issued = store.issue({})
  apiKey = String(issued.apiKey)
  agentId = issued.agent.id
})

afterEach(async () => {
  await app.close()
})

const mint = (key = apiKey) =>
  app.inject({
    method: 'POST',
    url: '/v1/academy/vision/challenges',
    headers: { authorization: `Bearer ${key}` },
  })

const solve = (payload: unknown, key = apiKey) =>
  app.inject({
    method: 'POST',
    url: '/v1/academy/vision/solutions',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    payload: payload as never,
  })

describe('POST /v1/academy/vision/challenges', () => {
  it('answers 201 with the image, the question, an id and an expiry', async () => {
    const response = await mint()

    expect(response.statusCode).toBe(201)
    expect(response.json()).toEqual({
      challengeId: expect.any(String),
      imageBase64: expect.any(String),
      question: expect.any(String),
      expiresAt: expect.any(String),
    })
    expect(response.json().question.length).toBeGreaterThan(0)
    expect(response.json().imageBase64.length).toBeGreaterThan(0)
  })

  it('refuses a caller with no credential', async () => {
    const response = await app.inject({ method: 'POST', url: '/v1/academy/vision/challenges' })

    expect(response.statusCode).toBe(ERROR_STATUS['unauthorized'])
    expect(response.headers['www-authenticate']).toBeDefined()
  })
})

describe('POST /v1/academy/vision/solutions', () => {
  it('accepts the answer the image was minted against', async () => {
    const minted = await mint()
    const answer = challenges.expectedAnswerFor(agentId)

    const response = await solve({ answer })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      solved: true,
      question: minted.json().question,
      expectedAnswer: answer,
    })
  })

  it('refuses a wrong answer and leaves the challenge open', async () => {
    await mint()

    const response = await solve({ answer: 'not-the-answer' })

    expect(response.statusCode).toBe(ERROR_STATUS['validation_failed'])
    expect((await solve({ answer: challenges.expectedAnswerFor(agentId) })).statusCode).toBe(200)
  })

  it('refuses an expired challenge, however good the answer', async () => {
    await mint()
    const answer = challenges.expectedAnswerFor(agentId)
    challenges.expire(agentId)

    const response = await solve({ answer })

    expect(response.statusCode).toBe(ERROR_STATUS['task_expired'])
  })

  it('refuses a second answer once the challenge is solved', async () => {
    await mint()
    const answer = challenges.expectedAnswerFor(agentId)
    await solve({ answer })

    const response = await solve({ answer })

    expect(response.statusCode).toBe(ERROR_STATUS['conflict'])
  })

  it('says there is nothing to answer when nothing was minted', async () => {
    const response = await solve({ answer: 'anything' })

    expect(response.statusCode).toBe(ERROR_STATUS['not_found'])
  })

  it('refuses a body carrying anything but the answer', async () => {
    await mint()

    const response = await solve({
      answer: challenges.expectedAnswerFor(agentId),
      imageBase64: 'not-the-field',
    })

    expect(response.statusCode).toBe(ERROR_STATUS['validation_failed'])
  })

  it('refuses a caller with no credential', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/academy/vision/solutions',
      payload: { answer: 'anything' },
    })

    expect(response.statusCode).toBe(ERROR_STATUS['unauthorized'])
  })
})
