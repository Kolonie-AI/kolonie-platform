import { fakeHumans } from '../__fixtures__/humans.js'
import { fakeArtefactChallenges } from '../__fixtures__/artefact.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fakeDepositDependencies, fakeDeposits } from '../__fixtures__/deposits.js'
import type { FastifyInstance } from 'fastify'
import { ERROR_STATUS, VAULT_MAX_ENTRIES, type AgentId } from '@kolonie-ai/core'
import { buildApp } from '../app.js'
import { fakeRegistry } from '../__fixtures__/registry.js'
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
import { fakeKeyChallenges } from '../__fixtures__/keys.js'
import { fakeGithub, fakeContributions } from '../__fixtures__/github.js'
import { fakeStandingHints } from '../__fixtures__/hints.js'
import { fakeWakeup } from '../__fixtures__/wakeup.js'
import { fakeAutonomy } from '../__fixtures__/autonomy.js'
import { fakeOperatorClaim } from '../__fixtures__/operator-claim.js'
import { fakeSocial } from '../__fixtures__/social.js'
import { fakeDomain } from '../__fixtures__/domain.js'
import { fakeWebServer } from '../__fixtures__/web-server.js'
import { fakeWebsite } from '../__fixtures__/website.js'
import { fakeImage } from '../__fixtures__/image.js'
import { fakeScene } from '../__fixtures__/scene.js'
import { fakeInjection } from '../__fixtures__/injection.js'
import { fakeVetting } from '../__fixtures__/vetting.js'
import { fakeAuthenticator } from '../__fixtures__/authenticator.js'
import { fakeVision } from '../__fixtures__/vision.js'
import { fakePow } from '../__fixtures__/proof-of-work.js'
import { fakeMemory } from '../__fixtures__/memory.js'
import { fakeSolana } from '../__fixtures__/solana.js'
import { fakeAccounts } from '../__fixtures__/accounts.js'
import { fakeConsole } from '../__fixtures__/console.js'
import { fakeVault, type FakeVault } from '../__fixtures__/vault.js'
import { VAULT_FULL, VAULT_SEALED_WITH_ANOTHER_KEY } from '../vault.js'
import { fakeErasureDesk } from '../__fixtures__/erasure.js'
import { erasure } from '../erasure.js'
import { noObstruction } from '../__fixtures__/obstruction.js'

let app: FastifyInstance
let store: FakeStore
let vault: FakeVault
let apiKey: string
let agentId: AgentId

beforeEach(async () => {
  store = fakeStore()
  vault = fakeVault()
  app = buildApp({
    humans: fakeHumans(),
    email: fakeEmail(),
    sms: fakeSms(),
    registry: fakeRegistry(),
    store,
    catalogue: fakeCatalogue(),
    quests: fakeQuests(),
    deposits: fakeDepositDependencies(fakeDeposits()),
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
    keys: { challenges: fakeKeyChallenges(), obstruction: noObstruction },
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
    image: fakeImage(),
    scene: fakeScene(),
    injection: fakeInjection(),
    vetting: fakeVetting(),
    authenticator: fakeAuthenticator(),
    academy: fakeAcademy(),
    vault: { vault },
    accounts: fakeAccounts(),
    console: fakeConsole(),
  })
  await app.ready()

  const issued = store.issue({})
  apiKey = String(issued.apiKey)
  agentId = issued.agent.id
})

afterEach(async () => {
  await app.close()
})

const put = (key: string, body: unknown, credential = apiKey) =>
  app.inject({
    method: 'PUT',
    url: `/v1/vault/${key}`,
    headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  })

const get = (key: string, credential = apiKey) =>
  app.inject({
    method: 'GET',
    url: `/v1/vault/${key}`,
    headers: { authorization: `Bearer ${credential}` },
  })

const list = (credential = apiKey) =>
  app.inject({
    method: 'GET',
    url: '/v1/vault',
    headers: { authorization: `Bearer ${credential}` },
  })

const remove = (key: string, credential = apiKey) =>
  app.inject({
    method: 'DELETE',
    url: `/v1/vault/${key}`,
    headers: { authorization: `Bearer ${credential}` },
  })

