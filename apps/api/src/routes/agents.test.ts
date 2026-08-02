import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import {
  API_KEY_PREFIX,
  CheckNameResponseSchema,
  ERROR_STATUS,
  RegisterAgentResponseSchema,
} from '@kolonie-ai/core'
import { buildApp } from '../app.js'
import { NAME_CHECK_LIMIT, REGISTRATION_LIMIT, REGISTRATION_WINDOW_MS } from '../rate-limit.js'
import type { AgentRegistry } from '../registration.js'
import { brokenRegistry, DRIVER_FAILURE_MESSAGE, fakeRegistry } from '../__fixtures__/registry.js'
import { fakeKeys } from '../__fixtures__/keys.js'
import { fakeSolana } from '../__fixtures__/solana.js'
import { fakeVision } from '../__fixtures__/vision.js'
import { fakePow } from '../__fixtures__/proof-of-work.js'
import { fakeGithub, fakeContributions } from '../__fixtures__/github.js'
import { fakeSocial } from '../__fixtures__/social.js'
import { fakeDomain } from '../__fixtures__/domain.js'
import { fakeWebsite } from '../__fixtures__/website.js'
import { fakeImage } from '../__fixtures__/image.js'
import { fakeStore } from '../__fixtures__/store.js'
import { fakeCatalogue } from '../__fixtures__/catalogue.js'
import { fakeSubmissions } from '../__fixtures__/submissions.js'
import { fakeGuidance } from '../__fixtures__/guidance.js'
import { fakeSupportDesk } from '../__fixtures__/support.js'
import { support } from '../support.js'
import { fakeAcademy } from '../__fixtures__/academy.js'
import { fakeEmail } from '../__fixtures__/email.js'
import { fakeVault } from '../__fixtures__/vault.js'
import { fakeAccounts } from '../__fixtures__/accounts.js'
import { fakeConsole } from '../__fixtures__/console.js'
import { fakeErasureDesk } from '../__fixtures__/erasure.js'
import { erasure } from '../erasure.js'

let app: FastifyInstance

const withRegistry = async (registry: AgentRegistry = fakeRegistry()) => {
  app = buildApp({
    vault: { vault: fakeVault() },
    accounts: fakeAccounts(),
    console: fakeConsole(),
    email: fakeEmail(),
    registry,
    store: fakeStore(),
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
    contributions: fakeContributions(),
    social: fakeSocial(),
    domain: fakeDomain(),
    website: fakeWebsite(),
    image: fakeImage(),
  })
  await app.ready()
  return app
}

const register = (payload: object | string) =>
  app.inject({ method: 'POST', url: '/v1/agents/register', payload })

afterEach(async () => {
  await app?.close()
})

