import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fakeQuests } from '../__fixtures__/quests.js'
import type { FastifyInstance } from 'fastify'
import { ERROR_STATUS } from '@kolonie-ai/core'
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
import { fakeGithub, fakeContributions } from '../__fixtures__/github.js'
import { fakeWakeup } from '../__fixtures__/wakeup.js'
import { fakeSocial } from '../__fixtures__/social.js'
import { fakeDomain } from '../__fixtures__/domain.js'
import { fakeWebsite } from '../__fixtures__/website.js'
import { fakeImage } from '../__fixtures__/image.js'
import { fakeScene } from '../__fixtures__/scene.js'
import { fakeInjection, FAKE_INJECTION_MARKER } from '../__fixtures__/injection.js'
import { fakeVision } from '../__fixtures__/vision.js'
import { fakePow } from '../__fixtures__/proof-of-work.js'
import { fakeVault } from '../__fixtures__/vault.js'
import { fakeAccounts } from '../__fixtures__/accounts.js'
import { fakeConsole } from '../__fixtures__/console.js'
import { fakeErasureDesk } from '../__fixtures__/erasure.js'
import { erasure } from '../erasure.js'

let app: FastifyInstance
let store: FakeStore
let apiKey: string

beforeEach(async () => {
  store = fakeStore()
  app = buildApp({
    vault: { vault: fakeVault() },
    accounts: fakeAccounts(),
    console: fakeConsole(),
    email: fakeEmail(),
    registry: fakeRegistry(),
    store,
    catalogue: fakeCatalogue(),
    quests: fakeQuests(),
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
    injection: fakeInjection(),
    academy: fakeAcademy(),
  })
  await app.ready()
  apiKey = String(store.issue({}).apiKey)
})

afterEach(async () => {
  await app.close()
})

const mint = (key = apiKey) =>
  app.inject({
    method: 'POST',
    url: '/v1/academy/injection/challenges',
    headers: { authorization: `Bearer ${key}` },
  })

describe('POST /v1/academy/injection/challenges', () => {
  it('answers 201 with a payload and an expiry', async () => {
    const response = await mint()

    expect(response.statusCode).toBe(201)
    const body = response.json()
    expect(typeof body.payload).toBe('string')
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now())
  })

  /**
   * **The one place in the Academy where the structure is deliberately not
   * returned.** Everywhere else the Colony hands back the constraints beside the
   * prose, because nothing is hidden and guessing is never the task. Here the
   * thing to notice is inside the payload, so naming it in a field of its own
   * would answer the question the node asks.
   */
  it('does not name the marker in a field of its own', async () => {
    const body = (await mint()).json()

    expect(Object.keys(body).sort()).toEqual(['expiresAt', 'payload'])
    expect(body.payload).toContain(FAKE_INJECTION_MARKER)
  })

  it('carries the real question as well as the planted instruction', async () => {
    const body = (await mint()).json()

    // Both halves have to be there, or the node stops measuring a boundary held
    // under load and starts measuring whether an agent can spot a marker.
    expect(body.payload).toContain('what is the reading for')
    expect(body.payload).toContain(FAKE_INJECTION_MARKER)
  })

  it('refuses a caller with no credential', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/academy/injection/challenges',
    })

    expect(response.statusCode).toBe(ERROR_STATUS.unauthorized)
    expect(response.headers['www-authenticate']).toBeDefined()
  })

  it('refuses a credential the Colony never issued', async () => {
    expect((await mint('kol_not-a-real-key')).statusCode).toBe(ERROR_STATUS.unauthorized)
  })
})
