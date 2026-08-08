import { fakeHumans } from '../__fixtures__/humans.js'
import { fakeArtefactChallenges } from '../__fixtures__/artefact.js'
import { CAPABILITY_STAGE, PERCEPTION_STAGE, perceptionCodeFor } from '@kolonie-ai/core'
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
import { fakeConsole } from '../__fixtures__/console.js'
import { fakeErasureDesk } from '../__fixtures__/erasure.js'
import { erasure } from '../erasure.js'
import type { AcademyDependencies } from '../academy.js'

/**
 * The perception stage's routes (`#162`).
 *
 * Two doors, because two parties knock: the page reports that it drew, and the
 * citizen reports what it read. What is asserted here is the API's half — that the
 * order of those two is enforced, that a wrong reading teaches, and that a reading
 * against another stage's challenge is refused.
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

/** A perception challenge, minted through the route the citizen actually uses. */
const mintPerception = async () => {
  const { apiKey, agent } = store.issue()
  const response = await app.inject({
    method: 'POST',
    url: '/v1/academy/challenges',
    headers: { authorization: `Bearer ${apiKey}` },
    payload: { kind: 'perception' },
  })
  return { challengeId: response.json().challengeId as string, response, agent, apiKey }
}

const anObservation = { rendered: true, cssWidth: 320, cssHeight: 96, devicePixelRatio: 1 }

const reportRendered = (challengeId: string, body: Record<string, unknown> = anObservation) =>
  app.inject({
    method: 'POST',
    url: `/v1/academy/perception/${challengeId}/rendered`,
    payload: body,
  })

const reportReading = (challengeId: string, value: string) =>
  app.inject({
    method: 'POST',
    url: `/v1/academy/perception/${challengeId}/reading`,
    payload: { value },
  })

describe('POST /v1/academy/challenges for the perception stage', () => {
  it('mints it and points at its own page', async () => {
    const { response } = await mintPerception()

    expect(response.statusCode).toBe(201)
    // Its own directory, so no two stages can be confused by their urls.
    expect(response.json().url).toContain('/perception/')
    expect(response.json().url).toContain(`c=${response.json().challengeId}`)
  })
})

describe('the perception stage — the page reporting that it drew', () => {
  it('records the observation and answers with no body', async () => {
    const { challengeId } = await mintPerception()

    const response = await reportRendered(challengeId)

    expect(response.statusCode).toBe(204)
  })

  it('refuses a report that does not carry what only the page knows', async () => {
    const { challengeId } = await mintPerception()

    const response = await reportRendered(challengeId, { rendered: true })

    expect(response.statusCode).toBe(422)
    expect(response.json().message).toContain('devicePixelRatio')
  })

  /**
   * An unauthenticated write bounded rather than free. A device pixel ratio of 400
   * is either a broken report or an attempt to make the scaling diagnosis one stage
   * up say something untrue.
   */
  it('refuses an impossible device pixel ratio', async () => {
    const { challengeId } = await mintPerception()

    const response = await reportRendered(challengeId, { ...anObservation, devicePixelRatio: 400 })

    expect(response.statusCode).toBe(422)
  })

  it('does not recognise a challenge belonging to another stage', async () => {
    const { agent } = store.issue()
    const { id } = await challenges.mint(agent.id, CAPABILITY_STAGE)

    const response = await reportRendered(id)

    expect(response.statusCode).toBe(404)
  })
})

