import { fakeHumans } from '../__fixtures__/humans.js'
import { fakeArtefactChallenges } from '../__fixtures__/artefact.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ERROR_STATUS } from '@kolonie-ai/core'
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
import { fakeKeypair, fakeKeyChallenges, type FakeKeyChallenges } from '../__fixtures__/keys.js'
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

let app: FastifyInstance
let store: FakeStore
let challenges: FakeKeyChallenges
let apiKey: string
let agentId: string

beforeEach(async () => {
  store = fakeStore()
  challenges = fakeKeyChallenges()
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
    keys: { challenges, obstruction: noObstruction },
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
})

afterEach(async () => {
  await app.close()
})

const mint = (key = apiKey) =>
  app.inject({
    method: 'POST',
    url: '/v1/academy/key/challenges',
    headers: { authorization: `Bearer ${key}` },
  })

const sign = (payload: unknown, key = apiKey) =>
  app.inject({
    method: 'POST',
    url: '/v1/academy/key/signatures',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    payload: payload as never,
  })

/** Mint, sign correctly, hand back. The happy path in one call. */
const clear = async (keypair = fakeKeypair()) => {
  const nonce = (await mint()).json().nonce
  return sign({
    algorithm: keypair.algorithm,
    publicKey: keypair.publicKey,
    signature: keypair.sign(nonce),
  })
}

describe('POST /v1/academy/key/challenges', () => {
  it('answers 201 with a nonce, an expiry and the accepted algorithms', async () => {
    const response = await mint()

    expect(response.statusCode).toBe(201)
    const body = response.json()
    expect(body.nonce).toMatch(/^[0-9a-f]{64}$/)
    expect(body.algorithms).toEqual(['ed25519', 'secp256k1'])
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now())
  })

  it('refuses a caller with no credential', async () => {
    const response = await app.inject({ method: 'POST', url: '/v1/academy/key/challenges' })

    expect(response.statusCode).toBe(401)
    expect(response.headers['www-authenticate']).toBeDefined()
  })

  /**
   * There is no configuration this rung could be missing, so there is no state
   * in which it answers 503 — unlike every other Academy route. This asserts the
   * absence rather than leaving it to be inferred from the wiring.
   */
  it('serves on an app wired with nothing else configured', async () => {
    expect((await mint()).statusCode).toBe(201)
  })
})

describe('POST /v1/academy/key/signatures', () => {
  it.each(['ed25519', 'secp256k1'] as const)('accepts a %s signature', async (algorithm) => {
    const response = await clear(fakeKeypair(algorithm))

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ verified: true })
  })

  it('refuses a signature over something the Colony never issued', async () => {
    const keypair = fakeKeypair()
    await mint()

    const response = await sign({
      algorithm: keypair.algorithm,
      publicKey: keypair.publicKey,
      signature: keypair.sign('a value of my own choosing'),
    })

    expect(response.statusCode).toBe(ERROR_STATUS['validation_failed'])
    expect(response.json().details.signature).toBeDefined()
  })

  it('refuses an expired challenge with task_expired, not a validation failure', async () => {
    const keypair = fakeKeypair()
    const nonce = (await mint()).json().nonce
    challenges.expire(agentId as never)

    const response = await sign({
      algorithm: keypair.algorithm,
      publicKey: keypair.publicKey,
      signature: keypair.sign(nonce),
    })

    expect(response.json().code).toBe('task_expired')
  })

  it('refuses a key another citizen has already cleared with', async () => {
    const shared = fakeKeypair()
    challenges.claimForAnother(shared.publicKey)
    const nonce = (await mint()).json().nonce

    const response = await sign({
      algorithm: shared.algorithm,
      publicKey: shared.publicKey,
      signature: shared.sign(nonce),
    })

    expect(response.json().code).toBe('conflict')
    expect(response.json().message).toContain('One keypair belongs to one citizen')
  })

  /**
   * **The refusal that matters most.** The schema is `.strict()`, so a body
   * carrying private key material is rejected rather than accepted and silently
   * ignored. An agent that misreads the instructions once cannot un-disclose a
   * key, so it has to be told it did something wrong.
   */
  it('refuses a body carrying a private key rather than ignoring the field', async () => {
    const keypair = fakeKeypair()
    const nonce = (await mint()).json().nonce

    const response = await sign({
      algorithm: keypair.algorithm,
      publicKey: keypair.publicKey,
      signature: keypair.sign(nonce),
      privateKey: 'this must never be accepted',
    })

    expect(response.statusCode).toBe(ERROR_STATUS['validation_failed'])
    expect(response.json().message).toContain('Never send a private key')
  })

  it('tells an agent which half is wrong when the key is not the named algorithm', async () => {
    const ed = fakeKeypair('ed25519')
    const nonce = (await mint()).json().nonce

    const response = await sign({
      algorithm: 'secp256k1',
      publicKey: ed.publicKey,
      signature: ed.sign(nonce),
    })

    expect(response.json().details.algorithm).toContain('ed25519')
  })

  it('refuses something that is not a PEM public key', async () => {
    await mint()

    const response = await sign({
      algorithm: 'ed25519',
      publicKey: 'AAAAC3NzaC1lZDI1NTE5AAAAIExample',
      signature: 'AAAA',
    })

    expect(response.statusCode).toBe(ERROR_STATUS['validation_failed'])
  })

  it('refuses an agent that has minted nothing', async () => {
    const keypair = fakeKeypair()

    const response = await sign({
      algorithm: keypair.algorithm,
      publicKey: keypair.publicKey,
      signature: keypair.sign('anything'),
    })

    expect(response.json().code).toBe('not_found')
  })

  it('refuses a caller with no credential', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/academy/key/signatures',
      payload: {},
    })

    expect(response.statusCode).toBe(401)
  })
})

/**
 * Found by driving this rung against production, not by a test: `fetch` sets
 * `Content-Type: application/json` by default, and a POST that takes no
 * arguments naturally carries no body. Fastify's default parser refused the
 * pair with a 422 whose message named nothing the caller could fix.
 *
 * It was never specific to this rung — `POST /v1/academy/challenges` did the
 * same thing, and its arguments are all optional — but this is the endpoint
 * that takes no body at all, so it is where the refusal was least excusable.
 */
describe('a POST body that is absent rather than wrong', () => {
  it('reads an empty body with a JSON content-type as {}', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/academy/key/challenges',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      payload: '',
    })

    expect(response.statusCode).toBe(201)
  })

  it('still refuses a body that is present and malformed', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/academy/key/signatures',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      payload: '{not json',
    })

    expect(response.statusCode).toBe(ERROR_STATUS['validation_failed'])
  })
})
