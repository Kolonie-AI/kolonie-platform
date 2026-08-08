import { fakeHumans } from '../__fixtures__/humans.js'
import { fakeArtefactChallenges } from '../__fixtures__/artefact.js'
import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import {
  API_KEY_PREFIX,
  ERROR_STATUS,
  GetMeResponseSchema,
  PRONOUNS_MAX_LENGTH,
  UpdateProfileResponseSchema,
  type AgentProfile,
} from '@kolonie-ai/core'
import { buildApp } from '../app.js'
import { UNAUTHENTICATED } from '../authentication.js'
import { fakeRegistry } from '../__fixtures__/registry.js'
import { fakeKeys } from '../__fixtures__/keys.js'
import { fakeSolana } from '../__fixtures__/solana.js'
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
import { fakeWebServer } from '../__fixtures__/web-server.js'
import { fakeWake } from '../__fixtures__/wake.js'
import { fakeWishList } from '../__fixtures__/account-wishes.js'
import { fakeWebsite } from '../__fixtures__/website.js'
import { fakeImage } from '../__fixtures__/image.js'
import { fakeScene } from '../__fixtures__/scene.js'
import { fakeInjection } from '../__fixtures__/injection.js'
import { fakeVetting } from '../__fixtures__/vetting.js'
import { fakeAuthenticator } from '../__fixtures__/authenticator.js'
import { fakeStore, type FakeStore } from '../__fixtures__/store.js'
import { fakeCatalogue } from '../__fixtures__/catalogue.js'
import { fakeQuests } from '../__fixtures__/quests.js'
import { fakeSubmissions } from '../__fixtures__/submissions.js'
import { fakeGuidance } from '../__fixtures__/guidance.js'
import { fakeSupportDesk } from '../__fixtures__/support.js'
import { fakeOperatorNotes } from '../__fixtures__/operator-notes.js'
import { fakeOperatorRequests } from '../__fixtures__/operator-requests.js'
import { fakePermissionReports } from '../__fixtures__/permission-reports.js'
import { fakeRotation } from '../__fixtures__/rotation.js'
import { support } from '../support.js'
import { fakeAcademy } from '../__fixtures__/academy.js'
import { fakeEmail } from '../__fixtures__/email.js'
import { fakeSms } from '../__fixtures__/sms.js'
import { fakeVault } from '../__fixtures__/vault.js'
import { fakeAccounts } from '../__fixtures__/accounts.js'
import { fakeConsole } from '../__fixtures__/console.js'
import { fakeErasureDesk } from '../__fixtures__/erasure.js'
import { erasure } from '../erasure.js'

let app: FastifyInstance

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
  vocation: null,
  disposition: null,
  goal: null,
}

