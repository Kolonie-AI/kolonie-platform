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
import { fakeKeys } from '../__fixtures__/keys.js'
import { fakeSolana } from '../__fixtures__/solana.js'
import { fakeVision } from '../__fixtures__/vision.js'
import { fakePow } from '../__fixtures__/proof-of-work.js'
import { fakeGithub } from '../__fixtures__/github.js'
import { fakeSocial } from '../__fixtures__/social.js'
import { fakeWebsite } from '../__fixtures__/website.js'
import { fakeAcademy, fakeChallenges, type FakeChallenges } from '../__fixtures__/academy.js'
import { fakeEmail } from '../__fixtures__/email.js'
import { expectedWidth, probeFor } from '../academy.js'
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
    email: fakeEmail(),
    registry: fakeRegistry(),
    store,
    catalogue: fakeCatalogue(),
    submissions: fakeSubmissions(),
    guidance: fakeGuidance(),
    support: support({ desk: fakeSupportDesk() }),
    retesting: { reset: async () => ({ outcome: 'not-a-tester' as const }) },
    keys: fakeKeys(),
    solana: fakeSolana(),
    pow: fakePow(),
    vision: fakeVision(),
    github: fakeGithub(),
    social: fakeSocial(),
    website: fakeWebsite(),
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

/**
 * A challenge of the badge's kind, minted straight through the port.
 *
 * Most of the hCaptcha tests below only need a challenge to exist, so they ask
 * the port for one rather than going through the route. That the *route* can
 * mint one — which it could not between `#29` and `#34`, leaving the badge
 * unstartable — is asserted on its own below.
 */
const mintCaptcha = async () => {
  const { agent } = store.issue()
  const { id } = await challenges.mint(agent.id, 'captcha')
  return { challengeId: id, agent }
}

/** Walk a capability challenge to its last outstanding step, as a browser would. */
const walk = async (challengeId: string, steps: number) => {
  let last
  for (let step = 0; step < steps; step += 1) {
    last = await app.inject({
      method: 'POST',
      url: `/v1/academy/browser/${challengeId}/steps`,
      payload: { step, width: expectedWidth(probeFor(challengeId, step)) },
    })
  }
  return last
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

  it('binds the challenge to the agent that minted it, not to whoever completes it', async () => {
    const { response, agent } = await mint()
    const { challengeId } = response.json()

    const cleared = await walk(challengeId, 3)

    expect(cleared?.statusCode).toBe(200)
    expect(await academy.challenges.clearedAt(agent.id, 'capability')).toBeTruthy()
  })

  /**
   * The badge's door. It had none between `#29` and `#34`: the rebuild pointed
   * this route at the capability challenge and the hCaptcha row was drafted, so
   * an active badge would have been a task nobody could start.
   */
  it('mints the badge’s challenge when the body asks for one', async () => {
    const { apiKey } = store.issue()

    const response = await app.inject({
      method: 'POST',
      url: '/v1/academy/challenges',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { kind: 'captcha' },
    })

    expect(response.statusCode).toBe(201)
    // The badge's page, not the rung's — the two never satisfy each other.
    expect(response.json().url).toContain('/captcha/')
  })

  it('mints the rung’s challenge when no kind is given', async () => {
    const { response } = await mint()

    expect(response.json().url).toContain('/browser/')
  })

  it('refuses a kind that is neither, rather than quietly choosing one', async () => {
    const { apiKey } = store.issue()

    const response = await app.inject({
      method: 'POST',
      url: '/v1/academy/challenges',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { kind: 'whatever' },
    })

    expect(response.statusCode).toBe(422)
    expect(response.json().code).toBe('validation_failed')
  })

  /**
   * The separation `#29` bought, asserted from both sides: the badge needs a
   * third party's sitekey and the rung needs a page this process serves, so an
   * unconfigured hCaptcha must not take the promoting rung down with it.
   */
  it('keeps the rung serving when the badge cannot', async () => {
    const withoutCaptcha = buildApp({
      email: fakeEmail(),
      registry: fakeRegistry(),
      store,
      catalogue: fakeCatalogue(),
      submissions: fakeSubmissions(),
      guidance: fakeGuidance(),
      support: support({ desk: fakeSupportDesk() }),
      retesting: { reset: async () => ({ outcome: 'not-a-tester' as const }) },
      keys: fakeKeys(),
      solana: fakeSolana(),
      pow: fakePow(),
      vision: fakeVision(),
      github: fakeGithub(),
      social: fakeSocial(),
      website: fakeWebsite(),
      academy: { ...academy, unavailableReason: 'HCAPTCHA_SITEKEY is not set' },
    })
    await withoutCaptcha.ready()
    const { apiKey } = store.issue()

    const badge = await withoutCaptcha.inject({
      method: 'POST',
      url: '/v1/academy/challenges',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { kind: 'captcha' },
    })
    const rung = await withoutCaptcha.inject({
      method: 'POST',
      url: '/v1/academy/challenges',
      headers: { authorization: `Bearer ${apiKey}` },
    })
    await withoutCaptcha.close()

    expect(badge.statusCode).toBe(503)
    expect(rung.statusCode).toBe(201)
  })
})

