import { fakeHumans } from '../__fixtures__/humans.js'
import { fakeArtefactChallenges } from '../__fixtures__/artefact.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import {
  ERROR_STATUS,
  VAULT_MAX_ENTRIES,
  type AgentId,
  type VaultShareNotifyStatus,
} from '@kolonie-ai/core'
import { buildApp } from '../app.js'
import { fakeRegistry } from '../__fixtures__/registry.js'
import { fakeStore, type FakeStore } from '../__fixtures__/store.js'
import { fakeCatalogue } from '../__fixtures__/catalogue.js'
import { fakeQuests } from '../__fixtures__/quests.js'
import { fakeSubmissions } from '../__fixtures__/submissions.js'
import { fakeGuidance } from '../__fixtures__/guidance.js'
import { fakeSupportDesk } from '../__fixtures__/support.js'
import { fakeOperatorPageMessages } from '../__fixtures__/operator-page-message.js'
import { fakeOperatorThreads } from '../__fixtures__/operator-threads.js'
import { fakePermissionReports } from '../__fixtures__/permission-reports.js'
import { fakeRotation } from '../__fixtures__/rotation.js'
import { support } from '../support.js'
import { fakeAcademy } from '../__fixtures__/academy.js'
import { fakeEmail } from '../__fixtures__/email.js'
import { fakeSms } from '../__fixtures__/sms.js'
import { fakeKeyChallenges } from '../__fixtures__/keys.js'
import { fakeGithub, fakeContributions } from '../__fixtures__/github.js'
import { fakeContributionQuality } from '../__fixtures__/contribution-quality.js'
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
import { fakeVision } from '../__fixtures__/vision.js'
import { fakePow } from '../__fixtures__/proof-of-work.js'
import { fakeMemory } from '../__fixtures__/memory.js'
import { fakeSolana } from '../__fixtures__/solana.js'
import { fakeAccounts } from '../__fixtures__/accounts.js'
import { fakeAccountOffers } from '../__fixtures__/account-offers.js'
import { fakeConsole, recordingLog, type RecordingLog } from '../__fixtures__/console.js'
import { fakeVault, type FakeVault } from '../__fixtures__/vault.js'
import { VAULT_FULL, VAULT_SEALED_WITH_ANOTHER_KEY, VAULT_SHARED, VAULT_SPENT } from '../vault.js'
import { fakeErasureDesk } from '../__fixtures__/erasure.js'
import { erasure } from '../erasure.js'
import { noObstruction } from '../__fixtures__/obstruction.js'
import { arrivalReports } from '../arrival-reports.js'
import { fakeArrivalDesk } from '../__fixtures__/arrivals.js'
import type { VaultShareNotification } from '../vault-share-notifier.js'

let app: FastifyInstance
let store: FakeStore
let vault: FakeVault
let apiKey: string
let agentId: AgentId
let notifications: VaultShareNotification[]
let notifyStatus: VaultShareNotifyStatus
let notifyFailure: Error | null
let log: RecordingLog

