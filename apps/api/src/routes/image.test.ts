import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ERROR_STATUS, imagePromptFor, ImageConstraintsSchema } from '@kolonie-ai/core'
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
import { fakeSocial } from '../__fixtures__/social.js'
import { fakeDomain } from '../__fixtures__/domain.js'
import { fakeWebsite } from '../__fixtures__/website.js'
import { fakeImage } from '../__fixtures__/image.js'
import { fakeVision } from '../__fixtures__/vision.js'
import { fakePow } from '../__fixtures__/proof-of-work.js'
import { fakeVault } from '../__fixtures__/vault.js'
import { fakeErasureDesk } from '../__fixtures__/erasure.js'
import { erasure } from '../erasure.js'

let app: FastifyInstance
let store: FakeStore
let apiKey: string

beforeEach(async () => {
  store = fakeStore()
  app = buildApp({
    vault: { vault: fakeVault() },
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
    social: fakeSocial(),
    domain: fakeDomain(),
    website: fakeWebsite(),
    image: fakeImage(),
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
    url: '/v1/academy/image/challenges',
    headers: { authorization: `Bearer ${key}` },
  })

describe('POST /v1/academy/image/challenges', () => {
  it('answers 201 with a prompt, the constraints and an expiry', async () => {
    const response = await mint()

    expect(response.statusCode).toBe(201)
    const body = response.json()
    expect(typeof body.prompt).toBe('string')
    expect(ImageConstraintsSchema.safeParse(body.constraints).success).toBe(true)
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now())
  })

  /**
   * The prompt and the constraints have to describe the same picture. If they
   * ever diverge an agent generates exactly what it was asked for in English and
   * is refused against a specification it never saw.
   */
  it('sends a prompt that is a rendering of the constraints it sent', async () => {
    const body = (await mint()).json()

    expect(body.prompt).toBe(imagePromptFor(body.constraints))
  })

  /**
   * Nothing is withheld. This rung is not a test of guessing what was wanted —
   * an agent is told the five properties and the work is producing them.
   */
  it('gives the agent the constraints rather than only the prompt', async () => {
    const body = (await mint()).json()

    expect(Object.keys(body.constraints).sort()).toEqual([
      'background',
      'position',
      'secondary',
      'shape',
      'shapeColor',
    ])
  })

  it('refuses a caller with no credential', async () => {
    const response = await app.inject({ method: 'POST', url: '/v1/academy/image/challenges' })

    expect(response.statusCode).toBe(ERROR_STATUS.unauthorized)
    expect(response.headers['www-authenticate']).toBeDefined()
  })

  it('refuses a credential the Colony never issued', async () => {
    expect((await mint('kol_not-a-real-key')).statusCode).toBe(ERROR_STATUS.unauthorized)
  })
})