describe('POST /v1/academy/verify-captcha', () => {
  it('takes no credential — the caller is a browser', async () => {
    const { challengeId } = await mintCaptcha()

    const solved = await app.inject({
      method: 'POST',
      url: '/v1/academy/verify-captcha',
      payload: { challengeId, token: 'solved' },
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
    const { challengeId } = await mintCaptcha()
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
    const challengeId = challenges.mintExpired(agent.id, 'captcha')

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
    const { challengeId } = await mintCaptcha()

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
    const { challengeId } = await mintCaptcha()

    const attempted = await app.inject({
      method: 'POST',
      url: '/v1/academy/verify-captcha',
      payload: { challengeId, token: 'solved' },
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

describe('the capability rung — GET/POST /v1/academy/browser', () => {
  it('issues only the outstanding step, never the ones after it', async () => {
    const { response } = await mint()
    const { challengeId } = response.json()

    const first = await app.inject({ method: 'GET', url: `/v1/academy/browser/${challengeId}` })

    expect(first.statusCode).toBe(200)
    expect(first.json()).toMatchObject({ step: 0, total: 3 })
    // The whole sequence property: nothing in this response describes step 1.
    expect(JSON.stringify(first.json())).not.toContain(probeFor(challengeId, 1).width)
  })

  /**
   * Found by driving the page with a real Firefox, not by reading the code.
   *
   * The url names a challenge and its answer changes as the challenge advances,
   * so a cached response hands a resumed page a step it has already done. The
   * server then refuses it as out of order — correctly — and the challenge can
   * never finish. Every layer behaved as designed and the rung was unpassable.
   */
  it('forbids caching the probe, because the same url answers differently', async () => {
    const { response } = await mint()

    const opened = await app.inject({
      method: 'GET',
      url: `/v1/academy/browser/${response.json().challengeId}`,
    })

    expect(opened.headers['cache-control']).toBe('no-store')
  })

  it('takes no credential — the caller is a browser holding none', async () => {
    const { response } = await mint()

    const opened = await app.inject({
      method: 'GET',
      url: `/v1/academy/browser/${response.json().challengeId}`,
    })

    expect(opened.statusCode).toBe(200)
  })

  it('clears the challenge once every step is measured correctly', async () => {
    const { response, agent } = await mint()
    const { challengeId } = response.json()

    const cleared = await walk(challengeId, 3)

    expect(cleared?.statusCode).toBe(200)
    expect(cleared?.json()).toMatchObject({ status: 'verified', challengeType: 'capability' })
    expect(await academy.challenges.clearedAt(agent.id, 'capability')).toBeTruthy()
  })

  /**
   * The rejection case the rung exists for. A caller that never applied the
   * declaration has no way to know what it resolves to, and reporting a number
   * that is merely plausible must not pass.
   */
  it('refuses a width that is not what the declaration resolves to', async () => {
    const { response, agent } = await mint()
    const { challengeId } = response.json()

    const wrong = await app.inject({
      method: 'POST',
      url: `/v1/academy/browser/${challengeId}/steps`,
      payload: { step: 0, width: expectedWidth(probeFor(challengeId, 0)) + 40 },
    })

    expect(wrong.statusCode).toBe(422)
    expect(await academy.challenges.clearedAt(agent.id, 'capability')).toBeNull()
  })

  /**
   * A wrong measurement must not consume the step, the same courtesy the CAPTCHA
   * endpoint extends — an agent that misread once may fix it inside the window.
   */
  it('does not consume the step when the width was wrong', async () => {
    const { response } = await mint()
    const { challengeId } = response.json()

    await app.inject({
      method: 'POST',
      url: `/v1/academy/browser/${challengeId}/steps`,
      payload: { step: 0, width: 1 },
    })

    const retried = await app.inject({
      method: 'POST',
      url: `/v1/academy/browser/${challengeId}/steps`,
      payload: { step: 0, width: expectedWidth(probeFor(challengeId, 0)) },
    })

    expect(retried.statusCode).toBe(200)
    expect(retried.json()).toMatchObject({ step: 1 })
  })

  /**
   * One correct measurement replayed must not clear the rung. Without the step
   * number in the request this is exactly how three identical calls would.
   */
  it('refuses a step that is not the one outstanding', async () => {
    const { response, agent } = await mint()
    const { challengeId } = response.json()

    await app.inject({
      method: 'POST',
      url: `/v1/academy/browser/${challengeId}/steps`,
      payload: { step: 0, width: expectedWidth(probeFor(challengeId, 0)) },
    })

    const replayed = await app.inject({
      method: 'POST',
      url: `/v1/academy/browser/${challengeId}/steps`,
      payload: { step: 0, width: expectedWidth(probeFor(challengeId, 0)) },
    })

    expect(replayed.statusCode).toBe(422)
    expect(replayed.json().message).toMatch(/not the one outstanding/i)
    expect(await academy.challenges.clearedAt(agent.id, 'capability')).toBeNull()
  })

  it('refuses an expired challenge', async () => {
    const { agent } = store.issue()
    const challengeId = challenges.mintExpired(agent.id, 'capability')

    const response = await app.inject({ method: 'GET', url: `/v1/academy/browser/${challengeId}` })

    expect(response.statusCode).toBe(422)
    expect(response.json().message).toMatch(/expired/i)
  })

  /**
   * The kinds must not satisfy each other. An hCaptcha id here is not a stale
   * challenge — it is not this rung's challenge at all, and saying "expired"
   * would send an agent back to an id that can never work.
   */
  it('does not recognise a challenge minted for the badge', async () => {
    const { challengeId } = await mintCaptcha()

    const response = await app.inject({ method: 'GET', url: `/v1/academy/browser/${challengeId}` })

    expect(response.statusCode).toBe(404)
  })

  it('clearing the rung does not also award the hCaptcha badge', async () => {
    const { response, agent } = await mint()

    await walk(response.json().challengeId, 3)

    expect(await academy.challenges.clearedAt(agent.id, 'capability')).toBeTruthy()
    expect(await academy.challenges.clearedAt(agent.id, 'captcha')).toBeNull()
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

describe('when the gate is not configured', () => {
  /**
   * The property CI found the hard way. Making the sitekey mandatory at startup
   * meant the process would not boot without it — so registration, the task
   * list, submissions and the whole MCP surface went down for want of one rung's
   * configuration. The gate degrades; nothing else notices.
   */
  const unconfigured = () =>
    buildApp({
      email: fakeEmail(),
      registry: fakeRegistry(),
      store: fakeStore(),
      catalogue: fakeCatalogue(),
      submissions: fakeSubmissions(),
      guidance: fakeGuidance(),
      support: support({ desk: fakeSupportDesk() }),
      retesting: { reset: async () => ({ outcome: 'not-a-tester' as const }) },
      keys: fakeKeys(),
      solana: fakeSolana(),
      pow: fakePow(),
      vision: fakeVision(),
      github: fakeGithub(),
      social: fakeSocial(),
      website: fakeWebsite(),
      academy: { ...fakeAcademy(), unavailableReason: 'HCAPTCHA_SITEKEY not set' },
    })

  it('answers 503 on the gate, naming what is missing', async () => {
    const disabled = unconfigured()
    await disabled.ready()

    for (const url of ['/v1/academy/captcha-config', '/v1/academy/verify-captcha']) {
      const response = await disabled.inject({
        method: url.endsWith('config') ? 'GET' : 'POST',
        url,
        payload: url.endsWith('config') ? undefined : { challengeId: 'x', token: 'y' },
      })
      expect(response.statusCode).toBe(503)
      expect(response.json().message).toMatch(/HCAPTCHA_SITEKEY not set/)
    }

    await disabled.close()
  })

  it('leaves every other route working', async () => {
    const disabled = unconfigured()
    await disabled.ready()

    expect((await disabled.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200)
    expect((await disabled.inject({ method: 'GET', url: '/v1' })).statusCode).toBe(200)
    const registered = await disabled.inject({
      method: 'POST',
      url: '/v1/agents/register',
      payload: { name: 'unblocked', platform: 'openclaw' },
    })
    expect(registered.statusCode).toBe(201)

    await disabled.close()
  })

  /**
   * **The property the rebuild exists to guarantee.** Until 2026-07-29 one
   * `unavailableReason` covered the whole Academy surface, so an unset hCaptcha
   * sitekey — a third party's value, for a task that is now optional — disabled
   * the promoting rung and stalled every arriving agent at Level 1.
   *
   * `kolonie-docs#33` requires a promoting rung to depend on nothing an outside
   * party controls. This test is where that requirement is kept or quietly lost,
   * so it asserts the whole rung end to end rather than one status code.
   */
  it('leaves Level 1 passable — the promoting rung owes hCaptcha nothing', async () => {
    const disabledStore = fakeStore()
    const disabled = buildApp({
      email: fakeEmail(),
      registry: fakeRegistry(),
      store: disabledStore,
      catalogue: fakeCatalogue(),
      submissions: fakeSubmissions(),
      guidance: fakeGuidance(),
      support: support({ desk: fakeSupportDesk() }),
      retesting: { reset: async () => ({ outcome: 'not-a-tester' as const }) },
      keys: fakeKeys(),
      solana: fakeSolana(),
      pow: fakePow(),
      vision: fakeVision(),
      github: fakeGithub(),
      social: fakeSocial(),
      website: fakeWebsite(),
      academy: { ...fakeAcademy(), unavailableReason: 'HCAPTCHA_SITEKEY not set' },
    })
    await disabled.ready()

    const { apiKey } = disabledStore.issue()
    const minted = await disabled.inject({
      method: 'POST',
      url: '/v1/academy/challenges',
      headers: { authorization: `Bearer ${apiKey}` },
    })
    expect(minted.statusCode).toBe(201)

    const { challengeId } = minted.json()
    let last
    for (let step = 0; step < 3; step += 1) {
      last = await disabled.inject({
        method: 'POST',
        url: `/v1/academy/browser/${challengeId}/steps`,
        payload: { step, width: expectedWidth(probeFor(challengeId, step)) },
      })
    }

    expect(last?.statusCode).toBe(200)
    expect(last?.json()).toMatchObject({ status: 'verified', challengeType: 'capability' })

    await disabled.close()
  })
})
