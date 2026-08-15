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
import { fakeKeys } from '../__fixtures__/keys.js'
import {
  fakeSolanaChallenges,
  fakeWallet,
  type FakeSolanaChallenges,
} from '../__fixtures__/solana.js'
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
import { fakeVision } from '../__fixtures__/vision.js'
import { fakePow } from '../__fixtures__/proof-of-work.js'
import { fakeMemory } from '../__fixtures__/memory.js'
import { fakeVault } from '../__fixtures__/vault.js'
import { fakeAccounts } from '../__fixtures__/accounts.js'
import { fakeConsole } from '../__fixtures__/console.js'
import { fakeErasureDesk } from '../__fixtures__/erasure.js'
import { erasure } from '../erasure.js'
import { noObstruction } from '../__fixtures__/obstruction.js'
import { arrivalReports } from '../arrival-reports.js'
import { fakeArrivalDesk } from '../__fixtures__/arrivals.js'

let app: FastifyInstance
let store: FakeStore
let challenges: FakeSolanaChallenges
let apiKey: string
let agentId: string

beforeEach(async () => {
  store = fakeStore()
  challenges = fakeSolanaChallenges()
  app = buildApp({
    arrivals: arrivalReports({ desk: fakeArrivalDesk() }),
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
    solana: { challenges, obstruction: noObstruction },
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
    url: '/v1/academy/solana/challenges',
    headers: { authorization: `Bearer ${key}` },
  })

const answer = (payload: unknown, key = apiKey) =>
  app.inject({
    method: 'POST',
    url: '/v1/academy/solana/addresses',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    payload: payload as never,
  })

/** Mint, sign correctly, hand back. The happy path in one call. */
const clear = async (signer = fakeWallet()) => {
  const nonce = (await mint()).json().nonce
  return answer({ address: signer.address, signature: signer.sign(nonce) })
}

describe('POST /v1/academy/solana/challenges', () => {
  it('answers 201 with a nonce and an expiry', async () => {
    const response = await mint()

    expect(response.statusCode).toBe(201)
    const body = response.json()
    expect(body.nonce).toMatch(/^[0-9a-f]{64}$/)
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now())
  })

  it('refuses a caller with no credential', async () => {
    const response = await app.inject({ method: 'POST', url: '/v1/academy/solana/challenges' })

    expect(response.statusCode).toBe(401)
    expect(response.headers['www-authenticate']).toBeDefined()
  })

  /**
   * There is no configuration this rung could be missing — no RPC endpoint, no
   * faucet, no API key — so there is no state in which it answers 503. That is
   * the whole reason the rung is a signature rather than a transaction, and it
   * is asserted rather than left to be inferred from the wiring.
   */
  it('serves on an app wired with nothing else configured', async () => {
    expect((await mint()).statusCode).toBe(201)
  })

  it('mints a fresh nonce every time, because each is single-use', async () => {
    const first = (await mint()).json().nonce
    const second = (await mint()).json().nonce

    expect(first).not.toBe(second)
  })
})

describe('POST /v1/academy/solana/addresses', () => {
  it('accepts a signature over the issued nonce', async () => {
    const signer = fakeWallet()

    const response = await clear(signer)

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ verified: true, address: signer.address })
  })

  it('refuses a signature over something the Colony never issued', async () => {
    const signer = fakeWallet()
    await mint()

    const response = await answer({
      address: signer.address,
      signature: signer.sign('a value of my own choosing'),
    })

    expect(response.statusCode).toBe(ERROR_STATUS['validation_failed'])
  })

  /**
   * The claim is control of *this* address. A real signature by a real wallet,
   * offered under an address it does not own, has to fail — otherwise an agent
   * could name any address it liked and the earning rungs above would pay
   * against it.
   */
  it('refuses a valid signature offered under a different address', async () => {
    const signer = fakeWallet()
    const claimed = fakeWallet()
    const nonce = (await mint()).json().nonce

    const response = await answer({ address: claimed.address, signature: signer.sign(nonce) })

    expect(response.statusCode).toBe(ERROR_STATUS['validation_failed'])
  })

  /** Base64 is what the keypair rung takes, and it is the likely first mistake here. */
  it('refuses a base64 signature and says so', async () => {
    const signer = fakeWallet()
    const nonce = (await mint()).json().nonce

    const response = await answer({
      address: signer.address,
      signature: Buffer.from(signer.sign(nonce)).toString('base64'),
    })

    expect(response.statusCode).toBe(ERROR_STATUS['validation_failed'])
    expect(response.json().message).toContain('base58')
  })

  it('refuses an address that is not a Solana address', async () => {
    const signer = fakeWallet()
    const nonce = (await mint()).json().nonce

    const response = await answer({ address: 'not-an-address', signature: signer.sign(nonce) })

    expect(response.statusCode).toBe(ERROR_STATUS['validation_failed'])
  })

  /**
   * **The refusal that matters most in this rung.** A wallet key is the one
   * secret an agent cannot un-disclose, so a body carrying one is rejected
   * rather than quietly ignored — and the schema is `.strict()` so that this
   * holds for any field name the agent invents.
   */
  it('refuses a body carrying a private key rather than ignoring the field', async () => {
    const signer = fakeWallet()
    const nonce = (await mint()).json().nonce

    const response = await answer({
      address: signer.address,
      signature: signer.sign(nonce),
      privateKey: 'whatever an agent might paste here',
    })

    expect(response.statusCode).toBe(ERROR_STATUS['validation_failed'])
  })

  it('refuses an agent that has minted nothing', async () => {
    const signer = fakeWallet()

    const response = await answer({
      address: signer.address,
      signature: signer.sign('anything'),
    })

    expect(response.statusCode).toBe(ERROR_STATUS['not_found'])
  })

  it('refuses an expired challenge and says a fresh one may be minted', async () => {
    const signer = fakeWallet()
    const nonce = (await mint()).json().nonce
    challenges.expire(agentId as never)

    const response = await answer({ address: signer.address, signature: signer.sign(nonce) })

    expect(response.statusCode).toBe(ERROR_STATUS['task_expired'])
  })

  /**
   * The signature is well-formed and simply late: a nonce is single-use, so the
   * refusal has to be a conflict rather than a validation failure. Sending
   * something malformed here would prove nothing, because the schema would
   * reject it before the store ever saw it.
   */
  it('refuses a second answer to the same nonce', async () => {
    const signer = fakeWallet()
    await clear(signer)

    const response = await answer({
      address: signer.address,
      signature: signer.sign('a second attempt'),
    })

    expect(response.statusCode).toBe(ERROR_STATUS['conflict'])
  })

  /**
   * One wallet, one citizen (D-019). The refusal says the wallet is spoken for
   * rather than implying the signature was wrong, because those send an agent to
   * different places.
   */
  it('refuses an address another citizen has already cleared with', async () => {
    const signer = fakeWallet()
    challenges.claimForAnother(signer.address)
    const nonce = (await mint()).json().nonce

    const response = await answer({ address: signer.address, signature: signer.sign(nonce) })

    expect(response.statusCode).toBe(ERROR_STATUS['conflict'])
    expect(response.json().message).toContain('One wallet belongs to one citizen')
  })

  it('refuses a caller with no credential', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/academy/solana/addresses',
      headers: { 'content-type': 'application/json' },
      payload: {} as never,
    })

    expect(response.statusCode).toBe(401)
  })
})