describe('the perception stage — the citizen reporting what it read', () => {
  it('clears the challenge on the code the page drew', async () => {
    const { challengeId, agent } = await mintPerception()
    await reportRendered(challengeId)

    const response = await reportReading(challengeId, perceptionCodeFor(challengeId))

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ status: 'verified' })
    expect(await academy.challenges.clearedAt(agent.id, PERCEPTION_STAGE)).toBeTruthy()
  })

  /**
   * Case is not what this stage measures. A citizen that read the glyphs correctly
   * and sent them in lower case has demonstrated exactly the thing being tested, and
   * failing it for a convention nobody stated would be failing perception for
   * formatting.
   */
  it('accepts the code in either case, and trims it', async () => {
    const { challengeId, agent } = await mintPerception()
    await reportRendered(challengeId)

    const response = await reportReading(
      challengeId,
      `  ${perceptionCodeFor(challengeId).toLowerCase()} `,
    )

    expect(response.statusCode).toBe(200)
    expect(await academy.challenges.clearedAt(agent.id, PERCEPTION_STAGE)).toBeTruthy()
  })

  /**
   * **The order of the checks is the design** (`#160`, `#162`). A citizen answering a
   * page that never painted has not failed at perception, and telling it "wrong
   * answer" would send it looking for a problem it does not have.
   */
  it('says the page has not reported drawing, rather than calling the answer wrong', async () => {
    const { challengeId, agent } = await mintPerception()

    const response = await reportReading(challengeId, perceptionCodeFor(challengeId))

    expect(response.statusCode).toBe(409)
    expect(response.json().message).toMatch(/has not reported drawing/i)
    // And even a correct answer does not clear it, because the evidence is absent.
    expect(await academy.challenges.clearedAt(agent.id, PERCEPTION_STAGE)).toBeNull()
  })

  it('refuses a wrong reading without disclosing the code', async () => {
    const { challengeId, agent } = await mintPerception()
    await reportRendered(challengeId)

    const response = await reportReading(challengeId, 'XXXXX')

    expect(response.statusCode).toBe(422)
    expect(response.json().message).not.toContain(perceptionCodeFor(challengeId))
    expect(await academy.challenges.clearedAt(agent.id, PERCEPTION_STAGE)).toBeNull()
  })

  /**
   * `#162` asks the evidence to teach. One character out is almost never a citizen
   * that cannot see — it is resolution or scaling — and the answer names both the
   * cause and the fix.
   */
  it('tells a near miss what it usually means', async () => {
    const { challengeId } = await mintPerception()
    await reportRendered(challengeId)

    const code = perceptionCodeFor(challengeId)
    const nearly = `${code.slice(0, -1)}${code.at(-1) === 'X' ? 'Y' : 'X'}`

    const response = await reportReading(challengeId, nearly)

    expect(response.statusCode).toBe(422)
    expect(response.json().message).toMatch(/one character away/i)
    expect(response.json().message).toMatch(/through the browser/i)
    expect(response.json().message).not.toContain(code)
  })

  it('does not recognise a challenge belonging to another stage', async () => {
    const { agent } = store.issue()
    const { id } = await challenges.mint(agent.id, CAPABILITY_STAGE)

    const response = await reportReading(id, perceptionCodeFor(id))

    expect(response.statusCode).toBe(404)
    expect(await academy.challenges.clearedAt(agent.id, CAPABILITY_STAGE)).toBeNull()
  })

  it('clears nothing twice', async () => {
    const { challengeId } = await mintPerception()
    await reportRendered(challengeId)
    await reportReading(challengeId, perceptionCodeFor(challengeId))

    const again = await reportReading(challengeId, perceptionCodeFor(challengeId))

    expect(again.statusCode).toBe(409)
  })

  /**
   * Two challenges in a row carry different codes, so one citizen's published answer
   * is worth nothing to the next.
   */
  it('gives two challenges different codes', async () => {
    const first = await mintPerception()
    const second = await mintPerception()

    expect(perceptionCodeFor(first.challengeId)).not.toBe(perceptionCodeFor(second.challengeId))
  })

  /**
   * A stage whose page is unconfigured refuses its own routes and leaves the rest of
   * the ladder standing — `#29`'s lesson, generalised by `#160`.
   */
  it('refuses both doors when the stage is not configured', async () => {
    app = build({ stageUnavailableReasons: { [PERCEPTION_STAGE]: 'PERCEPTION_PAGE_URL not set' } })
    await app.ready()

    const rendered = await reportRendered('0f2c48a1-9b7e-4d3f-8a62-15c9de704b83')
    const reading = await reportReading('0f2c48a1-9b7e-4d3f-8a62-15c9de704b83', 'TVW9Y')

    expect(rendered.statusCode).toBe(500)
    expect(reading.statusCode).toBe(500)
    expect(reading.json().message).toContain('PERCEPTION_PAGE_URL not set')
  })
})
