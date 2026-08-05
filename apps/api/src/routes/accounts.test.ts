import { fakeHumans } from '../__fixtures__/humans.js'
import { fakeArtefactChallenges } from '../__fixtures__/artefact.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fakeDepositDependencies, fakeDeposits } from '../__fixtures__/deposits.js'
import { fakeQuests } from '../__fixtures__/quests.js'
import type { FastifyInstance } from 'fastify'
import type { InjectOptions, Response as InjectResponse } from 'light-my-request'
import {
  AccountKindSchema,
  SkillSchema,
  TaskTypeSchema,
  type AgentId,
  type Task,
} from '@kolonie-ai/core'
import { buildApp } from '../app.js'
import { fakeConsole } from '../__fixtures__/console.js'
import { fakeRegistry } from '../__fixtures__/registry.js'
import { fakeSolana } from '../__fixtures__/solana.js'
import { fakeKeys } from '../__fixtures__/keys.js'
import { fakeVision } from '../__fixtures__/vision.js'
import { fakePow } from '../__fixtures__/proof-of-work.js'
import { fakeMemory } from '../__fixtures__/memory.js'
import { fakeContributions, fakeGithub } from '../__fixtures__/github.js'
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
import { fakeStore, type FakeStore } from '../__fixtures__/store.js'
import { aTask, fakeCatalogue, type FakeCatalogue } from '../__fixtures__/catalogue.js'
import { fakeSubmissions } from '../__fixtures__/submissions.js'
import { fakeGuidance } from '../__fixtures__/guidance.js'
import { fakeSupportDesk } from '../__fixtures__/support.js'
import { fakeOperatorNotes } from '../__fixtures__/operator-notes.js'
import { fakeOperatorRequests } from '../__fixtures__/operator-requests.js'
import { fakePermissionReports } from '../__fixtures__/permission-reports.js'
import { fakeRotation } from '../__fixtures__/rotation.js'
import { fakeErasureDesk } from '../__fixtures__/erasure.js'
import { erasure } from '../erasure.js'
import { support } from '../support.js'
import { fakeAcademy } from '../__fixtures__/academy.js'
import { fakeVault } from '../__fixtures__/vault.js'
import { fakeEmail } from '../__fixtures__/email.js'
import {
  fakeAccountRegister,
  resolutionOver,
  type FakeAccountRegister,
} from '../__fixtures__/accounts.js'

let app: FastifyInstance
let store: FakeStore
let register: FakeAccountRegister
let catalogue: FakeCatalogue
let apiKey: string
let agentId: AgentId

beforeEach(async () => {
  store = fakeStore()
  register = fakeAccountRegister()
  catalogue = fakeCatalogue()
  app = buildApp({
    humans: fakeHumans(),
    vault: { vault: fakeVault() },
    accounts: { register, resolution: resolutionOver(register) },
    console: fakeConsole(),
    email: fakeEmail(),
    registry: fakeRegistry(),
    store,
    quests: fakeQuests(),
    deposits: fakeDepositDependencies(fakeDeposits()),
    catalogue,
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
    image: fakeImage(),
    scene: fakeScene(),
    injection: fakeInjection(),
    vetting: fakeVetting(),
    authenticator: fakeAuthenticator(),
  })
  await app.ready()

  const issued = store.issue()
  apiKey = String(issued.apiKey)
  agentId = issued.agent.id
})

afterEach(async () => {
  await app.close()
})

const authed = (options: InjectOptions): Promise<InjectResponse> =>
  app.inject({ ...options, headers: { authorization: `Bearer ${apiKey}` } })

const list = () => authed({ method: 'GET', url: '/v1/accounts' })

describe('GET /v1/accounts', () => {
  it('names what the citizen holds, proved and declared alike', async () => {
    register.proveDirectly(agentId, {
      kind: AccountKindSchema.parse('mailbox'),
      identifier: 'citizen@example.org',
      capabilities: ['receive'] as never,
    })
    await authed({
      method: 'POST',
      url: '/v1/accounts',
      payload: { kind: 'social', identifier: '@newcomer' },
    })

    const response = await list()

    expect(response.statusCode).toBe(200)
    expect(response.json().accounts).toEqual([
      expect.objectContaining({ identifier: 'citizen@example.org', proved: true }),
      expect.objectContaining({ identifier: '@newcomer', proved: false }),
    ])
    // So an agent need not guess a slug for the kinds the Colony proves.
    expect(response.json().knownKinds).toContain('mailbox')
  })

  it('filters by kind', async () => {
    register.proveDirectly(agentId, {
      kind: AccountKindSchema.parse('mailbox'),
      identifier: 'citizen@example.org',
    })
    register.proveDirectly(agentId, {
      kind: AccountKindSchema.parse('github'),
      identifier: 'octocat',
    })

    const response = await authed({ method: 'GET', url: '/v1/accounts?kind=github' })

    expect(response.json().accounts).toHaveLength(1)
  })

  it('refuses an anonymous caller', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/accounts' })).statusCode).toBe(401)
  })
})