describe('POST /v1/agents/register', () => {
  it('creates an agent and answers 201', async () => {
    await withRegistry()
    const response = await register({ name: 'canary', platform: 'openclaw' })

    expect(response.statusCode).toBe(201)
  })

  it('answers exactly the shape core documents', async () => {
    await withRegistry()
    const response = await register({ name: 'canary', platform: 'openclaw' })

    // Once a skill ships, foreign agents have this shape hard-coded and the
    // Colony no longer controls their upgrade cycle. `strict` catches an extra
    // field as well as a missing one, because an extra field today is a field
    // someone depends on tomorrow.
    expect(() => RegisterAgentResponseSchema.strict().parse(response.json())).not.toThrow()
  })

  it('returns the API key, once, prefixed so a leak is greppable', async () => {
    await withRegistry()
    const response = await register({ name: 'canary', platform: 'openclaw' })

    expect(response.json().credentials.apiKey.startsWith(API_KEY_PREFIX)).toBe(true)
  })

  it('starts every agent as a candidate holding no skills', async () => {
    await withRegistry()
    const body = (await register({ name: 'canary', platform: 'openclaw' })).json()

    expect(body.agent.status).toBe('candidate')
    expect(body.agent.roles).toEqual([])
    expect(body.agent.skills).toEqual([])
  })

  it('defaults the optional profile fields rather than omitting them', async () => {
    await withRegistry()
    const body = (await register({ name: 'canary', platform: 'openclaw' })).json()

    // Documented in RegisterAgentRequestSchema: a consumer never has to tell
    // `undefined` from `null`.
    expect(body.agent.profile.operator).toBeNull()
    expect(body.agent.profile.bio).toBeNull()
    expect(body.agent.profile.capabilities).toEqual([])
    // Retired with `#102`: an address is proved at the `solana-wallet` rung, so
    // there is no profile field for one to default.
    expect(Object.keys(body.agent.profile)).not.toContain('wallet')
  })

  /**
   * **The arrival stops being a form** (`#137`). These three are Academy Level 0
   * — the moment an agent decides what it is — and a door that accepted them let
   * the rung be satisfied in the registration call, before the agent had
   * considered the question. Measured across live onboardings, what filled them
   * in was usually the operator.
   *
   * Refused rather than dropped, for the reason the `wallet` case above records:
   * an agent that had its capabilities silently discarded would arrive believing
   * Level 0 was behind it, and find out only by failing a task it thought it had
   * already passed.
   */
  it.each(['capabilities', 'bio', 'avatarUrl'])(
    'refuses %s at registration rather than pre-filling the profile with it',
    async (field) => {
      await withRegistry()

      const values: Record<string, unknown> = {
        capabilities: ['typescript'],
        bio: 'Written by somebody who is not this agent.',
        avatarUrl: 'https://example.invalid/face.png',
      }

      const response = await register({
        name: 'canary',
        platform: 'openclaw',
        [field]: values[field],
      })

      expect(response.statusCode).toBe(422)
      expect(response.json().code).toBe('validation_failed')
      // The field is named, so the agent learns which one to stop sending rather
      // than only that the body was wrong. An unrecognised key has no path, so
      // it arrives in the message under `(body)` rather than as its own key.
      expect(JSON.stringify(response.json().details)).toContain(field)
    },
  )

  /** What still belongs at the door: the row cannot exist without them. */
  it('still accepts the three fields registration is for', async () => {
    await withRegistry()
    const response = await register({
      name: 'canary',
      platform: 'openclaw',
      operator: 'Gregor Sprint',
    })

    expect(response.statusCode).toBe(201)
    expect(response.json().agent.profile.operator).toBe('Gregor Sprint')
  })

  /**
   * **Silence is the failure this prevents.** A dropped field is a field the
   * caller believes it set — and the case that made it concrete is `wallet`,
   * retired from the profile in `#102` while this path still answered `201` and
   * threw it away. An agent following an older guide would have registered
   * believing it had recorded an address, then waited to be paid at one the
   * Colony never had.
   */
  it('refuses an unknown field rather than dropping it', async () => {
    await withRegistry()

    const response = await register({
      name: 'canary',
      platform: 'openclaw',
      wallet: 'So11111111111111111111111111111111111111112',
    })

    expect(response.statusCode).toBe(422)
    expect(response.json().code).toBe('validation_failed')
  })

  it('never puts the key on the agent entity', async () => {
    await withRegistry()
    const body = (await register({ name: 'canary', platform: 'openclaw' })).json()

    expect(JSON.stringify(body.agent)).not.toContain(API_KEY_PREFIX)
  })

  it('matches the curl example in onboarding/agent-guide.md', async () => {
    await withRegistry()
    // That document is what a foreign agent reads before it writes any code.
    // If this test has to change, the document changes in the same PR.
    const response = await register({ name: 'your-name', platform: 'openclaw' })

    expect(response.statusCode).toBe(201)
    expect(response.json().credentials.apiKey).toBeTypeOf('string')
  })
})

/**
 * The HTTP half of the name check (`#138`), so the two surfaces cannot diverge.
 *
 * This is also where the `validation_failed` vocabulary is asserted: over MCP the
 * SDK refuses a malformed name against the tool's input schema before the handler
 * runs, so `CheckNameRequestSchema` is only reached on this path.
 */
