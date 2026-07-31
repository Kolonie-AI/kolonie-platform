import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { InjectOptions, Response as InjectResponse } from 'light-my-request'
import type { AgentId } from '@kolonie-ai/core'
import { buildApp } from './app.js'
import { fakeRegistry } from './__fixtures__/registry.js'
import { fakeSolana } from './__fixtures__/solana.js'
import { fakeKeys } from './__fixtures__/keys.js'
import { fakeVision } from './__fixtures__/vision.js'
import { fakePow } from './__fixtures__/proof-of-work.js'
import { fakeGithub } from './__fixtures__/github.js'
import { fakeSocial } from './__fixtures__/social.js'
import { fakeWebsite } from './__fixtures__/website.js'
import { fakeImage } from './__fixtures__/image.js'
import { fakeStore, type FakeStore } from './__fixtures__/store.js'
import { fakeCatalogue } from './__fixtures__/catalogue.js'
import { fakeSubmissions } from './__fixtures__/submissions.js'
import { fakeGuidance } from './__fixtures__/guidance.js'
import { fakeSupportDesk } from './__fixtures__/support.js'
import { fakeErasureDesk } from './__fixtures__/erasure.js'
import { erasure } from './erasure.js'
import { support } from './support.js'
import { fakeAcademy } from './__fixtures__/academy.js'
import { fakeVault } from './__fixtures__/vault.js'
import {
  fakeEmail,
  fakeEmailChallenges,
  fakeMailer,
  FAKE_CHALLENGE_DOMAIN,
  FAKE_INBOUND_SECRET,
  type FakeEmailChallenges,
  type FakeMailer,
} from './__fixtures__/email.js'

let app: FastifyInstance
let store: FakeStore
let challenges: FakeEmailChallenges
let mailer: FakeMailer
let apiKey: string
let agentId: AgentId

/**
 * `inboundSecret` is a required parameter with no default, deliberately.
 *
 * It was optional, and the test below that asserts the route is absent without a
 * secret called `build(undefined)` — which triggers the default and rebuilds the
 * app *with* the secret. The assertion passed nothing and would have gone on
 * passing nothing while the fail-closed property rotted.
 */
const build = (inboundSecret: string | undefined) => {
  store = fakeStore()
  challenges = fakeEmailChallenges()
  mailer = fakeMailer()
  return buildApp({
    vault: { vault: fakeVault() },
    registry: fakeRegistry(),
    store,
    catalogue: fakeCatalogue(),
    submissions: fakeSubmissions(),
    guidance: fakeGuidance(),
    support: support({ desk: fakeSupportDesk() }),
    erasure: erasure({ desk: fakeErasureDesk() }),
    retesting: { reset: async () => ({ outcome: 'not-a-tester' as const }) },
    academy: fakeAcademy(),
    keys: fakeKeys(),
    solana: fakeSolana(),
    pow: fakePow(),
    vision: fakeVision(),
    github: fakeGithub(),
    social: fakeSocial(),
    website: fakeWebsite(),
    image: fakeImage(),
    email: { ...fakeEmail(challenges, mailer), inboundSecret },
  })
}

beforeEach(async () => {
  app = build(FAKE_INBOUND_SECRET)
  await app.ready()
  const issued = store.issue()
  apiKey = String(issued.apiKey)
  agentId = issued.agent.id
})

afterEach(async () => {
  await app.close()
})

const post = (options: InjectOptions): Promise<InjectResponse> => app.inject(options)

const authed = (url: string, payload: Record<string, unknown>) =>
  post({ method: 'POST', url, payload, headers: { authorization: `Bearer ${apiKey}` } })

const open = (email: string) => authed('/v1/academy/email/challenges', { email })
const handBack = (code: string) => authed('/v1/academy/email/code', { code })

const deliver = (to: string, from: string, secret = FAKE_INBOUND_SECRET) =>
  post({
    method: 'POST',
    url: '/v1/internal/email-inbound',
    payload: { from, to },
    headers: { 'x-kolonie-inbound-secret': secret },
  })

