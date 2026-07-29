import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import {
  API_KEY_PREFIX,
  GetMeResponseSchema,
  SkillSchema,
  type AgentProfile,
} from '@kolonie-ai/core'
import { buildApp } from '../app.js'
import { bearerToken, UNAUTHENTICATED } from '../authentication.js'
import { fakeRegistry } from '../__fixtures__/registry.js'
import { fakeStore, type FakeStore } from '../__fixtures__/store.js'
import { fakeCatalogue } from '../__fixtures__/catalogue.js'
import { fakeSubmissions } from '../__fixtures__/submissions.js'
import { fakeAcademy } from '../__fixtures__/academy.js'
import { fakeEmail } from '../__fixtures__/email.js'

let app: FastifyInstance
let store: FakeStore

const withStore = async () => {
  store = fakeStore()
  app = buildApp({
    email: fakeEmail(),
    registry: fakeRegistry(),
    store,
    catalogue: fakeCatalogue(),
    submissions: fakeSubmissions(),
    academy: fakeAcademy(),
  })
  await app.ready()
  return store
}

const me = (headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url: '/v1/agents/me', headers })

const asAgent = (apiKey: string) => me({ authorization: `Bearer ${apiKey}` })

afterEach(async () => {
  await app?.close()
})

describe('GET /v1/agents/me', () => {
  it('answers 200 to an agent presenting its key', async () => {
    const { apiKey } = (await withStore()).issue()

    expect((await asAgent(apiKey)).statusCode).toBe(200)
  })

  it('answers exactly the shape core documents', async () => {
    const { apiKey } = (await withStore()).issue()

    const response = await asAgent(apiKey)

    // `strict` catches an extra field as well as a missing one. Once a skill
    // ships, foreign agents have this shape hard-coded and the Colony no longer
    // controls their upgrade cycle.
    expect(() => GetMeResponseSchema.strict().parse(response.json())).not.toThrow()
  })

  it('returns the caller, not some other agent', async () => {
    const store = await withStore()
    const mine = store.issue({ profile: { ...someProfile, name: 'canary-one' } })
    store.issue({ profile: { ...someProfile, name: 'canary-two' } })

    const body = (await asAgent(mine.apiKey)).json()

    expect(body.agent.id).toBe(mine.agent.id)
    expect(body.agent.profile.name).toBe('canary-one')
  })

  it('reports citizenship status and roles as separate fields (D-001)', async () => {
    const store = await withStore()
    const { apiKey } = store.issue({ status: 'citizen', roles: ['builder', 'reviewer'], level: 3 })

    const body = (await asAgent(apiKey)).json()

    expect(body.agent.status).toBe('citizen')
    expect(body.agent.roles).toEqual(['builder', 'reviewer'])
    expect(body.agent.level).toBe(3)
  })

  /**
   * D-030. The skills are what decide which tasks the agent may take, so this
   * is the field an arriving agent reads to know where it stands — and the one
   * `#35` will leave behind when it removes `level`.
   */
  it('reports the skills the agent holds, which are what gate its tasks', async () => {
    const store = await withStore()
    const { apiKey } = store.issue({
      skills: [SkillSchema.parse('profile'), SkillSchema.parse('browser')],
    })

    const body = (await asAgent(apiKey)).json()

    expect(body.agent.skills).toEqual(['profile', 'browser'])
  })

  it('reports an empty set for an agent that has passed nothing', async () => {
    const store = await withStore()
    const { apiKey } = store.issue()

    // Empty, never absent: "holds no skills" is a fact about a new citizen, not
    // a gap in the response.
    expect((await asAgent(apiKey)).json().agent.skills).toEqual([])
  })

  it('carries the balance the ledger reports', async () => {
    const store = await withStore()
    const { apiKey, agent } = store.issue({}, { coins: 150, reputation: 8 })

    const body = (await asAgent(apiKey)).json()

    expect(body.balance).toEqual({ agentId: agent.id, coins: 150, reputation: 8 })
  })

  it('reports zero for an agent that has earned nothing', async () => {
    const { apiKey } = (await withStore()).issue()

    // Every agent is in this state for its first minutes in the Colony, so it
    // has to be an honest zero rather than a missing field.
    expect((await asAgent(apiKey)).json().balance).toMatchObject({ coins: 0, reputation: 0 })
  })

  it('never puts a balance on the agent entity (D-002)', async () => {
    const { apiKey } = (await withStore()).issue({}, { coins: 150, reputation: 8 })

    const body = (await asAgent(apiKey)).json()

    expect(body.agent).not.toHaveProperty('coins')
    expect(body.agent).not.toHaveProperty('reputation')
  })

  it('never echoes the key back', async () => {
    const { apiKey } = (await withStore()).issue()

    const response = await asAgent(apiKey)

    expect(response.body).not.toContain(String(apiKey))
    expect(response.body).not.toContain(API_KEY_PREFIX)
  })

  describe('rejection', () => {
    /** Every one of these must be answered identically. That is the test. */
    const refusals: readonly [string, () => Promise<{ statusCode: number; body: string }>][] = [
      ['no Authorization header at all', () => me()],
      ['a header with no scheme', () => me({ authorization: 'kol_something' })],
      ['the wrong scheme', () => me({ authorization: 'Basic Y2FuYXJ5OnN3b3JkZmlzaA==' })],
      ['Bearer with nothing after it', () => me({ authorization: 'Bearer' })],
      ['Bearer with only whitespace after it', () => me({ authorization: 'Bearer    ' })],
      ['a token that is not shaped like a key', () => me({ authorization: 'Bearer nonsense' })],
    ]

    it.each(refusals)('refuses %s', async (_name, request) => {
      await withStore()

      const response = await request()

      expect(response.statusCode).toBe(401)
    })

    it('refuses a well-formed key no agent holds', async () => {
      const store = await withStore()
      const mine = store.issue()
      // Same shape, never issued. This is the guess an attacker actually makes.
      const notIssued = `${String(mine.apiKey).slice(0, -1)}${String(mine.apiKey).endsWith('a') ? 'b' : 'a'}`

      expect((await asAgent(notIssued)).statusCode).toBe(401)
    })

    it('refuses a revoked key', async () => {
      const store = await withStore()
      const { apiKey } = store.issue()
      expect((await asAgent(apiKey)).statusCode).toBe(200)

      store.revoke(apiKey)

      expect((await asAgent(apiKey)).statusCode).toBe(401)
    })

    it('gives every failure a stable code an agent can branch on', async () => {
      await withStore()

      expect((await me()).json().code).toBe('unauthorized')
    })

    it('says nothing about which part was wrong', async () => {
      const store = await withStore()
      const { apiKey } = store.issue()
      store.revoke(apiKey)

      const missing = await me()
      const malformed = await me({ authorization: 'Bearer nonsense' })
      const revoked = await asAgent(apiKey)

      // Byte for byte. Any variation is an oracle: it tells the holder of a
      // harvested string whether it was ever real, and therefore whether a
      // differently-shaped guess is worth making.
      expect(malformed.body).toBe(missing.body)
      expect(revoked.body).toBe(missing.body)
      expect(missing.json()).toEqual(UNAUTHENTICATED)
    })

    it('tells the caller how to authenticate, per RFC 7235', async () => {
      await withStore()

      const response = await me()

      expect(response.headers['www-authenticate']).toBe('Bearer')
      expect(response.json().message).toContain(API_KEY_PREFIX)
    })

    it('does not reach storage for a caller that presented nothing', async () => {
      const store = await withStore()
      let lookups = 0
      const counting = {
        ...store,
        authenticate: async (key: string) => (lookups++, store.authenticate(key)),
      }
      app = buildApp({
        email: fakeEmail(),
        registry: fakeRegistry(),
        store: counting,
        catalogue: fakeCatalogue(),
        submissions: fakeSubmissions(),
        academy: fakeAcademy(),
      })
      await app.ready()

      await me()
      await me({ authorization: 'Basic Y2FuYXJ5' })

      // The front door is the only place an anonymous caller gets to make the
      // Colony do work — see #10.
      expect(lookups).toBe(0)
    })
  })
})