describe('POST /v1/agents/name-check', () => {
  const check = (payload: object) =>
    app.inject({ method: 'POST', url: '/v1/agents/name-check', payload })

  it('answers 200 and free for a name nobody holds', async () => {
    await withRegistry()

    const response = await check({ name: 'nobody-has-this' })

    // 200 and not 201: nothing was created, and asking reserves nothing.
    expect(response.statusCode).toBe(200)
    expect(() => CheckNameResponseSchema.strict().parse(response.json())).not.toThrow()
    expect(response.json().available).toBe(true)
  })

  it('answers taken for a registered name, compared case-insensitively', async () => {
    await withRegistry()
    await register({ name: 'Canary', platform: 'openclaw' })

    expect((await check({ name: 'canary' })).json().available).toBe(false)
    expect((await check({ name: 'CANARY' })).json().available).toBe(false)
  })

  /** Free or taken. The response shape is what keeps the holder out of it. */
  it('answers with exactly two fields, so nothing about the holder can ride along', async () => {
    await withRegistry()
    await register({ name: 'canary', platform: 'openclaw', operator: 'Gregor Sprint' })

    const body = (await check({ name: 'canary' })).json()

    expect(Object.keys(body).sort()).toEqual(['available', 'name'])
    expect(JSON.stringify(body)).not.toContain('Gregor Sprint')
  })

  it('refuses a malformed name in the vocabulary registration uses', async () => {
    await withRegistry()

    const response = await check({ name: 'x' })

    expect(response.statusCode).toBe(ERROR_STATUS.validation_failed)
    expect(response.json().code).toBe('validation_failed')
    expect(Object.keys(response.json().details)).toContain('name')
  })

  /** `.strict()`, for the reason registration is: a dropped field is a field the caller believes it sent. */
  it('refuses an unknown field rather than ignoring it', async () => {
    await withRegistry()

    const response = await check({ name: 'canary', platform: 'openclaw' })

    expect(response.statusCode).toBe(ERROR_STATUS.validation_failed)
  })

  /**
   * Asking must not consume the allowance that lets an agent actually join. The
   * two calls cost different things — a check creates nothing — so they carry
   * separate allowances, and this is the property that makes deliberating about
   * a name free rather than something an agent pays for in registrations.
   */
  it('does not spend the registration allowance', async () => {
    await withRegistry()

    for (let attempt = 0; attempt < NAME_CHECK_LIMIT; attempt += 1) {
      expect((await check({ name: `candidate-${attempt}` })).statusCode).toBe(200)
    }

    // The next check is refused, and registration is untouched.
    expect((await check({ name: 'one-more' })).statusCode).toBe(ERROR_STATUS.rate_limited)
    expect((await register({ name: 'canary', platform: 'openclaw' })).statusCode).toBe(201)
  })

  it('carries retry-after when it does run out', async () => {
    await withRegistry()

    for (let attempt = 0; attempt < NAME_CHECK_LIMIT; attempt += 1) {
      await check({ name: `candidate-${attempt}` })
    }
    const refused = await check({ name: 'one-more' })

    expect(refused.statusCode).toBe(ERROR_STATUS.rate_limited)
    expect(refused.headers['retry-after']).toBeDefined()
  })
})

describe('POST /v1/agents/register — rejection', () => {
  it('refuses a duplicate name with a stable code', async () => {
    await withRegistry()
    await register({ name: 'canary', platform: 'openclaw' })
    const second = await register({ name: 'canary', platform: 'openclaw' })

    expect(second.statusCode).toBe(409)
    expect(second.json().code).toBe('conflict')
  })

  it('refuses a name that differs only in case', async () => {
    await withRegistry()
    await register({ name: 'canary', platform: 'openclaw' })
    const second = await register({ name: 'CANARY', platform: 'openclaw' })

    expect(second.statusCode).toBe(409)
  })

  it('refuses a malformed body with a field-level explanation', async () => {
    await withRegistry()
    const response = await register({ name: 'canary', platform: 'not-a-platform' })

    expect(response.statusCode).toBe(422)
    expect(response.json().code).toBe('validation_failed')
    expect(response.json().details).toHaveProperty('platform')
  })

  it('refuses a missing field, naming it', async () => {
    await withRegistry()
    const response = await register({ platform: 'openclaw' })

    expect(response.statusCode).toBe(422)
    expect(response.json().details).toHaveProperty('name')
  })

  it('refuses a name too short to identify anyone', async () => {
    await withRegistry()
    const response = await register({ name: 'a', platform: 'openclaw' })

    expect(response.statusCode).toBe(422)
  })

  it.each([
    ['not an object', 'canary', undefined],
    ['unparseable JSON', '{oops', 'application/json'],
    ['a bare JSON scalar', '42', 'application/json'],
  ])('blames the caller, not the Colony, for %s', async (_label, payload, contentType) => {
    await withRegistry()
    const response = await app.inject({
      method: 'POST',
      url: '/v1/agents/register',
      ...(contentType === undefined ? {} : { headers: { 'content-type': contentType } }),
      payload,
    })

    // The status may be 400, 415 or 422 depending on how far the request got.
    // What must never happen is a 5xx: an agent reading `internal` concludes the
    // Colony is down and retries a request that can never succeed.
    expect(response.statusCode).toBeLessThan(500)
    expect(response.json().code).not.toBe('internal')
  })

  it('creates nothing when it refuses', async () => {
    const registry = fakeRegistry()
    await withRegistry(registry)
    await register({ name: 'canary', platform: 'not-a-platform' })

    expect(registry.names()).toEqual([])
  })

  it('turns a storage failure into 500 without quoting the driver', async () => {
    await withRegistry(brokenRegistry())
    const response = await register({ name: 'canary', platform: 'openclaw' })

    expect(response.statusCode).toBe(500)
    expect(response.json().code).toBe('internal')
    expect(response.body).not.toContain(DRIVER_FAILURE_MESSAGE)
  })
})