describe('POST /v1/accounts', () => {
  it('records a declaration and marks it unproved', async () => {
    const response = await authed({
      method: 'POST',
      url: '/v1/accounts',
      payload: { kind: 'social', identifier: '@newcomer', note: 'cannot post for 48 hours' },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json().account).toMatchObject({
      proved: false,
      capabilities: [],
      note: 'cannot post for 48 hours',
    })
  })

  /**
   * The rejection case that matters most: a declaration is a note, not a claim,
   * and no route may turn it into evidence.
   */
  it('gives a caller no way to declare an account as proved', async () => {
    const response = await authed({
      method: 'POST',
      url: '/v1/accounts',
      payload: {
        kind: 'social',
        identifier: '@liar',
        proved: true,
        capabilities: ['publish'],
      },
    })

    expect(response.json().account).toMatchObject({ proved: false, capabilities: [] })
  })

  it('refuses an identifier another citizen has proved', async () => {
    register.claimForAnother('github', 'octocat')

    const response = await authed({
      method: 'POST',
      url: '/v1/accounts',
      payload: { kind: AccountKindSchema.parse('github'), identifier: 'octocat' },
    })

    expect(response.statusCode).toBe(409)
  })

  it('refuses a malformed kind', async () => {
    const response = await authed({
      method: 'POST',
      url: '/v1/accounts',
      payload: { kind: 'Not A Kind', identifier: 'x' },
    })

    expect(response.statusCode).toBe(422)
  })

  /**
   * `#289`. Declaring an account that exists is a no-op by design, and the
   * no-op used to swallow `vaultKey` without a word — a success carrying a row
   * that visibly contradicted the argument. The citizen that reported it
   * concluded the field could not be set after the fact, wrote that into its
   * vault and two notes, told its operator, and had to unpick all of it once it
   * found `kolonie.accounts.vault-key` one entry away in the same namespace.
   */
  it('says which arguments it ignored when the account was already on record', async () => {
    const declare = (payload: Record<string, unknown>) =>
      authed({ method: 'POST', url: '/v1/accounts', payload })

    const first = await declare({ kind: 'social', identifier: '@twice' })
    expect(first.json()).not.toHaveProperty('notice')

    const again = await declare({
      kind: 'social',
      identifier: '@twice',
      vaultKey: 'social/oauth',
      note: 'rotates on every call',
    })

    expect(again.statusCode).toBe(201)
    expect(again.json().account).toMatchObject({ vaultKey: null, note: null })
    expect(again.json().notice).toContain('kolonie.accounts.vault-key')
    expect(again.json().notice).toContain('kolonie.accounts.note')
  })

  /** The notice is about arguments that were ignored, so an argument that was not sent earns none. */
  it('adds no notice when the repeat declaration asked for nothing', async () => {
    const declare = () =>
      authed({
        method: 'POST',
        url: '/v1/accounts',
        payload: { kind: 'social', identifier: '@bare' },
      })

    await declare()

    expect((await declare()).json()).not.toHaveProperty('notice')
  })

  /**
   * `#289` again: the limit was stated and the length was not, so every
   * rejection was followed by a guess at how much to cut. The citizen trimmed
   * one note four times before it went through.
   */
  it('says how long the note actually was when it refuses one', async () => {
    const response = await authed({
      method: 'POST',
      url: '/v1/accounts',
      payload: { kind: 'social', identifier: '@verbose', note: 'x'.repeat(1600) },
    })

    expect(response.statusCode).toBe(422)
    expect(JSON.stringify(response.json())).toContain('1600')
  })
})

describe('the four writes on one account', () => {
  const anAccount = () =>
    register.proveDirectly(agentId, {
      kind: AccountKindSchema.parse('social'),
      identifier: '@current',
    })

  it('retires an account without removing it', async () => {
    const account = anAccount()

    const response = await authed({
      method: 'PUT',
      url: `/v1/accounts/${account.id}/status`,
      payload: { status: 'retired' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().account.status).toBe('retired')
    expect((await list()).json().accounts).toHaveLength(1)
  })

  it('clears a note with null rather than with an absent field', async () => {
    const account = anAccount()
    await authed({
      method: 'PUT',
      url: `/v1/accounts/${account.id}/note`,
      payload: { note: 'something' },
    })

    const cleared = await authed({
      method: 'PUT',
      url: `/v1/accounts/${account.id}/note`,
      payload: { note: null },
    })

    expect(cleared.json().account.note).toBeNull()
    // An absent field is a mistake rather than an instruction.
    const missing = await authed({
      method: 'PUT',
      url: `/v1/accounts/${account.id}/note`,
      payload: {},
    })
    expect(missing.statusCode).toBe(422)
  })

  it('links a vault entry that does not exist', async () => {
    const account = anAccount()

    const response = await authed({
      method: 'PUT',
      url: `/v1/accounts/${account.id}/vault-key`,
      payload: { vaultKey: 'social-2' },
    })

    expect(response.json().account.vaultKey).toBe('social-2')
  })

  describe('the provider, and the aggregate it feeds (#288)', () => {
    it('takes a provider at declaration and after the fact', async () => {
      const declared = await authed({
        method: 'POST',
        url: '/v1/accounts',
        payload: {
          kind: 'mailbox',
          identifier: 'agent@web-library.net',
          provider: 'MAIL.TM',
        },
      })

      // Lowercased on the way in, because the Colony must not decide that
      // `mail.tm` and `Mail.TM` are two providers — and must not decide that
      // `atomicmail.io` and `Atomic Mail` are one.
      expect(declared.json().account.provider).toBe('mail.tm')

      const account = anAccount()
      const named = await authed({
        method: 'PUT',
        url: `/v1/accounts/${account.id}/provider`,
        payload: { provider: 'njal.la' },
      })

      expect(named.json().account.provider).toBe('njal.la')
    })

    it('clears it with null and refuses an absent field', async () => {
      const account = anAccount()
      await authed({
        method: 'PUT',
        url: `/v1/accounts/${account.id}/provider`,
        payload: { provider: 'mail.tm' },
      })

      const cleared = await authed({
        method: 'PUT',
        url: `/v1/accounts/${account.id}/provider`,
        payload: { provider: null },
      })
      expect(cleared.json().account.provider).toBeNull()

      const missing = await authed({
        method: 'PUT',
        url: `/v1/accounts/${account.id}/provider`,
        payload: {},
      })
      expect(missing.statusCode).toBe(422)
    })

    it('refuses a sentence, and says what a provider is instead', async () => {
      const account = anAccount()

      const refused = await authed({
        method: 'PUT',
        url: `/v1/accounts/${account.id}/provider`,
        payload: { provider: 'the one my operator set up for me last year' },
      })

      expect(refused.statusCode).toBe(422)
      expect(refused.json().message).toContain('one token')
    })

    it('says which arguments a repeat declaration ignored, provider among them', async () => {
      await authed({
        method: 'POST',
        url: '/v1/accounts',
        payload: { kind: 'mailbox', identifier: 'agent@example.test' },
      })

      const again = await authed({
        method: 'POST',
        url: '/v1/accounts',
        payload: { kind: 'mailbox', identifier: 'agent@example.test', provider: 'mail.tm' },
      })

      // `#289`'s rule, extended to the new field: an argument that had no effect
      // has to be visible in the answer, not only in the row.
      expect(again.json().notice).toContain('kolonie.accounts.provider')
    })

    it('counts citizens per provider and names none of them', async () => {
      await authed({
        method: 'POST',
        url: '/v1/accounts',
        payload: { kind: 'mailbox', identifier: 'agent@atomic.test', provider: 'atomicmail.io' },
      })

      const providers = await authed({ method: 'GET', url: '/v1/accounts/providers' })

      expect(providers.json().providers).toEqual([
        { kind: 'mailbox', provider: 'atomicmail.io', citizens: 1, proved: 0 },
      ])
      // The condition the proposal set on publishing any of this.
      expect(providers.body).not.toContain('agent@atomic.test')
      expect(providers.body).not.toContain(agentId)
    })

    it('refuses an anonymous reader: this is published to citizens, not to the internet', async () => {
      const anonymous = await app.inject({ method: 'GET', url: '/v1/accounts/providers' })

      expect(anonymous.statusCode).toBe(401)
    })
  })

  it('sets a preference', async () => {
    const account = anAccount()

    const response = await authed({ method: 'POST', url: `/v1/accounts/${account.id}/prefer` })

    expect(response.json().account.preferred).toBe(true)
  })

  /**
   * Mail is the one kind where the same question has an obligation behind it,
   * and the refusal points at the surface that owns it rather than being a bare
   * error.
   */
  it('refuses a preference on a mailbox and names the promotion tool', async () => {
    const mailbox = register.proveDirectly(agentId, {
      kind: AccountKindSchema.parse('mailbox'),
      identifier: 'citizen@example.org',
    })

    const response = await authed({ method: 'POST', url: `/v1/accounts/${mailbox.id}/prefer` })

    expect(response.statusCode).toBe(409)
    expect(response.json().message).toContain('kolonie.mailboxes.promote')
  })

  it('never writes against another citizen’s account', async () => {
    const other = store.issue()
    const theirs = register.proveDirectly(other.agent.id, {
      kind: AccountKindSchema.parse('social'),
      identifier: '@theirs',
    })

    const response = await authed({
      method: 'PUT',
      url: `/v1/accounts/${theirs.id}/status`,
      payload: { status: 'lost' },
    })

    expect(response.statusCode).toBe(404)
  })
})

/**
 * A task may name the account kinds it needs, and the listing answers from the
 * citizen's register (`#151`).
 *
 * The property under all of these is that **it shows and never gates**. The task
 * is offered or withheld by the skill edge alone, and what this adds is the
 * answer to *which of my accounts should I use here* — a question a citizen
 * currently answers by failing.
 */
describe('a task that names an account kind', () => {
  const listing = () => authed({ method: 'GET', url: '/v1/tasks' })

  /** What the catalogue will answer this listing with. */
  const offering = (...items: Task[]) =>
    catalogue.answers({ outcome: 'listed', page: { items, nextCursor: null } })

  it('resolves the kind against what the citizen holds, preference first', async () => {
    offering(
      aTask({
        requiresAccounts: [AccountKindSchema.parse('social')],
        type: TaskTypeSchema.parse('social-post'),
      }),
    )
    register.proveDirectly(agentId, {
      kind: AccountKindSchema.parse('social'),
      identifier: '@second',
    })
    register.proveDirectly(agentId, {
      kind: AccountKindSchema.parse('social'),
      identifier: '@first',
      preferred: true,
    })

    const response = await listing()

    expect(response.json().accounts[0]).toMatchObject({
      kind: 'social',
      held: [
        { identifier: '@first', preferred: true, proved: true },
        { identifier: '@second', preferred: false, proved: true },
      ],
    })
  })

  it('marks an unproved account as unproved rather than hiding it', async () => {
    offering(aTask({ requiresAccounts: [AccountKindSchema.parse('social')] }))
    await authed({
      method: 'POST',
      url: '/v1/accounts',
      payload: { kind: 'social', identifier: '@declared' },
    })

    const response = await listing()

    expect(response.json().accounts[0].held).toEqual([
      // `reach` is false for every kind that is not mail, and the fixture has no
      // mailbox model, so it is false here for both reasons (`#299`).
      { identifier: '@declared', proved: false, preferred: false, reach: false },
    ])
  })

  it('omits a retired account', async () => {
    offering(aTask({ requiresAccounts: [AccountKindSchema.parse('social')] }))
    const retired = register.proveDirectly(agentId, {
      kind: AccountKindSchema.parse('social'),
      identifier: '@old',
    })
    await authed({
      method: 'PUT',
      url: `/v1/accounts/${retired.id}/status`,
      payload: { status: 'retired' },
    })

    expect((await listing()).json().accounts[0].held).toEqual([])
  })

  /**
   * Holding none is a pointer rather than a bare absence — otherwise an agent is
   * left to work out for itself where a mailbox comes from, which is the
   * discovery-by-failing this exists to end.
   */
  it('names the rung that produces one when the citizen holds none', async () => {
    offering(
      aTask({ requiresAccounts: [AccountKindSchema.parse('mailbox')] }),
      aTask({ type: TaskTypeSchema.parse('email-inbox'), grants: [SkillSchema.parse('mailbox')] }),
    )

    const response = await listing()

    expect(response.json().accounts[0]).toMatchObject({
      held: [],
      producedBy: 'email-inbox',
    })
  })

  /**
   * **The assertion this whole issue turns on.** A citizen holding no account of
   * a named kind is still offered the task, because the gate is the skill list
   * and adding a second axis would re-express a correct condition somewhere it
   * can disagree.
   */
  it('offers the task to a citizen holding no account of the kind', async () => {
    offering(
      aTask({
        requiresAccounts: [AccountKindSchema.parse('mailbox')],
        type: TaskTypeSchema.parse('github-account'),
      }),
    )

    const response = await listing()

    expect(response.json().items.map((task: { type: string }) => task.type)).toContain(
      'github-account',
    )
  })

  it('answers with an empty resolution when a citizen has declared nothing', async () => {
    offering(aTask({ requiresAccounts: [AccountKindSchema.parse('domain')] }))

    const response = await listing()

    expect(response.statusCode).toBe(200)
    expect(response.json().accounts[0]).toMatchObject({ kind: 'domain', held: [] })
  })
})
