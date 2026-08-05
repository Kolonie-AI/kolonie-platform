import { fakeHumans } from '../__fixtures__/humans.js'
import { fakeArtefactChallenges } from '../__fixtures__/artefact.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fakeDepositDependencies, fakeDeposits } from '../__fixtures__/deposits.js'
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
import { fakeOperatorNotes } from '../__fixtures__/operator-notes.js'
import { fakeOperatorRequests } from '../__fixtures__/operator-requests.js'
import { fakePermissionReports } from '../__fixtures__/permission-reports.js'
import { fakeRotation } from '../__fixtures__/rotation.js'
import { support } from '../support.js'
import { fakeAcademy } from '../__fixtures__/academy.js'
import { fakeEmail } from '../__fixtures__/email.js'
import { fakeKeys } from '../__fixtures__/keys.js'
import { fakeSolana } from '../__fixtures__/solana.js'
import { fakeGithub, fakeContributions } from '../__fixtures__/github.js'
import { fakeStandingHints } from '../__fixtures__/hints.js'
import { fakeWakeup } from '../__fixtures__/wakeup.js'
import { fakeAutonomy } from '../__fixtures__/autonomy.js'
import { fakeOperatorClaim } from '../__fixtures__/operator-claim.js'
import { fakeSocial } from '../__fixtures__/social.js'
import { fakeDomain } from '../__fixtures__/domain.js'
import { fakeVision } from '../__fixtures__/vision.js'
import { fakeWebServer } from '../__fixtures__/web-server.js'
import { fakeWebsite } from '../__fixtures__/website.js'
import { fakeImage } from '../__fixtures__/image.js'
import { fakeScene } from '../__fixtures__/scene.js'
import { fakeInjection } from '../__fixtures__/injection.js'
import { fakeVetting } from '../__fixtures__/vetting.js'
import { fakeAuthenticator } from '../__fixtures__/authenticator.js'
import { fakeVault } from '../__fixtures__/vault.js'
import { fakeAccounts } from '../__fixtures__/accounts.js'
import { fakeConsole } from '../__fixtures__/console.js'
import {
  FAKE_POW_DIFFICULTY,
  fakePowChallenges,
  missingNonce,
  solveChallenge,
  type FakePowChallenges,
} from '../__fixtures__/proof-of-work.js'
import { fakeErasureDesk } from '../__fixtures__/erasure.js'
import { erasure } from '../erasure.js'
import { fakeMemory } from '../__fixtures__/memory.js'
import { noObstruction } from '../__fixtures__/obstruction.js'

let app: FastifyInstance
let store: FakeStore
let challenges: FakePowChallenges
let apiKey: string
let agentId: AgentId

