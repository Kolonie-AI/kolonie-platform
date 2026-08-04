import { afterEach, describe, expect, it } from 'vitest'
import { fakeDepositDependencies, fakeDeposits } from '../__fixtures__/deposits.js'
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
import { fakeKeys } from '../__fixtures__/keys.js'
import { fakeSolana, fakeWallet } from '../__fixtures__/solana.js'
import { fakeVision } from '../__fixtures__/vision.js'
import { fakePow } from '../__fixtures__/proof-of-work.js'
import { fakeMemory } from '../__fixtures__/memory.js'
import { fakeGithub, fakeContributions } from '../__fixtures__/github.js'
import { fakeStandingHints } from '../__fixtures__/hints.js'
import { fakeWakeup } from '../__fixtures__/wakeup.js'
import { fakeAutonomy } from '../__fixtures__/autonomy.js'
import { fakeOperatorClaim } from '../__fixtures__/operator-claim.js'
import { fakeSocial } from '../__fixtures__/social.js'
import { fakeDomain } from '../__fixtures__/domain.js'
import { fakeWebsite } from '../__fixtures__/website.js'
import { fakeImage } from '../__fixtures__/image.js'
import { fakeScene } from '../__fixtures__/scene.js'
import { fakeInjection } from '../__fixtures__/injection.js'
import { fakeStore, type FakeStore } from '../__fixtures__/store.js'
import { fakeCatalogue } from '../__fixtures__/catalogue.js'
import { fakeQuests } from '../__fixtures__/quests.js'
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
let store: FakeStore

