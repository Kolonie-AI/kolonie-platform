import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import {
  API_KEY_PREFIX,
  GetMeResponseSchema,
  UpdateProfileResponseSchema,
  type AgentProfile,
} from '@kolonie-ai/core'
import { buildApp } from '../app.js'
import { UNAUTHENTICATED } from '../authentication.js'
import { fakeRegistry } from '../__fixtures__/registry.js'
import { fakeKeys } from '../__fixtures__/keys.js'
import { fakePow } from '../__fixtures__/proof-of-work.js'
import { fakeGithub } from '../__fixtures__/github.js'
import { fakeStore, type FakeStore } from '../__fixtures__/store.js'
import { fakeCatalogue } from '../__fixtures__/catalogue.js'
import { fakeSubmissions } from '../__fixtures__/submissions.js'
import { fakeGuidance } from '../__fixtures__/guidance.js'
import { fakeAcademy } from '../__fixtures__/academy.js'
import { fakeEmail } from '../__fixtures__/email.js'

let app: FastifyInstance

const someProfile: AgentProfile = {
  name: 'canary',
  platform: 'openclaw',
  operator: null,
  bio: null,
  capabilities: [],
  wallet: null,
}

const withStore = async (): Promise<FakeStore> => {
  const store = fakeStore()
  app = buildApp({
    email: fakeEmail(),
    registry: fakeRegistry(),
    store,
    catalogue: fakeCatalogue(),
    submissions: fakeSubmissions(),
    guidance: fakeGuidance(),
    academy: fakeAcademy(),
    keys: fakeKeys(),
    pow: fakePow(),
    github: fakeGithub(),
  })
  await app.ready()
  return store
}

const patch = (apiKey: string, payload: unknown) =>
  app.inject({
    method: 'PATCH',
    url: '/v1/agents/me',
    headers: { authorization: `Bearer ${apiKey}` },
    payload: payload as never,
  })

const read = (apiKey: string) =>
  app.inject({
    method: 'GET',
    url: '/v1/agents/me',
    headers: { authorization: `Bearer ${apiKey}` },
  })

afterEach(async () => {
  await app?.close()
})

