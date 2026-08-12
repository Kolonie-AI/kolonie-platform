import { fakeHumans } from '../__fixtures__/humans.js'
import { fakeArtefactChallenges } from '../__fixtures__/artefact.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import {
  AUDIENCE_FLOOR,
  ERROR_STATUS,
  QUEST_TASK_TYPE,
  QUEST_TIER_CAPS_LAMPORTS,
  type TaskId,
} from '@kolonie-ai/core'
import { buildApp } from '../app.js'
import { fakeRegistry } from '../__fixtures__/registry.js'
import { fakeStore, type FakeStore } from '../__fixtures__/store.js'
import { fakeCatalogue } from '../__fixtures__/catalogue.js'
import { FAKE_AUDIENCE, fakeQuests, type FakeQuestDesk } from '../__fixtures__/quests.js'
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
  // These routes are priced in single lamports so their arithmetic can be read
  // in the assertion, and the payout floor (`#743`) would refuse most of it.
  // Zero is the floor's own way of being off, and the rule itself is measured
  // where it lives — in `packages/core`, and once over a surface in
  // `src/mcp/tools/quests.test.ts`, which reaches the same handlers these do.
  quests.setPriceFloor(0)
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
    quests,
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
    wake: fakeWake(),
    wishes: fakeWishList(),
    image: fakeImage(),
    scene: fakeScene(),
    injection: fakeInjection(),
    vetting: fakeVetting(),
    authenticator: fakeAuthenticator(),
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
  questions: [
    {
      key: 'what-happened',
      prompt: 'What happened when you registered?',
      minLength: 20,
      maxLength: 500,
    },
  ],
  title: 'A thousand registrations',
  description: 'We hand out mailbox addresses and want to know whether agents can take one.',
  instructions: 'Register at the address in the brief and report what happened.',
  reward: { reputation: 5, lamports: 0 },
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

/**
 * What a sponsor is told before the step it cannot take back (`#323`).
 *
 * The three things a citizen reported missing, and they are one complaint: a
 * sponsor committed irreversibly to a text it had never been able to look at
 * from the reading side, at a price it had computed itself.
 */
describe('what comes back with a quest of your own', () => {
  /**
   * **The commitment is the cost and nothing else** (`#553`, D-106).
   *
   * It carried `balance`, `reserved` and `affordable` too, because `#174`
   * reserved a sponsor's credits at submission. There is no balance: a quest is
   * invoiced after a steward publishes it and paid from the sponsor's own
   * wallet, which the Colony has no key to. *Can you afford this* is a question
   * with no input, and the second test here — *says plainly when the draft costs
   * more than is available* — was asserting an answer to it.
   */
  it('echoes what the draft would cost', async () => {
    const written = await write(aDraft({ reward: { reputation: 0, lamports: 15 }, slots: 20 }))

    // The sponsor that reported this computed 300 by hand and was right — and
    // was told 309 between `#371` and D-114 (`#752`), the nine being an obstacle
    // pool held on top of the capacity. A quest has one price: 20 × 15.
    expect(written.json().commitment).toMatchObject({ cost: 300 })
    // Itemised since `#628`, and the parts add up to the total a sponsor commits.
    const { breakdown } = written.json().commitment
    expect(breakdown.answers).toEqual({ slots: 20, each: 15, total: 300 })
    expect(breakdown.answers.total).toBe(breakdown.total)
  })

  it('carries the quest as an answering citizen reads it', async () => {
    const written = await write(
      aDraft({
        title: 'A thousand registrations',
        instructions: 'Register at the address in the brief and report what happened.',
      }),
    )

    const { preview } = written.json()
    expect(preview).toContain('A thousand registrations')
    expect(preview).toContain('Register at the address in the brief')
    // The question keys, which are the half a citizen cannot guess (`#327`).
    expect(preview).toContain('what-happened')
  })

  it('echoes both on a change, which is the last moment either can be acted on', async () => {
    quests.credit(sponsorId as never, 10_000)
    const written = await write(aDraft())
    const id = written.json().quest.id

    const patched = await app.inject({
      method: 'PATCH',
      url: `/v1/quests/${id}`,
      headers: { authorization: `Bearer ${sponsorKey}`, 'content-type': 'application/json' },
      payload: { title: 'A thousand mailboxes', reward: { reputation: 0, lamports: 2 } } as never,
    })

    // 10 × 2 for the answers, plus 1 each for the first three obstacles.
    expect(patched.json().commitment.cost).toBe(20)
    expect(patched.json().preview).toContain('A thousand mailboxes')
  })
})

