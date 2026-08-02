import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { QUEST_TASK_TYPE, type TaskId } from '@kolonie-ai/core'
import { buildApp } from '../app.js'
import { fakeRegistry } from '../__fixtures__/registry.js'
import { fakeStore, type FakeStore } from '../__fixtures__/store.js'
import { fakeCatalogue } from '../__fixtures__/catalogue.js'
import { fakeQuests, type FakeQuestDesk } from '../__fixtures__/quests.js'
import { fakeSubmissions } from '../__fixtures__/submissions.js'
import { fakeGuidance } from '../__fixtures__/guidance.js'
import { fakeSupportDesk } from '../__fixtures__/support.js'
import { support } from '../support.js'
import { fakeAcademy } from '../__fixtures__/academy.js'
import { fakeEmail } from '../__fixtures__/email.js'
import { fakeKeyChallenges } from '../__fixtures__/keys.js'
import { fakeGithub, fakeContributions } from '../__fixtures__/github.js'
import { fakeWakeup } from '../__fixtures__/wakeup.js'
import { fakeSocial } from '../__fixtures__/social.js'
import { fakeDomain } from '../__fixtures__/domain.js'
import { fakeWebsite } from '../__fixtures__/website.js'
import { fakeImage } from '../__fixtures__/image.js'
import { fakeScene } from '../__fixtures__/scene.js'
import { fakeInjection } from '../__fixtures__/injection.js'
import { fakeVision } from '../__fixtures__/vision.js'
import { fakePow } from '../__fixtures__/proof-of-work.js'
import { fakeSolana } from '../__fixtures__/solana.js'
import { fakeVault } from '../__fixtures__/vault.js'
import { fakeAccounts } from '../__fixtures__/accounts.js'
import { fakeConsole } from '../__fixtures__/console.js'
import { fakeErasureDesk } from '../__fixtures__/erasure.js'
import { erasure } from '../erasure.js'
import { noObstruction } from '../__fixtures__/obstruction.js'

let app: FastifyInstance
let store: FakeStore
let quests: FakeQuestDesk
let sponsorKey: string
let sponsorId: string
let stewardKey: string
let stewardId: string

beforeEach(async () => {
  store = fakeStore()
  quests = fakeQuests()
  app = buildApp({
    vault: { vault: fakeVault() },
    accounts: fakeAccounts(),
    console: fakeConsole(),
    email: fakeEmail(),
    registry: fakeRegistry(),
    store,
    catalogue: fakeCatalogue(),
    quests,
    submissions: fakeSubmissions(),
    guidance: fakeGuidance(),
    support: support({ desk: fakeSupportDesk() }),
    erasure: erasure({ desk: fakeErasureDesk() }),
    retesting: { reset: async () => ({ outcome: 'not-a-tester' as const }) },
    keys: { challenges: fakeKeyChallenges(), obstruction: noObstruction },
    solana: fakeSolana(),
    pow: fakePow(),
    vision: fakeVision(),
    github: fakeGithub(),
    contributions: fakeContributions(),
    wakeup: fakeWakeup(),
    social: fakeSocial(),
    domain: fakeDomain(),
    website: fakeWebsite(),
    image: fakeImage(),
    scene: fakeScene(),
    injection: fakeInjection(),
    academy: fakeAcademy(),
  })
  await app.ready()

  const sponsor = store.issue({})
  sponsorKey = String(sponsor.apiKey)
  sponsorId = String(sponsor.agent.id)

  const steward = store.issue({ roles: ['steward'] })
  stewardKey = String(steward.apiKey)
  stewardId = String(steward.agent.id)
})

afterEach(async () => {
  await app.close()
})

const aDraft = (overrides: Record<string, unknown> = {}) => ({
  title: 'A thousand registrations',
  description: 'We hand out mailbox addresses and want to know whether agents can take one.',
  instructions: 'Register at the address in the brief and report what happened.',
  reward: { credits: 0, reputation: 5 },
  slots: 10,
  expiresAt: new Date(Date.now() + 7 * 24 * 3_600_000).toISOString(),
  ...overrides,
})

const write = (body: unknown, key = sponsorKey) =>
  app.inject({
    method: 'POST',
    url: '/v1/quests',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    payload: body as never,
  })

const post = (url: string, key: string, body?: unknown) =>
  app.inject({
    method: 'POST',
    url,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { payload: body as never }),
  })

