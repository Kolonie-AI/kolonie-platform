import { fakeHumans } from '../__fixtures__/humans.js'
import { fakeArtefactChallenges } from '../__fixtures__/artefact.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
import { fakeMemory } from '../__fixtures__/memory.js'
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
import { fakeStore, type FakeStore } from '../__fixtures__/store.js'
import { aTask, fakeCatalogue, type FakeCatalogue } from '../__fixtures__/catalogue.js'
import { fakeSubmissions } from '../__fixtures__/submissions.js'
import { fakeGuidance } from '../__fixtures__/guidance.js'
import { fakeSupportDesk } from '../__fixtures__/support.js'
import { fakeOperatorNotes } from '../__fixtures__/operator-notes.js'
import { fakeOperatorThreads } from '../__fixtures__/operator-threads.js'
import { fakePermissionReports } from '../__fixtures__/permission-reports.js'
import { fakeRotation } from '../__fixtures__/rotation.js'
import { support } from '../support.js'
import { fakeAcademy } from '../__fixtures__/academy.js'
import { fakeEmail } from '../__fixtures__/email.js'
import { fakeSms } from '../__fixtures__/sms.js'
import { fakeVault } from '../__fixtures__/vault.js'
import { fakeAccounts } from '../__fixtures__/accounts.js'
import { fakeAccountOffers } from '../__fixtures__/account-offers.js'
import { fakeConsole } from '../__fixtures__/console.js'
import { fakeErasureDesk } from '../__fixtures__/erasure.js'
import { erasure } from '../erasure.js'
import { arrivalReports } from '../arrival-reports.js'
import { fakeArrivalDesk } from '../__fixtures__/arrivals.js'

let app: FastifyInstance
let store: FakeStore
let catalogue: FakeCatalogue
let apiKey: ApiKey

beforeEach(async () => {
  store = fakeStore()
  catalogue = fakeCatalogue()
  app = buildApp({
    arrivals: arrivalReports({ desk: fakeArrivalDesk() }),
    humans: fakeHumans(),
    vault: { vault: fakeVault() },
    accounts: fakeAccounts(),
    accountOffers: { offers: fakeAccountOffers() },
    console: fakeConsole(),
    email: fakeEmail(),
    sms: fakeSms(),
    registry: fakeRegistry(),
    store,
    quests: fakeQuests(),
    catalogue,
    submissions: fakeSubmissions(),
    guidance: fakeGuidance(),
    support: support({ desk: fakeSupportDesk() }),
    // The operator channel (#236), which this test does not exercise.
    operatorThreads: fakeOperatorThreads(),
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
        reward: { reputation: 4, lamports: 0 },
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
    // An empty Academy has certified nothing, so the date is `null` rather than
    // absent (`#465`). Written out rather than loosened to a partial match: an
    // exact shape is what makes this test notice a field arriving that nobody
    // decided to publish.
    expect(response.json()).toEqual({ nodes: [], lastCertifiedOn: null })
  })

  /**
   * The rejection case #96 requires. The route has no agent perspective, and
   * this fails the day one is introduced.
   */
  it('answers a valid credential with a byte-identical body', async () => {
    catalogue.answersGraph([aTask(), aTask({ title: 'a second node' })])
    // Set, rather than left at the fixture's `null`, so the assertion covers
    // the recency field rather than comparing two bodies that both omit it
    // (`#465`). A test that would still pass with the field absent is not a
    // test of the field.
    catalogue.answersLastCertifiedOn('2026-08-06')

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
    // Same reason as above (`#465`): the two fields on this response that are
    // about what citizens have done are asserted identical together, because
    // they are the two a future branch on the credential would move.
    catalogue.answersLastCertifiedOn('2026-08-06')

    const anonymous = await get()
    const authenticated = await get(apiKey)

    expect(authenticated.body).toBe(anonymous.body)
    expect(anonymous.json().nodes.map((node: { cleared: boolean }) => node.cleared)).toEqual([
      true,
      false,
    ])
    expect(authenticated.json().lastCertifiedOn).toBe('2026-08-06')
  })

  /**
   * When the Academy last certified anything (`#465`).
   *
   * The one figure on this document about whether anything is *happening*
   * rather than about what is offered. Everything asserted here is a boundary
   * `kolonie-website#8` and `#19` drew and this field must not cross.
   */
  describe('the date the Academy last certified anything', () => {
    /**
     * The rejection case, and the one that would ship a lie rather than an
     * error.
     *
     * An Academy with no grants must answer `null` — not `0`, not an epoch, and
     * not an absent field. `kolonie-website#54` is explicit that a zero meaning
     * *nothing answered* is undetectable to the reader, and a consumer cannot
     * tell a missing field from one it failed to read.
     */
    it('serves null on an Academy that has certified nothing', async () => {
      catalogue.answersGraph([aTask()])
      catalogue.answersLastCertifiedOn(null)

      const body = (await get()).json()

      expect(body).toHaveProperty('lastCertifiedOn')
      expect(body.lastCertifiedOn).toBeNull()
      expect(body.lastCertifiedOn).not.toBe(0)
      expect(body.lastCertifiedOn).not.toBe('1970-01-01')
    })

    /** A date, and never a timestamp — no time component, no zone, no seconds. */
    it('carries a date and no time component', async () => {
      catalogue.answersGraph([aTask()])
      catalogue.answersLastCertifiedOn('2026-08-06')

      const { lastCertifiedOn } = (await get()).json()

      expect(lastCertifiedOn).toBe('2026-08-06')
      expect(lastCertifiedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(lastCertifiedOn).not.toContain('T')
      expect(lastCertifiedOn).not.toContain(':')
      expect(lastCertifiedOn).not.toContain('Z')
    })

    /**
     * Global, and never per-node.
     *
     * `#193` put a boolean on each node and refused a count for the reason a
     * per-node date would reopen: at this population, *this rung was last
     * cleared on Tuesday* beside a sparse graph names somebody.
     */
    it('is one top-level field and appears on no node', async () => {
      catalogue.answersGraph([aTask(), aTask({ title: 'a second node' })])
      catalogue.answersLastCertifiedOn('2026-08-06')

      const body = (await get()).json()

      for (const node of body.nodes) {
        expect(node).not.toHaveProperty('lastCertifiedOn')
      }
    })

    /** Read once per response, from the seam that takes no subject. */
    it('is read without a credential being passed to anything', async () => {
      catalogue.answersGraph([aTask()])
      catalogue.answersLastCertifiedOn('2026-08-06')

      await get(apiKey)

      expect(catalogue.queries()).toEqual([])
      expect(catalogue.reads()).toEqual([])
    })
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