/**
 * **`the balance decomposes per quest` stood here** (`#553`, D-106).
 *
 * `#324` split a scalar `reserved` into a row per quest, because a sponsor with
 * two quests settling could not tell which had released what and the refund rule
 * was unobservable even to somebody watching for it. Both halves read
 * `GET /v1/quests/balance`, which is gone with the balance it reported.
 *
 * `commitments` is still on the quest desk and still decomposes the same rows —
 * the console reads it — so what went is the route, not the decomposition.
 */

describe('POST /v1/quests/:questId/withdraw', () => {
  it('takes a quest out of the queue and back to a draft', async () => {
    const id = await awaitingReview()

    const withdrawn = await post(`/v1/quests/${id}/withdraw`, sponsorKey)

    expect(withdrawn.statusCode).toBe(200)
    expect(withdrawn.json().quest.status).toBe('draft')
    expect(withdrawn.json().awaitingModeration).toBe(false)
  })

  /** The two things submitting took, and the whole reason the move is worth having. */
  /**
   * **The reservation half is no longer observable from a route** (`#553`). It
   * read `GET /v1/quests/balance`, which went with the balance it reported. The
   * queue slot is what a citizen actually experiences, and it is asserted on the
   * behaviour rather than on a number: a second quest could not be submitted
   * while the first held the slot, and can once it is withdrawn.
   */
  it('frees the queue slot', async () => {
    const id = await awaitingReview(aDraft({ reward: { reputation: 0, lamports: 10 }, slots: 5 }))

    await post(`/v1/quests/${id}/withdraw`, sponsorKey)

    const second = await write(aDraft())
    const secondId = second.json().quest.id
    expect((await post(`/v1/quests/${secondId}/submit`, sponsorKey)).statusCode).toBe(200)
  })

  it('leaves the text exactly as it was, so submitting again is a re-submission', async () => {
    const id = await awaitingReview(aDraft({ title: 'A thousand registrations' }))

    await post(`/v1/quests/${id}/withdraw`, sponsorKey)
    const read = await get(`/v1/quests/${id}`, sponsorKey)

    expect(read.json().quest.title).toBe('A thousand registrations')
    expect((await post(`/v1/quests/${id}/submit`, sponsorKey)).statusCode).toBe(200)
  })

  it('refuses a quest that is already a draft, and says nothing is wrong', async () => {
    const written = await write(aDraft())
    const id = written.json().quest.id

    const response = await post(`/v1/quests/${id}/withdraw`, sponsorKey)

    expect(response.statusCode).toBe(409)
    expect(response.json().message).toContain('already a draft')
  })

  it('refuses once the quest has been published', async () => {
    const id = await awaitingReview()
    quests.publish(id as never)

    const response = await post(`/v1/quests/${id}/withdraw`, sponsorKey)

    expect(response.statusCode).toBe(409)
    expect(response.json().message).toContain('Moderation answered first')
  })

  it('refuses another sponsor the same way it refuses a stranger', async () => {
    const id = await awaitingReview()
    const other = store.issue({})

    expect((await post(`/v1/quests/${id}/withdraw`, String(other.apiKey))).statusCode).toBe(404)
  })
})

/**
 * Ending a quest that is running (`#619`).
 *
 * The route that did not exist: two quests have been ended with a direct
 * `UPDATE` against production because `withdraw` refuses anything not in review.
 */