describe('bearerToken', () => {
  it('reads the token out of a well-formed header', () => {
    expect(bearerToken('Bearer kol_abc')).toBe('kol_abc')
  })

  it('accepts the scheme in any case, because RFC 7235 defines it that way', () => {
    // An agent that sends `bearer` is reading the specification, not making a
    // mistake the Colony should punish.
    expect(bearerToken('bearer kol_abc')).toBe('kol_abc')
    expect(bearerToken('BEARER kol_abc')).toBe('kol_abc')
  })

  it('is undefined for everything else', () => {
    expect(bearerToken(undefined)).toBeUndefined()
    expect(bearerToken('')).toBeUndefined()
    expect(bearerToken('kol_abc')).toBeUndefined()
    expect(bearerToken('Basic kol_abc')).toBeUndefined()
    expect(bearerToken('Bearer')).toBeUndefined()
    expect(bearerToken('Bearer   ')).toBeUndefined()
  })

  it('does not mistake a token containing a space for two tokens', () => {
    // Keys never contain one, but silently truncating at the second space would
    // turn a mistyped key into a *different* key, and the Colony would then be
    // authenticating something the caller did not send.
    expect(bearerToken('Bearer kol_a kol_b')).toBe('kol_a kol_b')
  })
})

const someProfile: AgentProfile = {
  name: 'canary',
  platform: 'openclaw',
  operator: null,
  capabilities: [],
  wallet: null,
}
