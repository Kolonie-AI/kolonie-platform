import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fakeDepositDependencies, fakeDeposits } from '../__fixtures__/deposits.js'
import { fakeQuests } from '../__fixtures__/quests.js'
import type { FastifyInstance } from 'fastify'
import {
  AcademyGraphResponseSchema,
  SkillSchema,
  TaskIdSchema,
  type ApiKey,
} from '@kolonie-ai/core'
import { buildApp } from '../app.js'
import { ACADEMY_GRAPH_MAX_AGE_SECONDS } from '../tasks.js'
import { fakeRegistry } from '../__fixtures__/registry.js'
import { fakeKeys } from '../__fixtures__/keys.js'
import { fakeSolana } from '../__fixtures__/solana.js'
import { fakeVision } from '../__fixtures__/vision.js'
import { fakePow } from '../__fixtures__/proof-of-work.js'
import { fakeGithub, fakeContributions } from '../__fixtures__/github.js'
import { fakeWakeup } from '../__fixtures__/wakeup.js'
import { fakeOperatorClaim } from '../__fixtures__/operator-claim.js'
import { fakeSocial } from '../__fixtures__/social.js'
import { fakeDomain } from '../__fixtures__/domain.js'
import { fakeWebsite } from '../__fixtures__/website.js'
import { fakeImage } from '../__fixtures__/image.js'
import { fakeScene } from '../__fixtures__/scene.js'
import { fakeInjection } from '../__fixtures__/injection.js'
import { fakeStore, type FakeStore } from '../__fixtures__/store.js'
import { aTask, fakeCatalogue, type FakeCatalogue } from '../__fixtures__/catalogue.js'
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
let catalogue: FakeCatalogue
let apiKey: ApiKey

beforeEach(async () => {
  store = fakeStore()
  catalogue = fakeCatalogue()
  app = buildApp({
    vault: { vault: fakeVault() },
    accounts: fakeAccounts(),
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
    erasure: erasure({ desk: fakeErasureDesk() }),
    retesting: { reset: async () => ({ outcome: 'not-a-tester' as const }) },
    academy: fakeAcademy(),
    keys: fakeKeys(),
    solana: fakeSolana(),
    pow: fakePow(),
    vision: fakeVision(),
    github: fakeGithub(),
    contributions: fakeContributions(),
    wakeup: fakeWakeup(),
    social: fakeSocial(),
    operatorClaim: fakeOperatorClaim(),
    domain: fakeDomain(),
    website: fakeWebsite(),
    image: fakeImage(),
    scene: fakeScene(),
    injection: fakeInjection(),
  })
  await app.ready()
  apiKey = store.issue().apiKey
})

afterEach(async () => {
  await app.close()
})

/** `null` is the caller this endpoint is for: one presenting nothing. */
const get = (key: ApiKey | null = null) =>
  app.inject({
    method: 'GET',
    url: '/v1/academy/graph',
    ...(key === null ? {} : { headers: { authorization: `Bearer ${key}` } }),
  })