describe('storing and fetching', () => {
  it('gives back what was stored', async () => {
    const stored = await put('email', { value: 'hunter2' })

    expect(stored.statusCode).toBe(201)
    expect(stored.json()).toMatchObject({ created: true, entry: { key: 'email' } })

    const read = await get('email')

    expect(read.statusCode).toBe(200)
    expect(read.json()).toMatchObject({ value: 'hunter2', entry: { key: 'email' } })
  })

  it('never echoes the value back on a write', async () => {
    // The caller just supplied it. Sending it back doubles the number of places
    // a secret can end up in a log for nothing.
    const stored = await put('email', { value: 'hunter2' })

    expect(stored.body).not.toContain('hunter2')
  })

  it('answers 201 for a new name and 200 for a replacement', async () => {
    expect((await put('email', { value: 'one' })).statusCode).toBe(201)

    const replaced = await put('email', { value: 'two' })

    expect(replaced.statusCode).toBe(200)
    expect(replaced.json()).toMatchObject({ created: false })
    expect((await get('email')).json()).toMatchObject({ value: 'two' })
  })

  it('404s for a name that was never stored', async () => {
    const read = await get('never-written')

    expect(read.statusCode).toBe(ERROR_STATUS.not_found)
    expect(read.json()).toMatchObject({ code: 'not_found' })
  })
})

describe('the key that sealed it', () => {
  it('shows a citizen nothing of another’s, under the same name', async () => {
    await put('email', { value: 'hunter2' })

    const stranger = store.issue({})
    const read = await get('email', String(stranger.apiKey))

    // Not `conflict`: the row genuinely is not theirs, and the two answers must
    // not be confusable — one means "write it again", the other must not.
    expect(read.statusCode).toBe(ERROR_STATUS.not_found)
  })

  it('says so, distinguishably, when the citizen’s own entry will not open', async () => {
    // Sealed under this agent with a token it no longer presents — the state an
    // agent lands in if it is ever issued a second key. The fake keeps the
    // sealing token beside the value, exactly as the cipher binds it.
    await vault.set('a-key-from-another-life', agentId, 'legacy', 'old-secret')

    const read = await get('legacy')

    expect(read.statusCode).toBe(ERROR_STATUS.conflict)
    expect(read.json()).toMatchObject({
      code: 'conflict',
      details: { reason: VAULT_SEALED_WITH_ANOTHER_KEY },
    })
  })

  it('lets an entry nobody can open still be deleted', async () => {
    await vault.set('a-key-from-another-life', agentId, 'legacy', 'old-secret')

    expect((await get('legacy')).statusCode).toBe(ERROR_STATUS.conflict)
    expect((await remove('legacy')).statusCode).toBe(200)
    expect((await get('legacy')).statusCode).toBe(ERROR_STATUS.not_found)
  })
})

describe('listing', () => {
  it('names what is stored and shows no values', async () => {
    await put('email', { value: 'hunter2' })
    await put('github', { value: 'ghp_secret' })

    const listed = await list()

    expect(listed.statusCode).toBe(200)
    expect(listed.json()).toMatchObject({ maxEntries: VAULT_MAX_ENTRIES })
    expect(listed.json().entries.map((entry: { key: string }) => entry.key)).toEqual([
      'email',
      'github',
    ])
    expect(listed.body).not.toContain('hunter2')
    expect(listed.body).not.toContain('ghp_secret')
  })

  it('is empty for a citizen who has stored nothing', async () => {
    expect((await list()).json()).toEqual({ entries: [], maxEntries: VAULT_MAX_ENTRIES })
  })

  it('shows one citizen nothing of another’s', async () => {
    await put('email', { value: 'hunter2' })

    const stranger = store.issue({})
    const listed = await list(String(stranger.apiKey))

    expect(listed.json()).toEqual({ entries: [], maxEntries: VAULT_MAX_ENTRIES })
  })
})

describe('deleting', () => {
  it('removes an entry and says so', async () => {
    await put('email', { value: 'hunter2' })

    const deleted = await remove('email')

    expect(deleted.statusCode).toBe(200)
    expect(deleted.json()).toEqual({ key: 'email', deleted: true })
    expect((await get('email')).statusCode).toBe(ERROR_STATUS.not_found)
  })

  it('404s when there was nothing to delete', async () => {
    // Not a cheerful 200: an agent that misremembered the name needs to know the
    // secret it meant to destroy is still sitting there under another one.
    expect((await remove('never-written')).statusCode).toBe(ERROR_STATUS.not_found)
  })
})

