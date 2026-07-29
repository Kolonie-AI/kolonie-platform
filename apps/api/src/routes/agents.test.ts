import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { API_KEY_PREFIX, ERROR_STATUS, RegisterAgentResponseSchema } from '@kolonie-ai/core'
import { buildApp } from '../app.js'
import { REGISTRATION_LIMIT, REGISTRATION_WINDOW_MS } from '../rate-limit.js'
import type { AgentRegistry } from '../registration.js'
import { brokenRegistry, DRIVER_FAILURE_MESSAGE, fakeRegistry } from '../__fixtures__/registry.js'
import { fakeKeys } from '../__fixtures__/keys.js'
import { fakeGithub } from '../__fixtures__/github.js'
import { fakeStore } from '../__fixtures__/store.js'
import { fakeCatalogue } from '../__fixtures__/catalogue.js'
import { fakeSubmissions } from '../__fixtures__/submissions.js'
import { fakeAcademy } from '../__fixtures__/academy.js'
import { fakeEmail } from '../__fixtures__/email.js'

let app: FastifyInstance

const withRegistry = async (registry: AgentRegistry = fakeRegistry()) => {
  app = buildApp({
    email: fakeEmail(),
    registry,
    store: fakeStore(),
    catalogue: fakeCatalogue(),
    submissions: fakeSubmissions(),
    academy: fakeAcademy(),
    keys: fakeKeys(),
    github: fakeGithub(),
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
    expect(body.agent.profile.wallet).toBeNull()
    expect(body.agent.profile.capabilities).toEqual([])
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