describe('POST /v1/quests/:questId/end', () => {
  const REASON = 'The question is answered and I do not need the remaining places.'

  /** A published, live quest of the sponsor's. */
  const running = async () => {
    const id = await awaitingReview()
    quests.publish(id as never)
    return id
  }

  it('ends the sponsor’s own quest and says what happened to the money and the people', async () => {
    const id = await running()

    const ended = await post(`/v1/quests/${id}/end`, sponsorKey, { reason: REASON })

    expect(ended.statusCode).toBe(200)
    expect(ended.json().quest.quest.status).toBe('retired')
    expect(ended.json().escrow).toBe('not-returned')
    expect(ended.json().attemptsStillOpen).toBe(0)
    expect(ended.json().notice).toContain('not returned')
  })

  it('lets a steward end a quest it did not write', async () => {
    const id = await running()

    expect((await post(`/v1/quests/${id}/end`, stewardKey, { reason: REASON })).statusCode).toBe(
      200,
    )
  })

  /** The first rejection case: nobody ends work they stand to gain from. */
  it('refuses a stranger the same way it refuses one who is answering', async () => {
    const id = await running()
    const other = store.issue({})

    const response = await post(`/v1/quests/${id}/end`, String(other.apiKey), { reason: REASON })

    expect(response.statusCode).toBe(404)
  })

  /**
   * The second rejection case. A reason is not decoration — the citizens who
   * were answering read it — so an ending without one is refused rather than
   * recorded as a silence.
   */
  it('refuses an ending with no reason, and says who reads it', async () => {
    const id = await running()

    const response = await post(`/v1/quests/${id}/end`, sponsorKey, {})

    expect(response.statusCode).toBe(ERROR_STATUS.validation_failed)
    expect(response.json().message).toContain('citizens working it read this')
  })

  it('refuses a quest that is not running, and names the state it is in', async () => {
    const id = await awaitingReview()

    const response = await post(`/v1/quests/${id}/end`, sponsorKey, { reason: REASON })

    expect(response.statusCode).toBe(409)
    expect(response.json().message).toContain('withdrawn')
  })
})

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

  it('refuses an attempt to name another author, mint a skill or publish itself', async () => {
    const response = await write(
      aDraft({ createdBy: stewardId, grants: ['mailbox'], status: 'active', kind: 'academy' }),
    )

    expect(response.statusCode).toBe(ERROR_STATUS.validation_failed)
    expect(response.json().message).toContain('`createdBy` is not a field of a quest')
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

  /**
   * `#630`. The ceiling had been written, tested in `packages/core` and named in
   * `governance/quests.md` since `#175`, and **no write path called it** — a soft
   * quest could be drafted at any price. These are the tests that would have
   * failed before it was wired in.
   */
  describe('the tier ceiling', () => {
    /** No verifier and no criteria, so this is a soft quest at any price. */
    const soft = (lamports: number) =>
      aDraft({ reward: { reputation: 0, lamports }, proofVerifier: null })

    it('refuses a soft quest priced above what a soft quest may pay', async () => {
      const response = await write(soft(QUEST_TIER_CAPS_LAMPORTS.soft + 1))

      expect(response.statusCode).toBe(422)
      expect(response.json().message).toContain('soft')
      expect(response.json().message).toContain(String(QUEST_TIER_CAPS_LAMPORTS.soft))
    })

    /**
     * **Naming the verifier is not enough on its own** (`#626`) — the quest has
     * to be asking for the thing it proves, which is what the second draft here
     * does and the first does not.
     */
    it('accepts the same price once the quest can be checked', async () => {
      const named = await write(
        aDraft({
          reward: { reputation: 0, lamports: QUEST_TIER_CAPS_LAMPORTS.soft + 1 },
          proofVerifier: 'email-inbox',
        }),
      )
      expect(named.statusCode).toBe(422)

      const proven = await write(
        aDraft({
          reward: { reputation: 0, lamports: QUEST_TIER_CAPS_LAMPORTS.soft + 1 },
          proofVerifier: 'email-inbox',
          questions: [
            {
              key: 'address',
              prompt: 'Which address did you register?',
              format: 'email',
              provenBy: true,
            },
          ],
        }),
      )

      expect(proven.statusCode).toBe(201)
    })

    it('judges against the setting rather than the constant when one is turned', async () => {
      quests.setTierCaps({ ...QUEST_TIER_CAPS_LAMPORTS, soft: 1 })

      expect((await write(soft(2))).statusCode).toBe(422)
      expect((await write(soft(1))).statusCode).toBe(201)
    })

    /**
     * The rejection case that matters for a dial: a ceiling nobody has turned
     * must behave as it always did rather than as no ceiling. The desk here
     * carries no override, so this is the constants doing the refusing.
     */
    it('still refuses when nothing has been set', async () => {
      expect((await write(soft(QUEST_TIER_CAPS_LAMPORTS.soft * 2))).statusCode).toBe(422)
    })

    /**
     * `#626`. The founding case, end to end: star and fork, proved by
     * `github-account`, at the hard rate. Before this it was written and
     * published; now it is refused with the reason rather than only the price.
     */
    it('refuses a quest whose verifier bears on nothing it asks, and says why', async () => {
      const response = await write(
        aDraft({
          reward: { reputation: 0, lamports: QUEST_TIER_CAPS_LAMPORTS.hard },
          proofVerifier: 'github-account',
          questions: [{ key: 'starred', prompt: 'Which of our repositories did you star?' }],
        }),
      )

      expect(response.statusCode).toBe(422)
      expect(response.json().message).toContain('github-account')
      expect(response.json().message).toContain('a GitHub account')
    })

    it('accepts the hard rate once every required question is one the verifier proves', async () => {
      const response = await write(
        aDraft({
          reward: { reputation: 0, lamports: QUEST_TIER_CAPS_LAMPORTS.hard },
          proofVerifier: 'github-account',
          questions: [
            {
              key: 'handle',
              prompt: 'Which GitHub account did you register?',
              format: 'handle',
              provenBy: true,
            },
          ],
        }),
      )

      expect(response.statusCode).toBe(201)
    })

    it('still lets a verifier be named purely as a gate', async () => {
      const response = await write(
        aDraft({
          reward: { reputation: 0, lamports: QUEST_TIER_CAPS_LAMPORTS['colony-judged'] },
          proofVerifier: 'github-account',
          questions: [
            { key: 'what-happened', prompt: 'What happened?', criteria: 'Say what the page did.' },
          ],
        }),
      )

      expect(response.statusCode).toBe(201)
    })
  })
})