beforeEach(async () => {
  store = fakeStore()
  challenges = fakePowChallenges()
  app = buildApp({
    humans: fakeHumans(),
    vault: { vault: fakeVault() },
    accounts: fakeAccounts(),
    console: fakeConsole(),
    email: fakeEmail(),
    registry: fakeRegistry(),
    store,
    catalogue: fakeCatalogue(),
    quests: fakeQuests(),
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
    keys: fakeKeys(),
    solana: fakeSolana(),
    pow: { challenges, difficulty: FAKE_POW_DIFFICULTY, obstruction: noObstruction },
    memory: fakeMemory(),
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

const mint = (key = apiKey) =>
  app.inject({
    method: 'POST',
    url: '/v1/academy/pow/challenges',
    headers: { authorization: `Bearer ${key}` },
  })

const solve = (payload: unknown, key = apiKey) =>
  app.inject({
    method: 'POST',
    url: '/v1/academy/pow/solutions',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    payload: payload as never,
  })

describe('POST /v1/academy/pow/challenges', () => {
  it('hands back everything needed to start searching', async () => {
    const response = await mint()

    expect(response.statusCode).toBe(201)
    // What to hash, how it is composed, how hard, and by when. An agent that has
    // to read prose to attempt a task is one the Colony made harder than it is.
    expect(response.json()).toMatchObject({
      input: expect.any(String),
      difficulty: FAKE_POW_DIFFICULTY,
      algorithm: 'sha256',
      expiresAt: expect.any(String),
    })
  })

  it('mints at the difficulty the task declares, not one the caller picked', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/academy/pow/challenges',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      payload: { difficulty: 1 } as never,
    })

    // There is no parameter for it and a body carrying one changes nothing. A
    // caller that could choose its own target would be setting its own price.
    expect(response.json().difficulty).toBe(FAKE_POW_DIFFICULTY)
  })

  it('refuses a caller with no credential', async () => {
    const response = await app.inject({ method: 'POST', url: '/v1/academy/pow/challenges' })

    expect(response.statusCode).toBe(ERROR_STATUS['unauthorized'])
    expect(response.headers['www-authenticate']).toBeDefined()
  })
})

describe('POST /v1/academy/pow/solutions', () => {
  it('accepts a nonce that meets the target', async () => {
    const { input } = (await mint()).json()

    const response = await solve({ nonce: solveChallenge(input) })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ solved: true, input, difficulty: FAKE_POW_DIFFICULTY })
  })

  /**
   * The refusal this rung treats unlike any other: a miss leaves the challenge
   * open. The agent has claimed nothing untrue, it has not finished searching —
   * so checking a candidate early has to cost nothing.
   */
  it('refuses a nonce below the target and says the search continues', async () => {
    const { input } = (await mint()).json()

    const response = await solve({ nonce: missingNonce(input) })

    expect(response.statusCode).toBe(ERROR_STATUS['validation_failed'])
    expect(response.json().message).toMatch(/still open/i)
    // The bit an agent gets wrong first, named in the refusal it will actually
    // read: zero bits of the digest, not zero characters of its hex.
    expect(response.json().message).toMatch(/bits/i)

    // And it really is still open.
    expect((await solve({ nonce: solveChallenge(input) })).statusCode).toBe(200)
  })

  it('refuses an expired challenge, however good the nonce', async () => {
    const { input } = (await mint()).json()
    const nonce = solveChallenge(input)
    challenges.expire(agentId)

    const response = await solve({ nonce })

    expect(response.statusCode).toBe(ERROR_STATUS['task_expired'])
  })

  it('refuses a second answer once the challenge is solved', async () => {
    const { input } = (await mint()).json()
    await solve({ nonce: solveChallenge(input) })

    const response = await solve({ nonce: solveChallenge(input) })

    expect(response.statusCode).toBe(ERROR_STATUS['conflict'])
  })

  it('says there is nothing to answer when nothing was minted', async () => {
    const response = await solve({ nonce: '0' })

    expect(response.statusCode).toBe(ERROR_STATUS['not_found'])
  })

  /**
   * `.strict()`, like the keypair rung's answer. A digest the agent computed
   * itself is a value the Colony must not read — it recomputes — and quietly
   * ignoring the field would leave an agent believing it was checked.
   */
  it('refuses a body carrying anything but the nonce', async () => {
    const { input } = (await mint()).json()

    const response = await solve({ nonce: solveChallenge(input), digest: '0'.repeat(64) })

    expect(response.statusCode).toBe(ERROR_STATUS['validation_failed'])
  })

  it('refuses a caller with no credential', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/academy/pow/solutions',
      payload: { nonce: '0' },
    })

    expect(response.statusCode).toBe(ERROR_STATUS['unauthorized'])
  })

  /**
   * One agent cannot answer another's challenge, and the shape of the endpoint
   * is what makes it true: there is no challenge id to send. The agent comes
   * from the credential and the input from that agent's own row.
   */
  it('leaves another agent’s challenge untouched, whatever is handed in here', async () => {
    const stranger = store.issue({})
    const theirs = (await mint(String(stranger.apiKey))).json()
    const stolen = solveChallenge(theirs.input)

    await mint()
    await solve({ nonce: stolen })

    // The stranger's challenge is still open and still solvable by the stranger.
    // Whatever the caller's own row did with that nonce, nothing crossed: the
    // agent comes from the credential and the input from that agent's own row,
    // so there is no id through which one agent could spend another's work.
    const theirAnswer = await solve({ nonce: stolen }, String(stranger.apiKey))
    expect(theirAnswer.statusCode).toBe(200)
    expect(theirAnswer.json().input).toBe(theirs.input)
  })
})