beforeEach(async () => {
  store = fakeStore()
  vault = fakeVault()
  notifications = []
  notifyStatus = 'delivered'
  notifyFailure = null
  log = recordingLog()
  app = buildApp({
    arrivals: arrivalReports({ desk: fakeArrivalDesk() }),
    humans: fakeHumans(),
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
    operatorThreads: fakeOperatorThreads(),
    operatorPageMessages: fakeOperatorPageMessages(),
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
    contributionQuality: fakeContributionQuality(),
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
    academy: fakeAcademy(),
    vault: {
      vault,
      notifier: {
        notify: async (notification) => {
          notifications.push(notification)
          if (notifyFailure !== null) throw notifyFailure
          return notifyStatus
        },
      },
      log,
    },
    accounts: fakeAccounts(),
    accountOffers: { offers: fakeAccountOffers() },
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

  /**
   * `#1685`: a PEM private-key block is refused at the shared write boundary,
   * so REST and MCP cannot drift. The other findings this detector names are
   * what a vault is for.
   */
  it('refuses a PEM private-key block and stores nothing', async () => {
    const pem =
      '-----BEGIN RSA PRIVATE KEY-----\nMIIE-SENTINEL-DO-NOT-ECHO\n-----END RSA PRIVATE KEY-----'

    const refused = await put('ssh-host', { value: pem })

    expect(refused.statusCode).toBe(ERROR_STATUS.key_material_refused)
    expect(refused.json()).toMatchObject({ code: 'key_material_refused' })
    expect(refused.json().message).toContain('PEM private-key block')
    expect(refused.body).not.toContain('MIIE-SENTINEL-DO-NOT-ECHO')
    expect((await get('ssh-host')).statusCode).toBe(ERROR_STATUS.not_found)
  })

  it.each([
    ['labelled-secret', 'password: hunter2-mailbox'],
    ['otpauth-uri', 'otpauth://totp/Example:user?secret=JBSWY3DPEHPK3PXP'],
    ['vendor-prefixed-key', 'ghp_abcdefghijklmnopqrstuvwxyz01'],
    ['high-entropy-run', 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6'],
  ] as const)('accepts a %s on a write', async (_reason, value) => {
    const stored = await put('credential-example', { value })

    expect(stored.statusCode).toBe(201)
    expect((await get('credential-example')).json().value).toBe(value)
  })

  it('404s for a name that was never stored', async () => {
    const read = await get('never-written')

    expect(read.statusCode).toBe(ERROR_STATUS.not_found)
    expect(read.json()).toMatchObject({ code: 'not_found' })
  })
})

/**
 * **A vault key may contain `/` and the route it travels in is one segment.**
 *
 * `VaultKeySchema` permits `/`, and the two recommended shapes both use it —
 * `<service>/<identifier>` and `totp/<service>`. So the recommended key is
 * exactly the key that has to be percent-encoded to reach `PUT /vault/:key`,
 * and nothing said so anywhere a caller reads: `kolonie-docs#425` is a citizen
 * that found the working shape by probing, collecting opaque 404s for the path
 * shapes it tried first, while holding real credentials it then risked cleaning
 * up wrongly.
 *
 * These pin the behaviour the documentation now promises. `%2F` decoding back
 * into the key is Fastify's, not ours, which is precisely why it wants a test
 * here rather than a sentence somewhere: an upgrade that changed it would
 * otherwise break every recommended key shape silently.
 */
describe('a key containing a slash, which is the recommended shape', () => {
  it('round-trips when the slashes are percent-encoded', async () => {
    const key = 'phone/agentphone.example/assay'
    const encoded = encodeURIComponent(key)

    const stored = await put(encoded, { value: 'hunter2' })

    expect(stored.statusCode).toBe(201)
    // Decoded back to the key the citizen named, rather than stored under the
    // escaped spelling — the difference an agent would meet later as a listing
    // it cannot match against what it wrote.
    expect(stored.json()).toMatchObject({ created: true, entry: { key } })
    expect((await get(encoded)).json()).toMatchObject({ value: 'hunter2', entry: { key } })
    expect((await list()).json().entries[0]).toMatchObject({ key })
    expect((await remove(encoded)).json()).toEqual({ key, deleted: true })
  })

  it('is the same entry however the caller spelled the request', async () => {
    // One entry, not two: an agent that encoded on the write and not on the
    // read must not find its own secret missing.
    await put(encodeURIComponent('totp/github'), { value: 'JBSWY3DP' })

    expect((await list()).json().entries).toHaveLength(1)
    expect((await get('totp%2Fgithub')).json()).toMatchObject({ value: 'JBSWY3DP' })
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

describe('an entry whose account was given away', () => {
  it('is refused rather than opened, and says which of the two conflicts this is', async () => {
    await put(encodeURIComponent('provider/handle'), { value: 'hunter2' })
    vault.spend(agentId, 'provider/handle')

    const read = await get('provider%2Fhandle')

    expect(read.statusCode).toBe(ERROR_STATUS.conflict)
    expect(read.json()).toMatchObject({ code: 'conflict', details: { reason: VAULT_SPENT } })
    // The bytes are still there and are not handed back — which is the whole of
    // `#1214`, and the one thing a message about them must not undo.
    expect(read.body).not.toContain('hunter2')
  })

  it('is still listed, because nothing deleted it', async () => {
    await put(encodeURIComponent('provider/handle'), {
      value: 'hunter2',
      description: 'the mailbox I gave away',
    })
    vault.spend(agentId, 'provider/handle')

    const listed = await list()

    expect(listed.json().entries).toMatchObject([{ key: 'provider/handle' }])
    expect(listed.body).not.toContain('hunter2')
  })

  it('is still the citizen’s to delete', async () => {
    await put(encodeURIComponent('provider/handle'), { value: 'hunter2' })
    vault.spend(agentId, 'provider/handle')

    expect((await remove('provider%2Fhandle')).statusCode).toBe(200)
    expect((await get('provider%2Fhandle')).statusCode).toBe(ERROR_STATUS.not_found)
  })

  it('opens again once the citizen writes something new under the name', async () => {
    await put(encodeURIComponent('provider/handle'), { value: 'hunter2' })
    vault.spend(agentId, 'provider/handle')

    // The name was never the point: a citizen that re-uses it for another
    // account is holding a live credential again, and must be able to read it.
    await put(encodeURIComponent('provider/handle'), { value: 'a-second-value' })

    expect((await get('provider%2Fhandle')).json()).toMatchObject({ value: 'a-second-value' })
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

/**
 * Sharing one entry with the citizen's operator (`#1439`, epic `#1437`).
 *
 * What `apps/api` is on the hook for here is the shape of the exchange, not the
 * sealing: that the value never appears in the request, that the refusals reach
 * the caller as the right status codes, and that the share is visible on every
 * read of the vault afterwards. Whether the copy is really sealed under the
 * Colony's key is `packages/db`'s to prove, and `vault-shares.test.ts` does.
 */
describe('sharing an entry with an operator', () => {
  const share = (key: string, body: unknown, credential = apiKey) =>
    app.inject({
      method: 'POST',
      url: `/v1/vault/${key}/share`,
      headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    })

  const unshare = (key: string, credential = apiKey) =>
    app.inject({
      method: 'POST',
      url: `/v1/vault/${key}/unshare`,
      headers: { authorization: `Bearer ${credential}` },
    })

  it('takes the key and never the value', async () => {
    await put('github', { value: 'hunter2' })

    const shared = await share('github', { purpose: 'put a card on it' })

    expect(shared.statusCode).toBe(201)
    // Not in the request, and not in the answer either: the Colony read the
    // entry itself, which is the whole reason the secret is not in this hop.
    expect(shared.body).not.toContain('hunter2')
    expect(shared.json()).toMatchObject({
      extended: false,
      notifyStatus: 'delivered',
      entry: { key: 'github', share: { purpose: 'put a card on it' } },
    })
    expect(notifications).toEqual([{ agentId, agentName: 'canary', purpose: 'put a card on it' }])
    expect(JSON.stringify(notifications)).not.toContain('hunter2')
  })

  it('refuses a body carrying a value at all', async () => {
    await put('github', { value: 'hunter2' })

    // `.strict()` on the request schema: a citizen that thought it had to send
    // the secret is told it does not, rather than having it silently ignored.
    const refused = await share('github', { purpose: 'a card', value: 'hunter2' })

    expect(refused.statusCode).toBe(422)
  })

  it('shows the share on every read of the vault', async () => {
    await put('github', { value: 'hunter2' })
    await put('mailbox', { value: 'hunter3' })
    await share('github', { purpose: 'put a card on it' })

    const read = await get('github')
    expect(read.json().entry.share).toMatchObject({ purpose: 'put a card on it' })

    const listed = await list()
    const entries = listed.json().entries as { key: string; share: unknown }[]

    expect(entries.find((entry) => entry.key === 'github')?.share).not.toBeNull()
    expect(entries.find((entry) => entry.key === 'mailbox')?.share).toBeNull()
    // Still no values in a listing, share or no share.
    expect(listed.body).not.toContain('hunter2')
    // The explicit share is the one notification event. Reading its state later
    // does not turn into a reminder.
    expect(notifications).toHaveLength(1)
  })

  it('extends rather than opening a second share, and says which it did', async () => {
    await put('github', { value: 'hunter2' })

    const first = await share('github', { purpose: 'a card', days: 3 })
    const again = await share('github', { purpose: 'a card and the billing address' })

    expect(first.statusCode).toBe(201)
    expect(again.statusCode).toBe(200)
    expect(again.json()).toMatchObject({
      extended: true,
      entry: { share: { purpose: 'a card and the billing address' } },
    })
    // Two explicit shares say two things; later reads say none.
    expect(notifications).toHaveLength(2)
  })

  it('creates the share and reports when no notification address is bound', async () => {
    await put('github', { value: 'hunter2' })
    notifyStatus = 'no-address'

    const shared = await share('github', { purpose: 'put a card on it' })

    expect(shared.statusCode).toBe(201)
    expect(shared.json()).toMatchObject({ notifyStatus: 'no-address', entry: { share: {} } })
  })

  it('keeps the share live when notification itself fails', async () => {
    await put('github', { value: 'hunter2' })
    notifyFailure = new Error('notification failed')

    const shared = await share('github', { purpose: 'put a card on it' })

    expect(shared.statusCode).toBe(201)
    expect(shared.json()).toMatchObject({ notifyStatus: 'undeliverable', entry: { share: {} } })
    expect((await get('github')).json().entry.share).not.toBeNull()
    expect(log.lines()).toEqual([
      expect.objectContaining({
        fields: expect.objectContaining({ event: 'vault.share.notify.failed' }),
      }),
    ])
  })

  it('refuses a window longer than the maximum', async () => {
    await put('github', { value: 'hunter2' })

    expect((await share('github', { purpose: 'a card', days: 31 })).statusCode).toBe(422)
  })

  it('refuses a write while the entry is shared, and names the way on', async () => {
    await put('github', { value: 'hunter2' })
    await share('github', { purpose: 'put a card on it' })

    const refused = await put('github', { value: 'hunter4' })

    expect(refused.statusCode).toBe(ERROR_STATUS.conflict)
    expect(refused.json().details.reason).toBe(VAULT_SHARED)
    expect(refused.json().message).toContain('kolonie.vault.unshare')

    // And the entry is what it was: a refusal that had already written would be
    // the conflict this refusal exists to remove.
    expect((await get('github')).json().value).toBe('hunter2')
  })

  it('hands the operator’s addition back once, and lets the write through again', async () => {
    await put('github', { value: 'hunter2' })
    await share('github', { purpose: 'put a card on it' })
    vault.operatorWrites(agentId, 'github', 'billing PIN 4417')

    // A read must not carry it: the listing says only *they wrote something*.
    expect((await get('github')).body).not.toContain('4417')
    expect((await list()).json().entries[0].share.operatorWrote).toBe(true)

    const taken = await unshare('github')

    expect(taken.statusCode).toBe(200)
    expect(taken.json()).toMatchObject({
      key: 'github',
      operatorAddition: 'billing PIN 4417',
      entry: { share: null },
    })

    expect((await unshare('github')).statusCode).toBe(404)
    expect((await put('github', { value: 'hunter4' })).statusCode).toBe(200)
  })

  it('notices a PEM the operator wrote back and still hands the addition over', async () => {
    const pem =
      '-----BEGIN RSA PRIVATE KEY-----\nMIIE-SENTINEL-DO-NOT-ECHO\n-----END RSA PRIVATE KEY-----'
    await put('github', { value: 'hunter2' })
    await share('github', { purpose: 'put a card on it' })
    vault.operatorWrites(agentId, 'github', pem)

    const taken = await unshare('github')

    expect(taken.statusCode).toBe(200)
    expect(taken.json()).toMatchObject({
      operatorAddition: pem,
      noticed: { reason: 'private-key-block', matched: 'private-key-block' },
    })
    expect(taken.json()).not.toHaveProperty('noticedKeyMaterial')
  })

  it('omits noticed when the operator wrote nothing that is a private key', async () => {
    await put('github', { value: 'hunter2' })
    await share('github', { purpose: 'put a card on it' })
    vault.operatorWrites(agentId, 'github', 'billing PIN 4417')

    const taken = await unshare('github')

    expect(taken.statusCode).toBe(200)
    expect(taken.json()).not.toHaveProperty('noticed')
  })

  it('refuses a citizen with nobody linked, and names kolonie.operator.link', async () => {
    await put('github', { value: 'hunter2' })
    vault.setOperator(false)

    const refused = await share('github', { purpose: 'put a card on it' })

    // `#918`'s lesson, one channel along: *nobody has looked yet* and *nobody
    // could ever look* are the same silence from here, and only one is fixable.
    expect(refused.statusCode).toBe(422)
    expect(refused.json().message).toContain('kolonie.operator.link')
  })

  it('refuses an entry that is not there, and one whose account moved', async () => {
    expect((await share('never-written', { purpose: 'x' })).statusCode).toBe(404)

    await put('github', { value: 'hunter2' })
    vault.spend(agentId, 'github')

    const spent = await share('github', { purpose: 'put a card on it' })

    expect(spent.statusCode).toBe(ERROR_STATUS.conflict)
    expect(spent.json().details.reason).toBe(VAULT_SPENT)
  })
})
