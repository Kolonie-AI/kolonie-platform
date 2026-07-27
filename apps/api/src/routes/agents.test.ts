import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { API_KEY_PREFIX, RegisterAgentResponseSchema } from '@kolonie-ai/core'
import { buildApp } from '../app.js'
import type { AgentRegistry } from '../registration.js'
import { brokenRegistry, DRIVER_FAILURE_MESSAGE, fakeRegistry } from '../__fixtures__/registry.js'

let app: FastifyInstance

const withRegistry = async (registry: AgentRegistry = fakeRegistry()) => {
  app = buildApp({ registry })
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

  it('starts every agent as a candidate at level 0', async () => {
    await withRegistry()
    const body = (await register({ name: 'canary', platform: 'openclaw' })).json()

    expect(body.agent.status).toBe('candidate')
    expect(body.agent.roles).toEqual([])
    expect(body.agent.level).toBe(0)
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