describe('PATCH /v1/quests/:questId', () => {
  /**
   * `#631`. `#630` wired the ceiling into the write and the submit and could not
   * reach the edit — a patch is a subset and the tier depends on every field at
   * once. It is reached now, by merging the patch onto the quest first.
   */
  it('revalidates the tier ceiling against the quest the edit produces', async () => {
    const id = (await write(aDraft({ reward: { reputation: 0, lamports: 1 } }))).json().quest.id

    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/quests/${id}`,
      headers: { authorization: `Bearer ${sponsorKey}`, 'content-type': 'application/json' },
      payload: { reward: { reputation: 0, lamports: QUEST_TIER_CAPS_LAMPORTS.soft + 1 } } as never,
    })

    expect(response.statusCode).toBe(422)
    expect(response.json().message).toContain('soft')
  })

  it('accepts a price the merged quest can carry, judging the whole and not the patch', async () => {
    const id = (
      await write(
        aDraft({
          reward: { reputation: 0, lamports: 1 },
          proofVerifier: 'email-inbox',
          questions: [
            {
              key: 'address',
              prompt: 'Which address did you register?',
              format: 'email',
              provenBy: true,
            },
          ],
        }),
      )
    ).json().quest.id

    // Above the soft ceiling and inside the hard one, which the quest already is.
    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/quests/${id}`,
      headers: { authorization: `Bearer ${sponsorKey}`, 'content-type': 'application/json' },
      payload: { reward: { reputation: 0, lamports: QUEST_TIER_CAPS_LAMPORTS.soft + 1 } } as never,
    })

    expect(response.statusCode).toBe(200)
  })

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

/**
 * `#631`. A draft is the one thing here nobody outside its author has seen, and
 * the rule protecting published quests had been applied to it.
 */