const withStore = async () => {
  store = fakeStore()
  app = buildApp({
    quests: fakeQuests(),
    deposits: fakeDepositDependencies(fakeDeposits()),
    vault: { vault: fakeVault() },
    accounts: fakeAccounts(),
    console: fakeConsole(),
    email: fakeEmail(),
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
    memory: fakeMemory(),
    vision: fakeVision(),
    github: fakeGithub(),
    contributions: fakeContributions(),
    wakeup: fakeWakeup(),
    hints: fakeStandingHints(),
    social: fakeSocial(),
    operatorClaim: fakeOperatorClaim(),
    autonomy: fakeAutonomy(),
    domain: fakeDomain(),
    website: fakeWebsite(),
    image: fakeImage(),
    scene: fakeScene(),
    injection: fakeInjection(),
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

  /**
   * **Standing hints are an MCP feature and the HTTP surface gains nothing**
   * (`#231`). The caller here is often a script, and a field that begins
   * appearing in every response is either parsed as data or breaks a parser —
   * whereas MCP is where an audience that can read a sentence actually sits.
   *
   * The strict parse above already refuses an extra field; this says which
   * extra field, and why it is the one worth naming.
   */
  it('gains no hint, because hints are attached to tool results and not to this', async () => {
    const { apiKey } = (await withStore()).issue()

    const body = (await asAgent(apiKey)).json()

    expect(body.hint).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain('hint')
  })

  it('returns the caller, not some other agent', async () => {
    const store = await withStore()
    const mine = store.issue({ profile: { ...someProfile, name: 'canary-one' } })
    store.issue({ profile: { ...someProfile, name: 'canary-two' } })

    const body = (await asAgent(mine.apiKey)).json()

    expect(body.agent.id).toBe(mine.agent.id)
    expect(body.agent.profile.name).toBe('canary-one')
  })

  /**
   * The session declaration over HTTP (#158, `#192`), which arrives as query
   * parameters because a GET has no body.
   *
   * **The whole contract is that a malformed one is dropped rather than
   * refused.** This route's job is to tell a citizen where it stands, and every
   * field here is optional corroboration the Colony works identically without —
   * so a mistyped tool list must cost the caller its tool list and nothing else.
   */
  describe('the session declaration in the query string', () => {
    const declaring = async (query: string) => {
      const store = await withStore()
      const { apiKey } = store.issue()

      const response = await app.inject({
        method: 'GET',
        url: `/v1/agents/me?${query}`,
        headers: { authorization: `Bearer ${apiKey}` },
      })

      expect(response.statusCode).toBe(200)
      return store.namedSessions()[0]?.declaration
    }

    it('takes a repeated parameter as several tools', async () => {
      expect(await declaring('sessionId=run-1&runtimeTools=bash&runtimeTools=read')).toEqual({
        sessionId: 'run-1',
        runtimeTools: ['bash', 'read'],
      })
    })

    it('takes a comma-separated parameter as several tools', async () => {
      // The other honest spelling. A caller that picked it has not made a
      // mistake worth punishing with a dropped field.
      expect(await declaring('sessionId=run-1&runtimeTools=bash,read')).toEqual({
        sessionId: 'run-1',
        runtimeTools: ['bash', 'read'],
      })
    })

    /**
     * `?runtimeTools=` is a caller sending a parameter it had no value for, not
     * a citizen saying its run used no tools. The empty list is a real answer
     * and stays reachable over MCP, where a client sends an actual array and
     * means it — inferring it here would put words in the citizen's mouth on the
     * surface least able to be precise.
     */
    it('reads an empty parameter as nothing said, not as an empty list', async () => {
      expect(await declaring('sessionId=run-1&runtimeTools=')).toEqual({ sessionId: 'run-1' })
    })

    it('drops an unconvertible value rather than failing the call', async () => {
      // The citizen still learns where it stands; it just does not get to have
      // said what it could not spell.
      expect(await declaring('sessionId=run-1&tokens=twelve')).toEqual({ sessionId: 'run-1' })
    })
  })

  /**
   * The observation the HTTP door makes (`#191`). What is asserted here is the
   * wiring — that the door observes at all, and that what it hands on is a
   * digest — because deduplication and counting are the storage layer's rules
   * and are tested against a real database.
   */
  describe('the origin the Colony observed', () => {
    it('observes an authenticated call, with a digest and never an address', async () => {
      const store = await withStore()
      const { apiKey, agent } = store.issue()

      await app.inject({
        method: 'GET',
        url: '/v1/agents/me',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'cf-connecting-ip': '203.0.113.7',
          'cf-ipcountry': 'DE',
          'cf-ray': '7d4f2a1b9c8e0000-FRA',
        },
      })

      const [observed] = store.observedOrigins()
      expect(observed?.agentId).toBe(agent.id)
      expect(observed?.origin.country).toBe('DE')
      expect(observed?.origin.colo).toBe('FRA')
      expect(observed?.origin.fingerprint).toHaveLength(64)
      expect(JSON.stringify(observed?.origin)).not.toContain('203.0.113.7')
    })

    /**
     * A caller that could not authenticate has no citizen to attribute an
     * observation to, and inventing one would make the table a log of strangers
     * rather than a record about citizens.
     */
    it('observes nothing for a call that did not authenticate', async () => {
      const store = await withStore()

      await me({ authorization: 'Bearer kol_nobody', 'cf-connecting-ip': '203.0.113.7' })

      expect(store.observedOrigins()).toEqual([])
    })
  })

  it('reports citizenship status and roles as separate fields (D-001)', async () => {
    const store = await withStore()
    const { apiKey } = store.issue({ status: 'citizen', roles: ['builder', 'reviewer'] })

    const body = (await asAgent(apiKey)).json()

    expect(body.agent.status).toBe('citizen')
    expect(body.agent.roles).toEqual(['builder', 'reviewer'])
  })

  /**
   * D-030. The skills are what decide which tasks the agent may take, so this
   * is the field an arriving agent reads to know where it stands — and since
   * `#35` removed `level`, the only one.
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
    const { apiKey, agent } = store.issue({}, { credits: 150, reputation: 8 })

    const body = (await asAgent(apiKey)).json()

    expect(body.balance).toEqual({ agentId: agent.id, credits: 150, reputation: 8 })
  })

  it('reports zero for an agent that has earned nothing', async () => {
    const { apiKey } = (await withStore()).issue()

    // Every agent is in this state for its first minutes in the Colony, so it
    // has to be an honest zero rather than a missing field.
    expect((await asAgent(apiKey)).json().balance).toMatchObject({ credits: 0, reputation: 0 })
  })

  it('never puts a balance on the agent entity (D-002)', async () => {
    const { apiKey } = (await withStore()).issue({}, { credits: 150, reputation: 8 })

    const body = (await asAgent(apiKey)).json()

    expect(body.agent).not.toHaveProperty('credits')
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
        quests: fakeQuests(),
        deposits: fakeDepositDependencies(fakeDeposits()),
        vault: { vault: fakeVault() },
        accounts: fakeAccounts(),
        console: fakeConsole(),
        email: fakeEmail(),
        registry: fakeRegistry(),
        store: counting,
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
        memory: fakeMemory(),
        vision: fakeVision(),
        github: fakeGithub(),
        contributions: fakeContributions(),
        wakeup: fakeWakeup(),
        hints: fakeStandingHints(),
        social: fakeSocial(),
        operatorClaim: fakeOperatorClaim(),
        autonomy: fakeAutonomy(),
        domain: fakeDomain(),
        website: fakeWebsite(),
        image: fakeImage(),
        scene: fakeScene(),
        injection: fakeInjection(),
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
  pronouns: null,
  model: null,
  runtimeVersion: null,
  os: null,
  skillVersion: null,
  bio: null,
  capabilities: [],
  avatarUrl: null,
  declaredRhythmHours: null,
}

describe('the verified wallet address (#101)', () => {
  it('is null for a citizen that has not proved one', async () => {
    const { apiKey } = (await withStore()).issue()

    expect((await asAgent(apiKey)).json().verifiedSolanaAddress).toBeNull()
  })

  it('is the address for a citizen that has', async () => {
    const store = await withStore()
    const { apiKey, agent } = store.issue()
    const signer = fakeWallet()
    store.proveWallet(agent.id, signer.address)

    expect((await asAgent(apiKey)).json().verifiedSolanaAddress).toBe(signer.address)
  })

  /**
   * **There is exactly one address, and it is the proved one.** The profile used
   * to carry a second, self-declared field a citizen could type anything into;
   * it was retired with `#102` precisely so that no reader has to work out which
   * of two same-looking strings means anything.
   *
   * Asserted rather than assumed, because a future change that reintroduces a
   * profile field would also reintroduce the ambiguity.
   */
  it('is the only address in the response — the profile carries none', async () => {
    const store = await withStore()
    const { apiKey, agent } = store.issue()
    const proved = fakeWallet()
    store.proveWallet(agent.id, proved.address)

    const body = (await asAgent(apiKey)).json()

    expect(Object.keys(body.agent.profile)).not.toContain('wallet')
    expect(body.verifiedSolanaAddress).toBe(proved.address)
  })

  /**
   * The access rule, asserted rather than left to the shape. A citizen sees its
   * own address by asking about itself with its own key; there is no `Agent` in
   * any response that carries one, so no other route can serve it by accident.
   */
  it('is absent from the agent record itself, which is what other routes serve', async () => {
    const store = await withStore()
    const { apiKey, agent } = store.issue()
    store.proveWallet(agent.id, fakeWallet().address)

    const body = (await asAgent(apiKey)).json()

    expect(body.agent).not.toHaveProperty('verifiedSolanaAddress')
    expect(Object.keys(body.agent.profile)).not.toContain('verifiedSolanaAddress')
  })
})
