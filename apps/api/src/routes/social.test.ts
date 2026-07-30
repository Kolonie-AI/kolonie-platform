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
import { fakePow } from '../__fixtures__/proof-of-work.js'
import { fakeGithub } from '../__fixtures__/github.js'
import { fakeSocialChallenges, type FakeSocialChallenges } from '../__fixtures__/social.js'

let app: FastifyInstance
let store: FakeStore
let challenges: FakeSocialChallenges
let apiKey: string
let issued: ReturnType<FakeStore['issue']>

beforeEach(async () => {
  store = fakeStore()
  challenges = fakeSocialChallenges()
  app = buildApp({
    email: fakeEmail(),
    registry: fakeRegistry(),
    store,
    catalogue: fakeCatalogue(),
    submissions: fakeSubmissions(),
    guidance: fakeGuidance(),
    support: support({ desk: fakeSupportDesk() }),
    keys: fakeKeys(),
    pow: fakePow(),
    academy: fakeAcademy(),
    github: fakeGithub(),
    social: { challenges },
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