describe('DELETE /v1/quests/:questId', () => {
  const discard = (id: string, key: string) =>
    app.inject({
      method: 'DELETE',
      url: `/v1/quests/${id}`,
      headers: { authorization: `Bearer ${key}` },
    })

  it('throws away a draft, and it stops being listed', async () => {
    const id = (await write(aDraft())).json().quest.id

    const response = await discard(id, sponsorKey)

    expect(response.statusCode).toBe(200)
    expect(response.json().discarded).toBe(true)
    expect((await get('/v1/quests', sponsorKey)).json().quests).toEqual([])
  })

  /** The rejection case: somebody else's draft is not yours to delete. */
  it('answers a stranger as it answers a quest that does not exist', async () => {
    const id = (await write(aDraft())).json().quest.id

    expect((await discard(id, stewardKey)).statusCode).toBe(404)
    expect((await discard(crypto.randomUUID(), sponsorKey)).statusCode).toBe(404)
    // And the draft is still there.
    expect((await get('/v1/quests', sponsorKey)).json().quests).toHaveLength(1)
  })

  it('refuses a quest that has been submitted, naming the status', async () => {
    const id = (await write(aDraft())).json().quest.id
    await post(`/v1/quests/${id}/submit`, sponsorKey)

    const response = await discard(id, sponsorKey)

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

  it('refuses a fourth submission of one draft and leaves a new draft free', async () => {
    const id = (await write(aDraft())).json().quest.id as TaskId

    for (let refusal = 1; refusal <= 3; refusal += 1) {
      expect((await post(`/v1/quests/${id}/submit`, sponsorKey)).statusCode).toBe(200)
      quests.moderate(id, 'rejected')
      const changed = await app.inject({
        method: 'PATCH',
        url: `/v1/quests/${id}`,
        headers: { authorization: `Bearer ${sponsorKey}`, 'content-type': 'application/json' },
        payload: { instructions: `Corrected after refusal ${refusal}.` } as never,
      })
      expect(changed.statusCode).toBe(200)
    }

    const spent = await post(`/v1/quests/${id}/submit`, sponsorKey)
    expect(spent.statusCode).toBe(409)
    expect(spent.json()).toMatchObject({
      code: 'conflict',
      message: 'This quest has been refused three times; write a new one.',
    })

    const discarded = await app.inject({
      method: 'DELETE',
      url: `/v1/quests/${id}`,
      headers: { authorization: `Bearer ${sponsorKey}` },
    })
    expect(discarded.statusCode).toBe(200)

    const next = (await write(aDraft())).json().quest.id
    expect((await post(`/v1/quests/${next}/submit`, sponsorKey)).statusCode).toBe(200)
  })

  it('refuses an expiry that has already passed', async () => {
    const id = (
      await write(aDraft({ expiresAt: new Date(Date.now() - 3_600_000).toISOString() }))
    ).json().quest.id

    const response = await post(`/v1/quests/${id}/submit`, sponsorKey)

    expect(response.statusCode).toBe(422)
    expect(response.json().message).toContain('expires in the future')
  })

  /**
   * **Submission is the backstop rather than the only check** (`#630`, `#631`).
   *
   * `#630` could not reach the edit — a patch is a subset of fields and the tier
   * depends on all of them — so an edit could push a draft over and only
   * submission would catch it. `#631` merges the patch and refuses at the edit,
   * which is asserted one describe up. What is asserted here is that the check
   * at submission has not gone: a draft written straight over the ceiling, by a
   * path that skipped the edit entirely, is still refused.
   */
  it('refuses a draft that is over its tier ceiling when it is submitted', async () => {
    const id = (await write(aDraft({ reward: { reputation: 0, lamports: 1 } }))).json().quest.id

    // Under the ceiling at the edit, and over it once the ceiling moves.
    quests.setTierCaps({ ...QUEST_TIER_CAPS_LAMPORTS, soft: 0 })

    const response = await post(`/v1/quests/${id}/submit`, sponsorKey)

    expect(response.statusCode).toBe(422)
    expect(response.json().message).toContain('soft')
  })

  it('applies a ceiling lowered between drafting and submitting', async () => {
    const id = (
      await write(aDraft({ reward: { reputation: 0, lamports: QUEST_TIER_CAPS_LAMPORTS.soft } }))
    ).json().quest.id

    quests.setTierCaps({ ...QUEST_TIER_CAPS_LAMPORTS, soft: 1 })

    expect((await post(`/v1/quests/${id}/submit`, sponsorKey)).statusCode).toBe(422)
  })

  it('refuses a quest the sponsor cannot pay for', async () => {
    const id = (await write(aDraft({ reward: { reputation: 0, lamports: 100 }, slots: 10 }))).json()
      .quest.id
    quests.credit(sponsorId as never, 500)

    const response = await post(`/v1/quests/${id}/submit`, sponsorKey)

    expect(response.statusCode).toBe(409)
    // 10 × 100 for the answers against 500 held: the refusal names the shortfall
    // rather than the balance. It read 575 until D-114 (`#752`), the extra 75
    // being an obstacle pool on top of the capacity.
    expect(response.json().message).toContain('500')
  })
})

/**
 * `#629`. The route half: who may buy places, on what, and what the sponsor is
 * told before it pays. The invariant — capacity and its money moving together —
 * is `packages/db`'s and is asserted there against a real Postgres.
 */
describe('POST /v1/quests/:questId/slots', () => {
  /** A quest a steward has published, which is the only kind capacity is sold on. */
  const aPublishedQuest = async (): Promise<string> => {
    const id = await awaitingReview(aDraft({ reward: { reputation: 0, lamports: 100 }, slots: 3 }))
    quests.publish(id as never)
    return id
  }

  it('buys places, and says what is owed and how long the quest has left', async () => {
    const id = await aPublishedQuest()

    const response = await post(`/v1/quests/${id}/slots`, sponsorKey, { slots: 3 })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.pendingSlots).toBe(3)
    expect(body.invoice.lamports).toBe(300)
    // The expiry is the one thing a top-up cannot move, so it is said before
    // the sponsor pays rather than discovered afterwards.
    expect(body.notice).toContain('hour(s)')
    expect(typeof body.hoursLeft).toBe('number')
  })

  /** The rejection case: somebody else's quest is not yours to spend on. */
  it('answers a steward buying places on a sponsor’s quest as it answers a stranger', async () => {
    const id = await aPublishedQuest()

    const response = await post(`/v1/quests/${id}/slots`, stewardKey, { slots: 3 })

    expect(response.statusCode).toBe(404)
  })

  /** The other rejection case: there is no field for a price, so it cannot arrive. */
  it('ignores an attempt to change the reward, because there is no field for one', async () => {
    const id = await aPublishedQuest()

    const response = await post(`/v1/quests/${id}/slots`, sponsorKey, {
      slots: 2,
      reward: { reputation: 0, lamports: 100_000 },
    })

    expect(response.statusCode).toBe(200)
    // Two more at the price the quest already carries, and not at the one sent.
    expect(response.json().invoice.lamports).toBe(200)
    expect(response.json().quest.quest.reward.lamports).toBe(100)
  })

  it('refuses a capacity that is not a whole number of places, and one that is zero', async () => {
    const id = await aPublishedQuest()

    expect((await post(`/v1/quests/${id}/slots`, sponsorKey, { slots: 0 })).statusCode).toBe(422)
    expect((await post(`/v1/quests/${id}/slots`, sponsorKey, { slots: -3 })).statusCode).toBe(422)
    expect((await post(`/v1/quests/${id}/slots`, sponsorKey, {})).statusCode).toBe(422)
  })

  it('refuses a quest that is still a draft, and says where capacity is bought', async () => {
    const id = (await write(aDraft())).json().quest.id

    const response = await post(`/v1/quests/${id}/slots`, sponsorKey, { slots: 3 })

    expect(response.statusCode).toBe(409)
    expect(response.json().message).toContain('draft')
  })

  it('refuses a second purchase while the first is waiting for its money', async () => {
    const id = await aPublishedQuest()
    await post(`/v1/quests/${id}/slots`, sponsorKey, { slots: 3 })

    const response = await post(`/v1/quests/${id}/slots`, sponsorKey, { slots: 1 })

    expect(response.statusCode).toBe(409)
    expect(response.json().message).toContain('already bought')
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

/**
 * **`GET /v1/quests/balance`'s tests stood here** (`#553`, D-106). The route
 * answered what a sponsor could still commit, in credits, and the Colony holds
 * no balance for anybody — a citizen is paid in SOL to a wallet it alone has the
 * key to. `kolonie.me.earnings` (`#535`) is the citizen's record of what it was
 * paid; a quest's invoice is the sponsor's side. Neither is a balance.
 */

describe('GET /v1/quests/audience', () => {
  /**
   * The route `#350` added, and the same shape of gap `#320` closed for the
   * balance: the count was on the desk from `#227` and reachable from one
   * console page, so a sponsor that is not driving a browser could not learn
   * what a requirement costs it in reach.
   */
  it('answers how many citizens a requirement set reaches', async () => {
    const response = await get('/v1/quests/audience?requires=browser,mailbox', sponsorKey)

    expect(response.statusCode).toBe(200)
    expect(response.json().audience).toEqual({ kind: 'exact', citizens: FAKE_AUDIENCE })
    expect(quests.audienceAsked.at(-1)).toMatchObject({
      audience: 'citizens',
      requires: ['browser', 'mailbox'],
      minReputation: 0,
      minActivityDays: null,
    })
  })

  /** The baseline a requirement is measured against, and a valid ask. */
  it('counts everybody who could answer at all when nothing is required', async () => {
    const response = await get('/v1/quests/audience', sponsorKey)

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      audience: { kind: 'exact', citizens: FAKE_AUDIENCE },
      criteria: { requires: [], audience: 'citizens' },
    })
  })

  /**
   * A count of one is close to a name, and a sponsor can bisect its way to it
   * by adding skills. The floor is what makes that route stop short.
   */
  it('suppresses a count below the floor and never names anybody', async () => {
    quests.countAudienceAs(1)

    const response = await get('/v1/quests/audience?requires=browser', sponsorKey)

    expect(response.json().audience).toEqual({
      kind: 'fewer-than',
      citizens: AUDIENCE_FLOOR,
    })
    expect(JSON.stringify(response.json())).not.toContain(sponsorId)
  })

  /** Zero is publishable and identifies nobody, so it is stated. */
  it('states zero rather than suppressing it', async () => {
    quests.countAudienceAs(0)

    const response = await get('/v1/quests/audience?requires=browser', sponsorKey)

    expect(response.json().audience).toEqual({ kind: 'exact', citizens: 0 })
  })

  it('refuses a requirement that is not a skill slug rather than counting nothing', async () => {
    const response = await get('/v1/quests/audience?requires=Browser%20Skill', sponsorKey)

    expect(response.statusCode).toBe(ERROR_STATUS.validation_failed)
    expect(response.json().code).toBe('validation_failed')
  })

  it('needs a key, like every other route on this prefix', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/quests/audience' })

    expect(response.statusCode).toBe(401)
  })

  /** Static before parametric: the id route must not swallow it. */
  it('is not read as a quest id', async () => {
    const response = await get('/v1/quests/audience', sponsorKey)

    expect(response.statusCode).toBe(200)
    expect(response.json().quest).toBeUndefined()
  })
})

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

/**
 * What a sponsor reads, and — at greater length — what it never does (`#178`).
 *
 * The denylist is asserted item by item rather than by one "no other keys"
 * check, because a denylist that is not written down is not enforced, and the
 * list is the thing a later change would quietly grow past.
 */
describe('GET /v1/quests/:questId/results', () => {
  const withAccepted = async () => {
    const id = await awaitingReview()
    quests.publish(id as never)
    quests.accept({
      taskId: id as TaskId,
      answers: { 'what-happened': 'The signup took two tries.' },
      agentId: sponsorId as never,
    })
    return id
  }

  it('carries exactly the two fields a sponsor is entitled to', async () => {
    const id = await withAccepted()

    const response = await get(`/v1/quests/${id}/results`, sponsorKey)

    expect(response.statusCode).toBe(200)
    const [result] = response.json().results
    expect(Object.keys(result).sort()).toEqual(['acceptedAt', 'answers'])
  })

  it.each([
    /**
     * The two that were here until 2026-08-05 and are now on the denylist
     * (`#328`). `kolonie.quests.results` promises in bold that a sponsor never
     * learns who wrote what, and these are the two fields that broke it.
     */
    'handle',
    'runtime',
    'agentId',
    'email',
    'mailbox',
    'ip',
    'assistance',
    'reputation',
    'balance',
    'skills',
    'submissionId',
  ])('never carries %s, anywhere in the payload', async (field) => {
    const id = await withAccepted()

    const response = await get(`/v1/quests/${id}/results`, sponsorKey)

    // The whole serialised body, because a field nested one level down is
    // exactly as served as one at the top.
    expect(JSON.stringify(response.json().results)).not.toContain(field)
  })

  it('refuses another sponsor the same way it refuses a stranger', async () => {
    const id = await withAccepted()

    const other = store.issue({})
    const response = await get(`/v1/quests/${id}/results`, String(other.apiKey))

    expect(response.statusCode).toBe(404)
  })

  it('refuses a steward, because reviewing and reading are different powers', async () => {
    const id = await withAccepted()

    expect((await get(`/v1/quests/${id}/results`, stewardKey)).statusCode).toBe(404)
  })

  it('counts the options of a closed question and nothing else', async () => {
    const written = await write(
      aDraft({
        questions: [
          {
            key: 'worked',
            prompt: 'Did the signup work?',
            options: ['yes', 'no'],
          },
          { key: 'notes', prompt: 'Anything else?', minLength: 10, maxLength: 200 },
        ],
      }),
    )
    const id = written.json().quest.id
    quests.credit(sponsorId as never, 1_000_000)
    await post(`/v1/quests/${id}/submit`, sponsorKey)
    quests.moderate(id as TaskId)
    quests.publish(id as never)
    quests.accept({
      taskId: id as TaskId,
      answers: { worked: 'yes', notes: 'It was quick.' },
    })
    quests.accept({
      taskId: id as TaskId,
      answers: { worked: 'yes', notes: 'Two tries.' },
    })

    const counts = (await get(`/v1/quests/${id}/results`, sponsorKey)).json().counts

    expect(counts).toEqual({ worked: { yes: 2, no: 0 } })
    // A thousand free-text answers are a thousand free-text answers: the Colony
    // does not summarise them, because a summary is an opinion.
    expect(counts).not.toHaveProperty('notes')
  })
})

describe('GET /v1/quests/:questId/results/export', () => {
  const withAccepted = async () => {
    const id = await awaitingReview()
    quests.publish(id as never)
    quests.accept({
      taskId: id as TaskId,
      answers: { 'what-happened': 'It worked, eventually' },
    })
    return id
  }

  it('exports CSV with a column per question', async () => {
    const id = await withAccepted()

    const response = await get(`/v1/quests/${id}/results/export?format=csv`, sponsorKey)

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/csv')
    const [header, row] = response.body.split('\n')
    expect(header).toBe('acceptedAt,what-happened')
    // The row opens with the timestamp, because the two columns in front of it
    // named the author and left with `#328`.
    expect(row).not.toContain('ariadne')
    // The answer itself is one quoted cell, which the next test is about.
    expect(row).toContain('"It worked, eventually"')
  })

  it('quotes a cell containing a comma, so the columns survive it', async () => {
    const id = await withAccepted()

    const body = (await get(`/v1/quests/${id}/results/export?format=csv`, sponsorKey)).body

    expect(body).toContain('"It worked, eventually"')
  })

  it('exports JSON with the same fields as the read view', async () => {
    const id = await withAccepted()

    const response = await get(`/v1/quests/${id}/results/export?format=json`, sponsorKey)

    const [result] = JSON.parse(response.body).results
    expect(Object.keys(result).sort()).toEqual(['acceptedAt', 'answers'])
  })

  it('refuses a format that is neither', async () => {
    const id = await withAccepted()

    expect((await get(`/v1/quests/${id}/results/export?format=xml`, sponsorKey)).statusCode).toBe(
      422,
    )
  })

  it('refuses another sponsor', async () => {
    const id = await withAccepted()
    const other = store.issue({})

    expect(
      (await get(`/v1/quests/${id}/results/export?format=csv`, String(other.apiKey))).statusCode,
    ).toBe(404)
  })
})

describe('GET /v1/quests/:questId/answer', () => {
  it('shows a citizen its own answer in the shape the sponsor gets', async () => {
    const id = await awaitingReview()
    quests.publish(id as never)
    const citizen = store.issue({})
    quests.accept({
      taskId: id as TaskId,
      answers: { 'what-happened': 'The signup took two tries.' },
      agentId: citizen.agent.id,
    })

    const mine = await get(`/v1/quests/${id}/answer`, String(citizen.apiKey))
    const theirs = (await get(`/v1/quests/${id}/results`, sponsorKey)).json().results[0]

    expect(mine.statusCode).toBe(200)
    // Byte-identical, which is the point: the citizen can check the scrub.
    expect(JSON.stringify(mine.json())).toBe(JSON.stringify(theirs))
  })

  it('answers 404 for a citizen with no accepted report', async () => {
    const id = await awaitingReview()
    const citizen = store.issue({})

    expect((await get(`/v1/quests/${id}/answer`, String(citizen.apiKey))).statusCode).toBe(404)
  })
})

/**
 * The audit surface, and the notice that goes with it (`#221`).
 *
 * The queue itself is asserted in `packages/db` against a real Postgres — the
 * draw is SQL. What is asserted here is who may reach it, and that a verdict is
 * read once.
 */
describe('the sampling audit', () => {
  it('is a steward’s queue and nobody else’s', async () => {
    expect((await get('/v1/quests/audit', stewardKey)).statusCode).toBe(200)
    expect((await get('/v1/quests/audit', sponsorKey)).statusCode).toBe(403)
  })

  it('records a decision, and tells the second steward it was read', async () => {
    const submissionId = crypto.randomUUID()
    const decision = { agrees: false, reason: 'The answer is about a different service.' }

    const first = await post(`/v1/quests/audit/${submissionId}`, stewardKey, decision)
    const second = await post(`/v1/quests/audit/${submissionId}`, stewardKey, decision)

    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(409)
  })

  it('refuses a decision with no reason, in either direction', async () => {
    const submissionId = crypto.randomUUID()

    expect(
      (await post(`/v1/quests/audit/${submissionId}`, stewardKey, { agrees: true })).statusCode,
    ).toBe(422)
    expect(
      (await post(`/v1/quests/audit/${submissionId}`, stewardKey, { agrees: false, reason: 'no' }))
        .statusCode,
    ).toBe(422)
  })

  it('carries the rate a steward is being asked to act on', async () => {
    const response = await get('/v1/quests/audit', stewardKey)

    expect(response.json().disagreement).toEqual({ rate: 0, audited: 0 })
  })
})

/**
 * `rewardNotice` was a field on every quest a citizen read, so its removal is
 * checked where a citizen would have seen it and not only where it was produced
 * (`#572`). The paid case is the one that carried the sentence.
 */
describe('the notice on a paid quest', () => {
  it('is gone, and the field with it', async () => {
    const written = await write(aDraft({ reward: { reputation: 0, lamports: 5 } }))

    expect(written.json().quest).not.toHaveProperty('rewardNotice')
  })
})