/** The whole rung over HTTP, exactly as an agent would climb it. */
const climb = async (address: string) => {
  const opened = await open(address)
  const { address: challengeAddress } = opened.json()
  await deliver(challengeAddress, address)
  // The code reaches the agent by mail now, so the test reads it where the
  // agent would: out of what the Colony sent, not out of an HTTP response.
  const code = String(mailer.sent.at(-1)?.text ?? '').match(/\b[0-9A-F]{12}\b/)?.[0] ?? ''
  return { challengeAddress, code, handedBack: await handBack(code) }
}

describe('POST /v1/academy/email/challenges', () => {
  it('mints an address under the configured domain', async () => {
    const response = await open('citizen@example.org')

    expect(response.statusCode).toBe(201)
    expect(String(response.json().address)).toMatch(
      new RegExp(`^[0-9a-f]+@${FAKE_CHALLENGE_DOMAIN}$`),
    )
    expect(response.json().expiresAt).toBeTruthy()
  })

  it('refuses an anonymous caller', async () => {
    const response = await post({
      method: 'POST',
      url: '/v1/academy/email/challenges',
      payload: { email: 'citizen@example.org' },
    })

    expect(response.statusCode).toBe(401)
  })

  it('refuses something that is not an address', async () => {
    const response = await open('not-an-address')

    expect(response.statusCode).toBe(422)
    expect(response.json().code).toBe('validation_failed')
  })

  /**
   * A newline in a claimed address would end up in the reply the Worker
   * composes, which is a header injection one hop away.
   */
  it('refuses an address containing a newline', async () => {
    const response = await open('citizen@example.org\nBcc: victim@example.net')

    expect(response.statusCode).toBe(422)
  })

  it('refuses an address another citizen has proved', async () => {
    challenges.claimForAnother('taken@example.org')

    const response = await open('taken@example.org')

    expect(response.statusCode).toBe(409)
    expect(response.json().code).toBe('conflict')
  })
})