const get = (url: string, key: string) =>
  app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${key}` } })

/** A quest written, submitted and cleared by the moderator — the steward's starting point. */
const awaitingReview = async (draft = aDraft()) => {
  const written = await write(draft)
  const id = written.json().quest.id as TaskId
  // Funded first: a quest whose sponsor cannot pay never reaches the queue, and
  // a helper that skipped this would silently test the refusal instead.
  quests.credit(sponsorId as never, 1_000_000)
  await post(`/v1/quests/${id}/submit`, sponsorKey)
  quests.moderate(id)
  return id
}

describe('POST /v1/quests', () => {
  it('writes a draft owned by the caller', async () => {
    const response = await write(aDraft())

    expect(response.statusCode).toBe(201)
    const body = response.json()
    expect(body.quest.createdBy).toBe(sponsorId)
    expect(body.quest.status).toBe('draft')
    expect(body.quest.kind).toBe('quest')
    expect(body.quest.type).toBe(QUEST_TASK_TYPE)
    expect(body.rejectionReason).toBeNull()
  })

  /**
   * The fields a sponsor may not set are absent from the schema, so sending them
   * changes nothing — which is a stronger property than refusing them, and the
   * one worth asserting: a caller cannot author a quest in somebody else's name
   * even by trying.
   */
  it('ignores an attempt to name another author, mint a skill or publish itself', async () => {
    const response = await write(
      aDraft({ createdBy: stewardId, grants: ['mailbox'], status: 'active', kind: 'academy' }),
    )

    expect(response.statusCode).toBe(201)
    const { quest } = response.json()
    expect(quest.createdBy).toBe(sponsorId)
    expect(quest.grants).toEqual([])
    expect(quest.status).toBe('draft')
    expect(quest.kind).toBe('quest')
  })

  it('refuses a draft with no capacity or no expiry', async () => {
    const { expiresAt: _expiry, ...withoutExpiry } = aDraft()
    const { slots: _slots, ...withoutSlots } = aDraft()

    expect((await write(withoutExpiry)).statusCode).toBe(422)
    expect((await write(withoutSlots)).statusCode).toBe(422)
  })

  it('refuses a caller with no credential', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/quests',
      headers: { 'content-type': 'application/json' },
      payload: aDraft() as never,
    })

    expect(response.statusCode).toBe(401)
  })
})

describe('PATCH /v1/quests/:questId', () => {
  it('changes a draft, and answers the same for a stranger’s quest as for none', async () => {
    const written = await write(aDraft())
    const id = written.json().quest.id

    const changed = await app.inject({
      method: 'PATCH',
      url: `/v1/quests/${id}`,
      headers: { authorization: `Bearer ${sponsorKey}`, 'content-type': 'application/json' },
      payload: { title: 'Two thousand registrations' } as never,
    })
    expect(changed.statusCode).toBe(200)
    expect(changed.json().quest.title).toBe('Two thousand registrations')

    const stranger = await app.inject({
      method: 'PATCH',
      url: `/v1/quests/${id}`,
      headers: { authorization: `Bearer ${stewardKey}`, 'content-type': 'application/json' },
      payload: { title: 'Mine now' } as never,
    })
    const missing = await app.inject({
      method: 'PATCH',
      url: `/v1/quests/${crypto.randomUUID()}`,
      headers: { authorization: `Bearer ${stewardKey}`, 'content-type': 'application/json' },
      payload: { title: 'Mine now' } as never,
    })

    expect(stranger.statusCode).toBe(404)
    expect(stranger.json()).toEqual(missing.json())
  })

  it('refuses to change a quest that is awaiting review', async () => {
    const id = await awaitingReview()

    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/quests/${id}`,
      headers: { authorization: `Bearer ${sponsorKey}`, 'content-type': 'application/json' },
      payload: { title: 'Something else' } as never,
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().message).toContain('pending_review')
  })
})

describe('POST /v1/quests/:questId/submit', () => {
  it('puts the quest in the queue and says it is waiting on the moderator', async () => {
    const written = await write(aDraft())
    const id = written.json().quest.id

    const response = await post(`/v1/quests/${id}/submit`, sponsorKey)

    expect(response.statusCode).toBe(200)
    expect(response.json().quest.status).toBe('pending_review')
    expect(response.json().awaitingModeration).toBe(true)
  })

  it('refuses a second quest while the first is in the queue, and names it', async () => {
    const first = (await write(aDraft())).json().quest.id
    const second = (await write(aDraft())).json().quest.id
    await post(`/v1/quests/${first}/submit`, sponsorKey)

    const response = await post(`/v1/quests/${second}/submit`, sponsorKey)

    expect(response.statusCode).toBe(409)
    expect(response.json().message).toContain(first)
  })

  it('refuses an expiry that has already passed', async () => {
    const id = (
      await write(aDraft({ expiresAt: new Date(Date.now() - 3_600_000).toISOString() }))
    ).json().quest.id

    const response = await post(`/v1/quests/${id}/submit`, sponsorKey)

    expect(response.statusCode).toBe(422)
    expect(response.json().message).toContain('expires in the future')
  })

  it('refuses a quest the sponsor cannot pay for', async () => {
    const id = (await write(aDraft({ reward: { credits: 100, reputation: 0 }, slots: 10 }))).json()
      .quest.id
    quests.credit(sponsorId as never, 500)

    const response = await post(`/v1/quests/${id}/submit`, sponsorKey)

    expect(response.statusCode).toBe(409)
    expect(response.json().message).toContain('500')
  })
})