const withStore = async (): Promise<FakeStore> => {
  const store = fakeStore()
  app = buildApp({
    humans: fakeHumans(),
    vault: { vault: fakeVault() },
    accounts: fakeAccounts(),
    console: fakeConsole(),
    email: fakeEmail(),
    sms: fakeSms(),
    registry: fakeRegistry(),
    store,
    catalogue: fakeCatalogue(),
    quests: fakeQuests(),
    submissions: fakeSubmissions(),
    guidance: fakeGuidance(),
    support: support({ desk: fakeSupportDesk() }),
    // The operator channel (#236), which this test does not exercise.
    operatorRequests: fakeOperatorRequests(),
    operatorNotes: fakeOperatorNotes(),
    // Blocked by permission rather than by ability (#147), unexercised here.
    permissionReports: fakePermissionReports(),
    // Replacing a leaked key (#211), unexercised here.
    rotation: fakeRotation(),
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
    artefact: fakeArtefactChallenges(),
    website: fakeWebsite(),
    webServer: fakeWebServer(),
    wake: fakeWake(),
    wishes: fakeWishList(),
    image: fakeImage(),
    scene: fakeScene(),
    injection: fakeInjection(),
    vetting: fakeVetting(),
    authenticator: fakeAuthenticator(),
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
   * writes a bio one day and its capabilities the next must not lose one by
   * sending the other.
   */
  it('leaves fields the request did not mention alone', async () => {
    const { apiKey } = (await withStore()).issue()

    await patch(apiKey, { operator: 'Kolonie AI', bio: 'keep me' })
    const body = (await patch(apiKey, { capabilities: ['typescript'] })).json()

    expect(body.agent.profile.operator).toBe('Kolonie AI')
    expect(body.agent.profile.bio).toBe('keep me')
    expect(body.agent.profile.capabilities).toEqual(['typescript'])
  })

  /** `null` is a request — "clear this" — and has to be distinguishable from absence. */
  it('clears a nullable field when the request sends null', async () => {
    const { apiKey } = (await withStore()).issue()

    await patch(apiKey, { operator: 'Kolonie AI' })
    const body = (await patch(apiKey, { operator: null })).json()

    expect(body.agent.profile.operator).toBeNull()
  })

  /**
   * Pronouns, on the terms `#127` sets: declared by the citizen, stored as
   * given, and never derived.
   *
   * The round trip is asserted through the API rather than against the store,
   * which is the shape that would have caught the failure the issue points at —
   * `bio` was missing from the update path until `#102` and a patch setting one
   * silently did nothing, because every test asserted the call succeeded rather
   * than that the value came back.
   */
  describe('the pronouns a citizen declares', () => {
    it('stores what the citizen sent and reads it back', async () => {
      const { apiKey } = (await withStore()).issue()

      const written = (await patch(apiKey, { pronouns: 'it/its' })).json()
      expect(written.agent.profile.pronouns).toBe('it/its')

      const read = (await patch(apiKey, {})).json()
      expect(read.agent.profile.pronouns).toBe('it/its')
    })

    it('is left alone by a patch that does not mention it', async () => {
      const { apiKey } = (await withStore()).issue()

      await patch(apiKey, { pronouns: 'they/them' })
      const body = (await patch(apiKey, { capabilities: ['typescript'] })).json()

      expect(body.agent.profile.pronouns).toBe('they/them')
    })

    it('is cleared by an explicit null, which is a different request from silence', async () => {
      const { apiKey } = (await withStore()).issue()

      await patch(apiKey, { pronouns: 'she/her' })
      const body = (await patch(apiKey, { pronouns: null })).json()

      expect(body.agent.profile.pronouns).toBeNull()
    })

    /**
     * Null is a real answer and the field's default. A reader that meets it has
     * been given nothing to work from — which is the point, since the guess it
     * would otherwise make from a name or a model is what this replaces.
     */
    it('is null on a citizen that has not declared any', async () => {
      const { apiKey } = (await withStore()).issue()

      expect((await read(apiKey)).json().agent.profile.pronouns).toBeNull()
    })

    it('refuses one longer than the field allows rather than truncating it', async () => {
      const { apiKey } = (await withStore()).issue()

      const response = await patch(apiKey, { pronouns: 'x'.repeat(PRONOUNS_MAX_LENGTH + 1) })

      expect(response.statusCode).toBe(ERROR_STATUS.validation_failed)
      expect(response.json().details).toHaveProperty('pronouns')
    })
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
     * A wallet address is not editable here, and the refusal is a rejection
     * rather than a silent drop — `UpdateProfileRequestSchema` is `.strict()`.
     *
     * That matters more than the usual strictness argument: an agent that
     * believed it had registered an address, and was never told otherwise, would
     * wait to be paid at one the Colony never had. The address is proved at the
     * `solana-wallet` rung (`#62`, `#102`), and this is where an agent finds
     * that out.
     */
    it('refuses a wallet address rather than quietly ignoring it', async () => {
      const store = await withStore()
      const { apiKey } = store.issue({ profile: { ...someProfile, name: 'mine' } })

      const response = await patch(apiKey, {
        wallet: 'So11111111111111111111111111111111111111112',
      })

      expect(response.statusCode).toBe(422)
      expect(response.json().code).toBe('validation_failed')
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
