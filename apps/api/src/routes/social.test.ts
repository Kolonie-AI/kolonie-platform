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
import { fakeAcademy } from '../__fixtures__/academy.js'
import { fakeEmail } from '../__fixtures__/email.js'
import { fakeKeys } from '../__fixtures__/keys.js'
import { fakeSolana } from '../__fixtures__/solana.js'
import { fakeVision } from '../__fixtures__/vision.js'
import { fakePow } from '../__fixtures__/proof-of-work.js'
import { fakeGithub, fakeContributions } from '../__fixtures__/github.js'
import { fakeWakeup } from '../__fixtures__/wakeup.js'
import { fakeSocialChallenges, type FakeSocialChallenges } from '../__fixtures__/social.js'
import { fakeDomain } from '../__fixtures__/domain.js'
import { fakeWebsite } from '../__fixtures__/website.js'
import { fakeImage } from '../__fixtures__/image.js'
import { fakeScene } from '../__fixtures__/scene.js'
import { fakeInjection } from '../__fixtures__/injection.js'
import { fakeVault } from '../__fixtures__/vault.js'
import { fakeAccounts } from '../__fixtures__/accounts.js'
import { fakeConsole } from '../__fixtures__/console.js'
import { fakeErasureDesk } from '../__fixtures__/erasure.js'
import { erasure } from '../erasure.js'
import { noObstruction } from '../__fixtures__/obstruction.js'

let app: FastifyInstance
let store: FakeStore
let challenges: FakeSocialChallenges
let apiKey: string
let issued: ReturnType<FakeStore['issue']>

beforeEach(async () => {
  store = fakeStore()
  challenges = fakeSocialChallenges()
  app = buildApp({
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
    academy: fakeAcademy(),
    github: fakeGithub(),
    contributions: fakeContributions(),
    wakeup: fakeWakeup(),
    social: { challenges, obstruction: noObstruction },
    domain: fakeDomain(),
    website: fakeWebsite(),
    image: fakeImage(),
    scene: fakeScene(),
    injection: fakeInjection(),
  })
  await app.ready()
  issued = store.issue()
  apiKey = issued.apiKey
})

afterEach(async () => {
  await app.close()
})

const mint = () =>
  app.inject({
    method: 'POST',
    url: '/v1/academy/social/challenges',
    headers: { authorization: `Bearer ${apiKey}` },
  })

describe('POST /v1/academy/social/challenges', () => {
  it('answers 201 with a nonce and an expiry', async () => {
    const response = await mint()

    expect(response.statusCode).toBe(201)
    const body = response.json()
    expect(body.nonce).toMatch(/^[0-9a-f]{64}$/)
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now())
  })

  it('refuses a caller with no credential', async () => {
    const response = await app.inject({ method: 'POST', url: '/v1/academy/social/challenges' })

    // Authenticating is what binds the nonce to one agent. Without it the value
    // would prove that *somebody* controls an account, which is not a fact about
    // any citizen.
    expect(response.statusCode).toBe(401)
    expect(response.headers['www-authenticate']).toBeDefined()
  })

  it('mints a fresh nonce every time, and keeps the older ones', async () => {
    const first = (await mint()).json().nonce
    const second = (await mint()).json().nonce

    expect(first).not.toBe(second)
    expect(challenges.minted(issued.agent.id)).toEqual([first, second])
  })

  /**
   * There is no configuration this rung could be missing, on either side. The
   * API mints random bytes, and unlike every other rung the *verifier* holds no
   * credential either: both networks the Colony reads serve public records
   * unauthenticated, which is the property the platforms were chosen for
   * (`kolonie-docs#49`).
   */
  it('serves on an app wired with nothing else configured', async () => {
    expect((await mint()).statusCode).toBe(201)
  })

  it('has no answering route — the post arrives as a submission', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/academy/social/posts',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { url: 'https://bsky.app/profile/colette.example/post/3kabcxyz' },
    })

    // Asserted rather than left to be inferred. An endpoint taking the agent's
    // word for which account it published from would be a claim the Colony
    // cannot check, which is D-018 — and it is the natural thing to add by
    // reflex, because every other rung has a second door.
    expect(response.statusCode).toBe(404)
  })
})