describe('GET /v1/quests', () => {
  it('lists the caller’s own quests and nobody else’s', async () => {
    await write(aDraft())
    await write(aDraft({ title: 'Another question entirely' }), stewardKey)

    const mine = await get('/v1/quests', sponsorKey)

    expect(mine.statusCode).toBe(200)
    expect(mine.json().quests).toHaveLength(1)
    expect(mine.json().quests[0].quest.createdBy).toBe(sponsorId)
  })
})

describe('GET /v1/quests/review', () => {
  it('is a steward’s, and reaches the queue rather than the read-one route', async () => {
    const id = await awaitingReview()

    const response = await get('/v1/quests/review', stewardKey)

    expect(response.statusCode).toBe(200)
    expect(response.json().quests.map((quest: { id: string }) => quest.id)).toEqual([id])
  })

  it('refuses a caller that holds no role', async () => {
    const response = await get('/v1/quests/review', sponsorKey)

    expect(response.statusCode).toBe(403)
    expect(response.json().code).toBe('forbidden')
  })

  it('does not carry a quest the moderator has not cleared', async () => {
    const written = await write(aDraft())
    await post(`/v1/quests/${written.json().quest.id}/submit`, sponsorKey)

    const response = await get('/v1/quests/review', stewardKey)

    expect(response.json().quests).toEqual([])
  })
})

describe('POST /v1/quests/:questId/publish', () => {
  it('publishes and reports what was escrowed', async () => {
    const id = await awaitingReview(aDraft({ reward: { credits: 10, reputation: 0 }, slots: 10 }))

    const response = await post(`/v1/quests/${id}/publish`, stewardKey)

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ escrowed: 100 })
  })

  it('refuses a steward publishing its own quest, and says why', async () => {
    const written = await write(aDraft(), stewardKey)
    const id = written.json().quest.id
    await post(`/v1/quests/${id}/submit`, stewardKey)
    quests.moderate(id)

    const response = await post(`/v1/quests/${id}/publish`, stewardKey)

    expect(response.statusCode).toBe(403)
    expect(response.json().message).toContain('Nobody decides their own quest')
  })

  it('refuses a caller that holds no role', async () => {
    const id = await awaitingReview()

    const response = await post(`/v1/quests/${id}/publish`, sponsorKey)

    expect(response.statusCode).toBe(403)
  })

  it('refuses a quest the moderator has not cleared', async () => {
    const written = await write(aDraft())
    const id = written.json().quest.id
    await post(`/v1/quests/${id}/submit`, sponsorKey)

    const response = await post(`/v1/quests/${id}/publish`, stewardKey)

    expect(response.statusCode).toBe(409)
    expect(response.json().message).toContain('moderation')
  })
})

describe('POST /v1/quests/:questId/refuse', () => {
  it('refuses with a reason the sponsor then reads', async () => {
    const id = await awaitingReview()

    const refused = await post(`/v1/quests/${id}/refuse`, stewardKey, {
      reason: 'Say which page the citizen should register on.',
    })

    expect(refused.statusCode).toBe(200)
    const own = await get(`/v1/quests/${id}`, sponsorKey)
    expect(own.json().quest.status).toBe('rejected')
    expect(own.json().rejectionReason).toBe('Say which page the citizen should register on.')
  })

  it('refuses a refusal with no reason', async () => {
    const id = await awaitingReview()

    const response = await post(`/v1/quests/${id}/refuse`, stewardKey, { reason: 'no' })

    expect(response.statusCode).toBe(422)
  })
})

/**
 * **A steward has no route that edits a quest's text**, which is a property of
 * the router rather than of any handler — so it is asserted against the router.
 *
 * A steward that edited would become the author, and the self-approval ban in
 * `#173` would have been walked around rather than enforced. The check is on
 * *who may reach the edit route*, because the route itself has to exist for the
 * author.
 */
describe('the routes a steward does not have', () => {
  it('will not let a steward edit somebody else’s quest through any method', async () => {
    const written = await write(aDraft())
    const id = written.json().quest.id

    for (const method of ['PATCH', 'PUT', 'POST'] as const) {
      const response = await app.inject({
        method,
        url: `/v1/quests/${id}`,
        headers: { authorization: `Bearer ${stewardKey}`, 'content-type': 'application/json' },
        payload: { title: 'Edited by a steward' } as never,
      })

      // 404 where the route exists and the quest is not the caller's, 404 or 405
      // where no such route exists at all. What must never appear is a 200.
      expect(response.statusCode).not.toBe(200)
    }

    const unchanged = await get(`/v1/quests/${id}`, sponsorKey)
    expect(unchanged.json().quest.title).toBe('A thousand registrations')
  })
})
