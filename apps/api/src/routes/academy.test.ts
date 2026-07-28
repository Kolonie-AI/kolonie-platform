import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app.js'
import { fakeRegistry } from '../__fixtures__/registry.js'
import { fakeStore, type FakeStore } from '../__fixtures__/store.js'
import { fakeCatalogue } from '../__fixtures__/catalogue.js'
import { fakeSubmissions } from '../__fixtures__/submissions.js'
import { fakeAcademy, fakeChallenges, type FakeChallenges } from '../__fixtures__/academy.js'
import type { CaptchaCheck } from '../academy.js'
import type { AcademyDependencies } from '../academy.js'

let app: FastifyInstance
let store: FakeStore
let challenges: FakeChallenges
let academy: AcademyDependencies

const build = (answer: CaptchaCheck = 'passed') => {
  store = fakeStore()
  challenges = fakeChallenges()
  academy = fakeAcademy(answer, challenges)
  return buildApp({
    registry: fakeRegistry(),
    store,
    catalogue: fakeCatalogue(),
    submissions: fakeSubmissions(),
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

const mint = async () => {
  const { apiKey, agent } = store.issue()
  const response = await app.inject({
    method: 'POST',
    url: '/v1/academy/challenges',
    headers: { authorization: `Bearer ${apiKey}` },
  })
  return { response, apiKey, agent }
}

describe('POST /v1/academy/challenges', () => {
  it('mints a challenge and hands back the url to open', async () => {
    const { response } = await mint()

    expect(response.statusCode).toBe(201)
    const body = response.json()
    expect(body.challengeId).toBeTruthy()
    expect(body.expiresAt).toBeTruthy()
    // The id travels in the url, because the page has no other way to learn it.
    expect(new URL(body.url).searchParams.get('c')).toBe(body.challengeId)
  })

  /**
   * The authenticated half of the gate. Everything after this happens in a
   * browser with no credential, so if this door were open the challenge id would
   * prove nothing about who is behind it (D-024).
   */
  it('refuses a caller with no key', async () => {
    const response = await app.inject({ method: 'POST', url: '/v1/academy/challenges' })

    expect(response.statusCode).toBe(401)
    expect(response.headers['www-authenticate']).toBeTruthy()
  })

  it('binds the challenge to the agent that minted it, not to whoever solves it', async () => {
    const { response, agent } = await mint()
    const { challengeId } = response.json()

    const solved = await app.inject({
      method: 'POST',
      url: '/v1/academy/verify-captcha',
      payload: { challengeId, token: 'anything' },
    })

    expect(solved.statusCode).toBe(200)
    expect(await academy.challenges.clearedAt(agent.id)).toBeTruthy()
  })
})

describe('POST /v1/academy/verify-captcha', () => {
  it('takes no credential — the caller is a browser', async () => {
    const { response } = await mint()

    const solved = await app.inject({
      method: 'POST',
      url: '/v1/academy/verify-captcha',
      payload: { challengeId: response.json().challengeId, token: 'solved' },
    })

    expect(solved.statusCode).toBe(200)
    expect(solved.json()).toMatchObject({ status: 'verified', challengeType: 'captcha' })
  })

  it('rejects a challenge id nobody minted', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/academy/verify-captcha',
      payload: { challengeId: crypto.randomUUID(), token: 'solved' },
    })

    expect(response.statusCode).toBe(404)
    expect(response.json().code).toBe('not_found')
  })

  it('refuses to redeem the same challenge twice', async () => {
    const { response } = await mint()
    const { challengeId } = response.json()
    const solve = () =>
      app.inject({
        method: 'POST',
        url: '/v1/academy/verify-captcha',
        payload: { challengeId, token: 'solved' },
      })

    expect((await solve()).statusCode).toBe(200)
    const again = await solve()
    expect(again.statusCode).toBe(422)
    expect(again.json().message).toMatch(/already solved/i)
  })

  it('refuses an expired challenge', async () => {
    const { agent } = store.issue()
    const challengeId = challenges.mintExpired(agent.id)

    const response = await app.inject({
      method: 'POST',
      url: '/v1/academy/verify-captcha',
      payload: { challengeId, token: 'solved' },
    })

    expect(response.statusCode).toBe(422)
    expect(response.json().message).toMatch(/expired/i)
  })

  /**
   * A failed CAPTCHA must not consume the attempt. An agent whose first solve is
   * rejected — a mistyped widget, a stale token — can try again on the same id
   * until it expires, which is why the token is checked before the redemption.
   */
  it('does not consume the challenge when the CAPTCHA was not solved', async () => {
    app = build('failed')
    await app.ready()
    const { response } = await mint()
    const { challengeId } = response.json()

    const failed = await app.inject({
      method: 'POST',
      url: '/v1/academy/verify-captcha',
      payload: { challengeId, token: 'wrong' },
    })

    expect(failed.statusCode).toBe(422)
    // Still unredeemed: the agent has not cleared the gate.
    expect(await academy.challenges.redeem(challengeId)).toMatchObject({ outcome: 'verified' })
  })

  /**
   * The distinction the whole endpoint turns on. If hCaptcha cannot be reached,
   * the agent has not failed — we could not ask. Reporting that as a failure
   * charges the agent for our outage.
   */
  it('answers 500, never a failure, when hCaptcha cannot be reached', async () => {
    app = build('unavailable')
    await app.ready()
    const { response } = await mint()

    const attempted = await app.inject({
      method: 'POST',
      url: '/v1/academy/verify-captcha',
      payload: { challengeId: response.json().challengeId, token: 'solved' },
    })

    expect(attempted.statusCode).toBe(500)
    expect(attempted.json().message).toMatch(/not a failure/i)
  })

  it('rejects a body that is not shaped as documented', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/academy/verify-captcha',
      payload: { token: 'no challenge id' },
    })

    expect(response.statusCode).toBe(422)
    expect(response.json().code).toBe('validation_failed')
  })
})

describe('GET /v1/academy/captcha-config', () => {
  it('serves the sitekey the page needs, without a credential', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/academy/captcha-config' })

    expect(response.statusCode).toBe(200)
    expect(response.json().sitekey).toBe('test-sitekey')
  })

  it('never serves the secret half', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/academy/captcha-config' })

    expect(Object.keys(response.json())).toEqual(['sitekey'])
  })
})