describe('the inbound handler', () => {
  it('mails a code to the address that wrote in, when the sender matches', async () => {
    const opened = await open('citizen@example.org')
    const response = await deliver(opened.json().address, 'citizen@example.org')

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ delivered: true })
    expect(mailer.sent).toHaveLength(1)
    expect(mailer.sent[0]?.to).toBe('citizen@example.org')
    expect(mailer.sent[0]?.text).toMatch(/\b[0-9A-F]{12}\b/)
  })

  /**
   * The whole point of the send half. A mail claiming to be from the address,
   * sent by somebody else, must not open the rung.
   */
  it('does not reply to mail from an address other than the one claimed', async () => {
    const opened = await open('citizen@example.org')
    const response = await deliver(opened.json().address, 'attacker@example.net')

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      delivered: false,
      reason: 'sender is not the claimed address',
    })
    expect(mailer.sent).toHaveLength(0)
  })

  it('sends nothing for a token it never minted', async () => {
    const response = await deliver(`deadbeef@${FAKE_CHALLENGE_DOMAIN}`, 'citizen@example.org')

    expect(response.json()).toEqual({ delivered: false, reason: 'unknown token' })
    expect(mailer.sent).toHaveLength(0)
  })

  /** A plus-tag added by a forwarder must not hide the token. */
  it('finds the token behind a plus-tag', async () => {
    const opened = await open('citizen@example.org')
    const token = String(opened.json().address).split('@')[0]

    const response = await deliver(
      `${token}+forwarded@${FAKE_CHALLENGE_DOMAIN}`,
      'citizen@example.org',
    )

    expect(response.json()).toEqual({ delivered: true })
  })

  it('refuses a caller that does not hold the secret', async () => {
    const opened = await open('citizen@example.org')
    const response = await deliver(opened.json().address, 'citizen@example.org', 'wrong-secret')

    expect(response.statusCode).toBe(401)
  })

  it('refuses a caller presenting no secret at all', async () => {
    const opened = await open('citizen@example.org')
    const response = await post({
      method: 'POST',
      url: '/v1/internal/email-inbound',
      payload: { from: 'citizen@example.org', to: opened.json().address },
    })

    expect(response.statusCode).toBe(401)
  })

  /**
   * Fails closed, and the whole route is absent rather than open. This endpoint
   * turns "a mail arrived" into a fact the Colony pays a reward for.
   */
  it('is not mounted at all when no secret is configured', async () => {
    await app.close()
    app = build(undefined)
    await app.ready()
    const issued = store.issue()
    apiKey = String(issued.apiKey)
    agentId = issued.agent.id

    const opened = await open('citizen@example.org')
    const response = await post({
      method: 'POST',
      url: '/v1/internal/email-inbound',
      payload: { from: 'citizen@example.org', to: opened.json().address },
      headers: { 'x-kolonie-inbound-secret': FAKE_INBOUND_SECRET },
    })

    expect(response.statusCode).toBe(404)
  })

  /**
   * SMTP retries are normal, and Cloudflare will redeliver on a non-2xx. A
   * second delivery must answer with the code the agent already read.
   */
  it('mails the same code again when a message is redelivered', async () => {
    const opened = await open('citizen@example.org')
    await deliver(opened.json().address, 'citizen@example.org')
    await deliver(opened.json().address, 'citizen@example.org')

    const codes = mailer.sent.map((m) => m.text.match(/\b[0-9A-F]{12}\b/)?.[0])
    expect(codes).toHaveLength(2)
    expect(codes[1]).toBe(codes[0])
  })

  /**
   * The one case where the Worker must retry: the Colony's own sender failed,
   * so the agent did nothing wrong and must not lose its attempt.
   */
  it('asks for redelivery when the mailer is down, and not otherwise', async () => {
    const opened = await open('citizen@example.org')
    mailer.breakIt()

    const response = await deliver(opened.json().address, 'citizen@example.org')

    expect(response.statusCode).toBe(502)
    expect(response.json()).toMatchObject({ delivered: false, retry: true })
  })

  it('answers 200 when it decided to do nothing, so nothing is redelivered', async () => {
    const response = await deliver(`deadbeef@${FAKE_CHALLENGE_DOMAIN}`, 'someone@example.net')

    expect(response.statusCode).toBe(200)
  })
})

describe('POST /v1/academy/email/code', () => {
  it('completes the round trip', async () => {
    const { handedBack } = await climb('citizen@example.org')

    expect(handedBack.statusCode).toBe(200)
    expect(handedBack.json()).toEqual({ verified: true, address: 'citizen@example.org' })
  })

  it('refuses an anonymous caller', async () => {
    const response = await post({
      method: 'POST',
      url: '/v1/academy/email/code',
      payload: { code: 'ABCDEF123456' },
    })

    expect(response.statusCode).toBe(401)
  })

  it('refuses a wrong code', async () => {
    const opened = await open('citizen@example.org')
    await deliver(opened.json().address, 'citizen@example.org')

    const response = await handBack('AAAAAAAAAAAA')

    expect(response.statusCode).toBe(422)
  })

  /**
   * The distinction that decides the agent's next move: send a mail, or read
   * one more carefully.
   */
  it('says the mail has not arrived rather than that the code is wrong', async () => {
    await open('citizen@example.org')

    const response = await handBack('AAAAAAAAAAAA')

    expect(response.statusCode).toBe(409)
    expect(response.json().message).toContain('No mail from your address')
  })

  it('tells an agent with no challenge to open one', async () => {
    const response = await handBack('AAAAAAAAAAAA')

    expect(response.statusCode).toBe(404)
  })

  it('reports an expired challenge as expired, not as a wrong code', async () => {
    const opened = await open('citizen@example.org')
    await deliver(opened.json().address, 'citizen@example.org')
    challenges.expire(agentId)

    const response = await handBack('AAAAAAAAAAAA')

    expect(response.statusCode).toBe(410)
    expect(response.json().code).toBe('task_expired')
  })
})