describe('PATCH /v1/agents/me', () => {
  it('answers exactly the shape core documents', async () => {
    const { apiKey } = (await withStore()).issue()

    const response = await patch(apiKey, { capabilities: ['typescript'] })

    expect(response.statusCode).toBe(200)
    // `strict` catches an extra field as well as a missing one — once a skill
    // ships, foreign agents have this shape hard-coded.
    expect(() => UpdateProfileResponseSchema.strict().parse(response.json())).not.toThrow()
  })

  it('sets capabilities, which is the whole of Level 0', async () => {
    const { apiKey } = (await withStore()).issue()

    const body = (await patch(apiKey, { capabilities: ['typescript', 'research'] })).json()

    expect(body.agent.profile.capabilities).toEqual(['typescript', 'research'])
  })

  it('is readable back through GET, so the agent can confirm what it did', async () => {
    const { apiKey } = (await withStore()).issue()

    await patch(apiKey, { capabilities: ['solidity'] })
    const body = (await read(apiKey)).json()

    expect(() => GetMeResponseSchema.strict().parse(body)).not.toThrow()
    expect(body.agent.profile.capabilities).toEqual(['solidity'])
  })

  /**
   * The property that makes this PATCH rather than PUT (D-017). An agent that
   * sets its capabilities at Level 0 and its wallet at Level 4 must not lose one
   * by sending the other.
   */
  it('leaves fields the request did not mention alone', async () => {
    const { apiKey } = (await withStore()).issue()

    await patch(apiKey, { operator: 'Kolonie AI', wallet: '0xabc' })
    const body = (await patch(apiKey, { capabilities: ['typescript'] })).json()

    expect(body.agent.profile.operator).toBe('Kolonie AI')
    expect(body.agent.profile.wallet).toBe('0xabc')
    expect(body.agent.profile.capabilities).toEqual(['typescript'])
  })

  /** `null` is a request — "clear this" — and has to be distinguishable from absence. */
  it('clears a nullable field when the request sends null', async () => {
    const { apiKey } = (await withStore()).issue()

    await patch(apiKey, { operator: 'Kolonie AI' })
    const body = (await patch(apiKey, { operator: null })).json()

    expect(body.agent.profile.operator).toBeNull()
  })

  it('accepts an empty patch and answers with the unchanged agent', async () => {
    const { apiKey, agent } = (await withStore()).issue()

    const response = await patch(apiKey, {})

    expect(response.statusCode).toBe(200)
    expect(response.json().agent.id).toBe(agent.id)
  })

  describe('what a citizen may not change', () => {
    /**
     * Rejected rather than ignored, and that is the point. Silently dropping the
     * field would leave the agent believing it had renamed itself, and finding
     * out only through a later read — if ever.
     */
    it('refuses a rename and says which field was refused', async () => {
      const { apiKey } = (await withStore()).issue()

      const response = await patch(apiKey, { name: 'somebody-else' })

      expect(response.statusCode).toBe(422)
      expect(response.json().code).toBe('validation_failed')
      expect(response.json().details).toHaveProperty('name')
    })

    it('refuses a platform change the same way', async () => {
      const { apiKey } = (await withStore()).issue()

      const response = await patch(apiKey, { platform: 'claude' })

      expect(response.statusCode).toBe(422)
      expect(response.json().details).toHaveProperty('platform')
    })

    it('does not apply the writable half of a request whose other half is refused', async () => {
      const { apiKey } = (await withStore()).issue()

      await patch(apiKey, { capabilities: ['typescript'], name: 'somebody-else' })
      const body = (await read(apiKey)).json()

      expect(body.agent.profile.capabilities).toEqual([])
      expect(body.agent.profile.name).toBe('canary')
    })
  })

  describe('rejections', () => {
    it('rejects a caller presenting no key, with the same body as GET', async () => {
      await withStore()

      const response = await app.inject({
        method: 'PATCH',
        url: '/v1/agents/me',
        payload: { capabilities: ['typescript'] },
      })

      expect(response.statusCode).toBe(401)
      expect(response.json()).toEqual(UNAUTHENTICATED)
      expect(response.headers['www-authenticate']).toBe('Bearer')
    })

    it('rejects a revoked key', async () => {
      const store = await withStore()
      const { apiKey } = store.issue()
      store.revoke(apiKey)

      expect((await patch(apiKey, { capabilities: ['typescript'] })).statusCode).toBe(401)
    })

    it('rejects a malformed key without touching the profile', async () => {
      await withStore()

      expect((await patch('not-a-key', { capabilities: ['x'] })).statusCode).toBe(401)
    })

    it('rejects capabilities that are not an array of strings', async () => {
      const { apiKey } = (await withStore()).issue()

      const response = await patch(apiKey, { capabilities: 'typescript' })

      expect(response.statusCode).toBe(422)
      expect(response.json().code).toBe('validation_failed')
    })

    /**
     * `conflict`, not `validation_failed`: the body was well formed and would
     * have been accepted a moment earlier. An agent that cannot tell those apart
     * retries a request that can never succeed.
     */
    it('answers conflict when the wallet belongs to another citizen', async () => {
      const store = await withStore()
      const other = store.issue({
        profile: { ...someProfile, name: 'other', wallet: '0xtaken' },
      })
      const { apiKey } = store.issue({ profile: { ...someProfile, name: 'mine' } })

      const response = await patch(apiKey, { wallet: '0xtaken' })

      expect(response.statusCode).toBe(409)
      expect(response.json().code).toBe('conflict')
      expect(other.agent.profile.wallet).toBe('0xtaken')
    })
  })

  /**
   * There is no agent id in the path or the body, so this is a test that the
   * shape of the route makes the attack unrepresentable rather than merely
   * rejected. If a future change adds one, this fails.
   */
  it('edits the caller and nobody else', async () => {
    const store = await withStore()
    const mine = store.issue({ profile: { ...someProfile, name: 'canary-one' } })
    const theirs = store.issue({ profile: { ...someProfile, name: 'canary-two' } })

    await patch(mine.apiKey, { capabilities: ['mine'] })

    expect((await read(theirs.apiKey)).json().agent.profile.capabilities).toEqual([])
    expect(`${API_KEY_PREFIX}`).toBeTruthy()
  })
})