describe('GET /v1/academy/graph', () => {
  it('answers a caller with no Authorization header', async () => {
    catalogue.answersGraph([aTask()])

    const response = await get()

    expect(response.statusCode).toBe(200)
    expect(() => AcademyGraphResponseSchema.parse(response.json())).not.toThrow()
  })

  it('carries what a reader needs to draw the graph', async () => {
    catalogue.answersGraph([
      aTask({
        requires: [SkillSchema.parse('profile')],
        suggests: [SkillSchema.parse('keypair')],
        grants: [SkillSchema.parse('wallet')],
        minReputation: 3,
        reward: { credits: 0, reputation: 4 },
      }),
    ])

    const [node] = (await get()).json().nodes

    expect(node).toMatchObject({
      title: expect.any(String),
      description: expect.any(String),
      instructions: expect.any(String),
      requires: ['profile'],
      suggests: ['keypair'],
      grants: ['wallet'],
      // The floor #96 was amended to carry. A reader that cannot see it would
      // draw a node as reachable that is not.
      minReputation: 3,
      rewardReputation: 4,
      recommendedOrder: expect.any(Number),
      status: 'active',
    })
  })

  it('keeps the order the catalogue read them in', async () => {
    catalogue.answersGraph([
      aTask({ title: 'first', recommendedOrder: 0 }),
      aTask({ title: 'second', recommendedOrder: 10 }),
      aTask({ title: 'third', recommendedOrder: 20 }),
    ])

    const titles = (await get()).json().nodes.map((node: { title: string }) => node.title)

    // The route does not sort. The total order is the storage read's, and
    // re-sorting here would be a second opinion about it that could disagree.
    expect(titles).toEqual(['first', 'second', 'third'])
  })

  it('says the Academy is empty rather than failing when it is', async () => {
    catalogue.answersGraph([])

    const response = await get()

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ nodes: [] })
  })

  /**
   * The rejection case #96 requires. The route has no agent perspective, and
   * this fails the day one is introduced.
   */
  it('answers a valid credential with a byte-identical body', async () => {
    catalogue.answersGraph([aTask(), aTask({ title: 'a second node' })])

    const anonymous = await get()
    const authenticated = await get(apiKey)

    expect(authenticated.statusCode).toBe(anonymous.statusCode)
    expect(authenticated.body).toBe(anonymous.body)
  })

  /**
   * **The same assertion, with the field most likely to break it** (`#193`).
   * `cleared` is the first thing on this response that is about what citizens
   * have done, and *"has anybody cleared this"* is one keystroke away from
   * *"have you"*. A caller holding a credential gets the same bytes as a
   * stranger, including when the flag is true.
   */
  it('answers the same bytes about a cleared node, credential or not', async () => {
    catalogue.answersGraphEntries([
      { task: aTask({ title: 'walked' }), cleared: true },
      { task: aTask({ title: 'not walked' }), cleared: false },
    ])

    const anonymous = await get()
    const authenticated = await get(apiKey)

    expect(authenticated.body).toBe(anonymous.body)
    expect(anonymous.json().nodes.map((node: { cleared: boolean }) => node.cleared)).toEqual([
      true,
      false,
    ])
  })

  /**
   * Mandatory rather than optional, for the reason `status` is: a renderer must
   * not be able to fail to have it, and a missing field reads as *not cleared*
   * to anything that checks truthiness.
   */
  it('carries the flag on every node', async () => {
    catalogue.answersGraph([aTask(), aTask({ title: 'a second node' })])

    for (const node of (await get()).json().nodes) {
      expect(node).toHaveProperty('cleared')
    }
  })

  /**
   * **No counts, no rates, no ranking** — the whole reason the field is a
   * boolean. A count would be personal data at today's population: *"1 attempt,
   * 0 passes"* on a task names an agent to anyone reading the register beside
   * it. This is the assertion that has to be argued against before somebody adds
   * one.
   */
  it('publishes nothing about how many, or by whom', async () => {
    catalogue.answersGraphEntries([{ task: aTask({ title: 'walked' }), cleared: true }])

    const [node] = (await get()).json().nodes

    expect(Object.keys(node).filter((key) => /count|passes|attempts|by|agent/i.test(key))).toEqual(
      [],
    )
  })

  it('reads the catalogue without naming an agent', async () => {
    await get(apiKey)

    // The seam takes no argument at all, so there is nothing to pass the
    // credential's subject in. Asserted anyway: this is the property that makes
    // the byte-identical test above a fact about the shape rather than a
    // coincidence.
    expect(catalogue.graphReads()).toBe(1)
    expect(catalogue.queries()).toEqual([])
    expect(catalogue.reads()).toEqual([])
  })

  /**
   * The other rejection case, and the reason the published shape is written out
   * by hand in `academyGraph` rather than derived from `Task`.
   */
  it('drops every field a task carries beyond the published ones', async () => {
    catalogue.answersGraph([
      aTask({
        hints: [{ content: 'the waypoint a page must not put next to the task', sortOrder: 0 }],
        submission: null,
        prerequisiteTaskIds: [TaskIdSchema.parse('a0000000-0000-4000-8000-000000000000')],
      }),
    ])

    const [node] = (await get()).json().nodes

    expect(Object.keys(node).sort()).toEqual([
      // The one published field that is not a property of the task (#193):
      // whether anybody has ever cleared it. Nothing else about the population
      // is here, and nothing may be derived from this.
      'cleared',
      'description',
      'grants',
      'id',
      'instructions',
      'minReputation',
      'recommendedOrder',
      'requires',
      'rewardReputation',
      'status',
      'suggests',
      'title',
      'type',
    ])
  })

  it('publishes a drafted node, carrying its status', async () => {
    catalogue.answersGraph([aTask({ status: 'draft', title: 'designed, not live' })])

    const [node] = (await get()).json().nodes

    // D-014 hides a draft from agents so nobody is offered work it cannot do. A
    // human planning against the graph is in the other position — and `status`
    // is what keeps the two readings apart.
    expect(node).toMatchObject({ title: 'designed, not live', status: 'draft' })
  })

  it('may be held at a shared cache, and read from a browser on another origin', async () => {
    const response = await get()

    expect(response.headers['cache-control']).toBe(
      `public, max-age=${ACADEMY_GRAPH_MAX_AGE_SECONDS}`,
    )
    // The wildcard rather than an origin: reflecting one would make the response
    // vary by request header, which is what a shared cache gets wrong.
    expect(response.headers['access-control-allow-origin']).toBe('*')
    expect(response.headers['vary']).toBeUndefined()
  })
})