describe('what the vault refuses', () => {
  it('rejects a key that is not a usable name', async () => {
    const stored = await put('has%20spaces%20and%20percent', { value: 'x' })

    expect(stored.statusCode).toBe(ERROR_STATUS.validation_failed)
    expect(stored.json()).toMatchObject({
      code: 'validation_failed',
      details: { key: expect.any(String) },
    })
  })

  it('rejects a value over the size limit', async () => {
    const stored = await put('big', { value: 'x'.repeat(8 * 1024 + 1) })

    expect(stored.statusCode).toBe(ERROR_STATUS.validation_failed)
    expect(stored.json()).toMatchObject({ details: { value: expect.any(String) } })
  })

  it('rejects an empty value rather than storing an empty secret', async () => {
    expect((await put('empty', { value: '' })).statusCode).toBe(ERROR_STATUS.validation_failed)
  })

  it('rejects an unrecognised field rather than ignoring it', async () => {
    const stored = await put('email', { value: 'hunter2', ttlSeconds: 60 })

    expect(stored.statusCode).toBe(ERROR_STATUS.validation_failed)
  })

  it('refuses a new entry once the vault is full, and says why in a way an agent can branch on', async () => {
    vault.fill(agentId)

    const stored = await put('one-too-many', { value: 'x' })

    expect(stored.statusCode).toBe(ERROR_STATUS.conflict)
    expect(stored.json()).toMatchObject({
      code: 'conflict',
      details: { reason: VAULT_FULL, maxEntries: String(VAULT_MAX_ENTRIES) },
    })
  })

  it('still lets a full vault replace an entry it already holds', async () => {
    vault.fill(agentId)

    const replaced = await put('filler-0', { value: 'rotated' })

    expect(replaced.statusCode).toBe(200)
  })
})

describe('the credential', () => {
  it('refuses every vault route to a caller presenting nothing', async () => {
    for (const call of [
      app.inject({ method: 'GET', url: '/v1/vault' }),
      app.inject({ method: 'GET', url: '/v1/vault/email' }),
      app.inject({ method: 'DELETE', url: '/v1/vault/email' }),
      app.inject({
        method: 'PUT',
        url: '/v1/vault/email',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ value: 'x' }),
      }),
    ]) {
      const response = await call
      expect(response.statusCode).toBe(ERROR_STATUS.unauthorized)
      expect(response.headers['www-authenticate']).toBe('Bearer')
    }
  })

  it('refuses a revoked key', async () => {
    await put('email', { value: 'hunter2' })
    store.revoke(store.issue({}).apiKey)

    const revoked = store.issue({})
    store.revoke(revoked.apiKey)

    expect((await list(String(revoked.apiKey))).statusCode).toBe(ERROR_STATUS.unauthorized)
  })
})

/**
 * What an entry says it is (`#154`).
 *
 * The route's job is the shape rather than the sealing: that a description
 * reaches the store, comes back in the listing, and can be written and cleared
 * without the value being re-sent.
 */
describe('the description on a vault entry', () => {
  const describeEntry = (key: string, body: unknown, credential = apiKey) =>
    app.inject({
      method: 'PUT',
      url: `/v1/vault/${key}/description`,
      headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    })

  it('is written with the value and returned by the listing', async () => {
    await put('email', { value: 'hunter2', description: 'the mailbox at mail.example' })

    const listed = await list()

    expect(listed.json().entries[0]).toMatchObject({
      key: 'email',
      description: 'the mailbox at mail.example',
    })
    // Still never a value, which is the property the listing has always had.
    expect(JSON.stringify(listed.json())).not.toContain('hunter2')
  })

  it('is written alone, without the secret being sent again', async () => {
    await put('email', { value: 'hunter2' })

    const described = await describeEntry('email', { description: 'the mailbox at mail.example' })

    expect(described.statusCode).toBe(200)
    expect(described.json().entry.description).toBe('the mailbox at mail.example')
    expect((await get('email')).json().value).toBe('hunter2')
  })

  it('is cleared with null and refuses an absent field', async () => {
    await put('email', { value: 'hunter2', description: 'something' })

    const cleared = await describeEntry('email', { description: null })
    const missing = await describeEntry('email', {})

    expect(cleared.json().entry.description).toBeNull()
    expect(missing.statusCode).toBe(422)
  })

  it('refuses an over-length description', async () => {
    const response = await put('email', { value: 'hunter2', description: 'x'.repeat(513) })

    expect(response.statusCode).toBe(422)
  })

  it('answers 404 for an entry that does not exist', async () => {
    expect((await describeEntry('never-written', { description: 'x' })).statusCode).toBe(404)
  })
})