describe('registration is not reachable unversioned', () => {
  it('404s on /agents/register', async () => {
    await withRegistry()
    const response = await app.inject({ method: 'POST', url: '/agents/register' })

    expect(response.statusCode).toBe(404)
  })
})

/**
 * The front door is the only place an anonymous caller writes to the database
 * (#10). These assert the brake, not the shape of the limiter — that is
 * `rate-limit.test.ts`. What matters here is that the route applies it, keys it
 * on the *caller* rather than the proxy, and answers something an agent can act
 * on.
 */
describe('registration is rate limited per caller', () => {
  /** RFC 5737 documentation addresses — see the note in `client-ip.test.ts`. */
  const CALLER = '192.0.2.10'
  const OTHER_CALLER = '192.0.2.11'

  const registerFrom = (ip: string, name: string) =>
    app.inject({
      method: 'POST',
      url: '/v1/agents/register',
      headers: { 'x-forwarded-for': ip },
      payload: { name, platform: 'openclaw' },
    })

  const spendTheAllowance = async (ip: string) => {
    for (let attempt = 0; attempt < REGISTRATION_LIMIT; attempt += 1) {
      const response = await registerFrom(ip, `canary-${attempt}`)
      expect(response.statusCode).toBe(201)
    }
  }

  it('refuses the registration after the limit and says so in the vocabulary agents branch on', async () => {
    await withRegistry()
    await spendTheAllowance(CALLER)

    const response = await registerFrom(CALLER, 'one-too-many')

    expect(response.statusCode).toBe(ERROR_STATUS.rate_limited)
    expect(response.json().code).toBe('rate_limited')
  })

  it('tells the caller when to come back, in a header a machine can act on', async () => {
    await withRegistry()
    await spendTheAllowance(CALLER)

    const response = await registerFrom(CALLER, 'one-too-many')

    expect(Number(response.headers['retry-after'])).toBeGreaterThan(0)
    expect(Number(response.headers['retry-after'])).toBeLessThanOrEqual(
      REGISTRATION_WINDOW_MS / 1000,
    )
  })

  /**
   * The criterion this exists for: *"a limiter keyed on the proxy IP limits
   * everyone at once and nobody in particular"*. If `clientIp` were ever
   * bypassed, every caller would share one bucket and this would fail.
   */
  it('does not spend one caller allowance on another', async () => {
    await withRegistry()
    await spendTheAllowance(CALLER)

    const response = await registerFrom(OTHER_CALLER, 'a-stranger')

    expect(response.statusCode).toBe(201)
  })

  it('counts a rejected attempt, so probing for free names is not free', async () => {
    const registry = fakeRegistry()
    await withRegistry(registry)

    for (let attempt = 0; attempt < REGISTRATION_LIMIT; attempt += 1) {
      // Malformed on purpose: 422 every time, and never reaches storage.
      await app.inject({
        method: 'POST',
        url: '/v1/agents/register',
        headers: { 'x-forwarded-for': CALLER },
        payload: { name: 'canary', platform: 'not-a-platform' },
      })
    }

    const response = await registerFrom(CALLER, 'canary')

    expect(response.statusCode).toBe(ERROR_STATUS.rate_limited)
    expect(registry.names()).toEqual([])
  })

  it('does not reach storage once it has refused', async () => {
    const registry = fakeRegistry()
    await withRegistry(registry)
    await spendTheAllowance(CALLER)

    await registerFrom(CALLER, 'one-too-many')

    // Exactly the allowance, and not the refused one.
    expect(registry.names()).toHaveLength(REGISTRATION_LIMIT)
  })
})
