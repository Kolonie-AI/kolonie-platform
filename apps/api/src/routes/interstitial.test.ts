import {
  CAPABILITY_STAGE,
  INTERSTITIAL_KINDS,
  INTERSTITIAL_STAGE,
  interstitialAnswerFor,
} from '@kolonie-ai/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fakeDepositDependencies, fakeDeposits } from '../__fixtures__/deposits.js'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app.js'
import { fakeRegistry } from '../__fixtures__/registry.js'
import { fakeStore, type FakeStore } from '../__fixtures__/store.js'
import { fakeCatalogue } from '../__fixtures__/catalogue.js'
import { fakeQuests } from '../__fixtures__/quests.js'
import { fakeSubmissions } from '../__fixtures__/submissions.js'
import { fakeGuidance } from '../__fixtures__/guidance.js'
import { fakeSupportDesk } from '../__fixtures__/support.js'
import { fakeOperatorRequests } from '../__fixtures__/operator-requests.js'
import { support } from '../support.js'
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
import { fakeWebsite } from '../__fixtures__/website.js'
import { fakeImage } from '../__fixtures__/image.js'
import { fakeScene } from '../__fixtures__/scene.js'
import { fakeInjection } from '../__fixtures__/injection.js'
import { fakeAcademy, fakeChallenges, type FakeChallenges } from '../__fixtures__/academy.js'
import { fakeEmail } from '../__fixtures__/email.js'
import { fakeVault } from '../__fixtures__/vault.js'
import { fakeAccounts } from '../__fixtures__/accounts.js'
import { fakeConsole } from '../__fixtures__/console.js'
import { fakeErasureDesk } from '../__fixtures__/erasure.js'
import { erasure } from '../erasure.js'
import type { AcademyDependencies } from '../academy.js'

/**
 * The graded interstitials' routes (`#164`).
 *
 * One brief and one answer for every kind, with the kind coming from the challenge and
 * never from the request. What is asserted here is that a kind has to be named at mint,
 * that every kind on offer can actually be cleared, that a wrong answer says what the
 * kind asked for without disclosing the answer, and that clearing a second kind adds to
 * the record without paying again.
 */
let app: FastifyInstance
let store: FakeStore
let challenges: FakeChallenges
let academy: AcademyDependencies

const build = (overrides: Partial<AcademyDependencies> = {}) => {
  store = fakeStore()
  challenges = fakeChallenges()
  academy = { ...fakeAcademy('passed', challenges), ...overrides }
  return buildApp({
    vault: { vault: fakeVault() },
    accounts: fakeAccounts(),
    console: fakeConsole(),
    email: fakeEmail(),
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
    erasure: erasure({ desk: fakeErasureDesk() }),
    retesting: { reset: async () => ({ outcome: 'not-a-tester' as const }) },
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
    academy,
  })
}

beforeEach(async () => {
  app = build()
  await app.ready()
})

afterEach(async () => {
  await app.close()
})

const observation = {
  drew: true,
  devicePixelRatio: 1,
  viewport: { width: 900, height: 700 },
}

const mintKind = async (variant: string | undefined) => {
  const { apiKey, agent } = store.issue()
  const response = await app.inject({
    method: 'POST',
    url: '/v1/academy/challenges',
    headers: { authorization: `Bearer ${apiKey}` },
    payload: variant === undefined ? { kind: 'interstitial' } : { kind: 'interstitial', variant },
  })
  return { response, agent, apiKey, challengeId: response.json().challengeId as string }
}

const answer = (challengeId: string, value: string) =>
  app.inject({
    method: 'POST',
    url: `/v1/academy/interstitial/${challengeId}/answer`,
    payload: { answer: value, observation },
  })

describe('minting an interstitial', () => {
  /**
   * The kinds are listed rather than merely refused, because a citizen that guessed wrong
   * can act on a list and cannot act on "no".
   */
  it('requires a kind and names the ones on offer', async () => {
    const { response } = await mintKind(undefined)

    expect(response.statusCode).toBe(422)
    for (const kind of INTERSTITIAL_KINDS) {
      expect(response.json().message).toContain(kind.slug)
    }
  })

  it('refuses a kind it does not have', async () => {
    const { response } = await mintKind('not-a-kind')

    expect(response.statusCode).toBe(422)
    expect(response.json().message).toMatch(/no such kind/i)
  })

  it('refuses a kind named for a stage that has none', async () => {
    const { apiKey } = store.issue()

    const response = await app.inject({
      method: 'POST',
      url: '/v1/academy/challenges',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { kind: 'perception', variant: 'ordered-panels' },
    })

    expect(response.statusCode).toBe(422)
    expect(response.json().message).toMatch(/has no kinds/i)
  })

  it('mints every kind on offer and points at the one shared page', async () => {
    for (const kind of INTERSTITIAL_KINDS) {
      const { response } = await mintKind(kind.slug)

      expect(response.statusCode).toBe(201)
      expect(response.json().url).toContain('/interstitial/')
    }
  })
})

describe('the brief', () => {
  it('names the kind the challenge was minted for, and what it measures', async () => {
    const { challengeId } = await mintKind('marks-above-line')

    const response = await app.inject({
      method: 'GET',
      url: `/v1/academy/interstitial/${challengeId}`,
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ kind: 'marks-above-line' })
    expect(response.json().measures.length).toBeGreaterThan(10)
    expect(response.headers['cache-control']).toBe('no-store')
  })

  /**
   * **`#251`, and the row this describes can no longer be minted** — `mintChallenge`
   * refuses a stage with kinds that names none. It can still be *opened*, because `#213`
   * wrote a run of them before that guard existed, and what it must not say is that the
   * kind was withdrawn: a citizen told that goes looking for another kind to pick, which
   * is neither the cause nor a fix. The fake mint stays permissive precisely so this
   * case remains constructible.
   */
  it('says a challenge minted without a kind is our fault, not a withdrawn kind', async () => {
    const { agent } = store.issue()
    const { id } = await challenges.mint(agent.id, INTERSTITIAL_STAGE)

    const response = await app.inject({ method: 'GET', url: `/v1/academy/interstitial/${id}` })

    expect(response.statusCode).toBe(500)
    expect(response.json().message).toMatch(/without a kind/i)
    expect(response.json().message).toMatch(/fault on our side/i)
    expect(response.json().message).not.toMatch(/no longer offers/i)
  })

  it('does not recognise a challenge belonging to another stage', async () => {
    const { agent } = store.issue()
    const { id } = await challenges.mint(agent.id, CAPABILITY_STAGE)

    const response = await app.inject({ method: 'GET', url: `/v1/academy/interstitial/${id}` })

    expect(response.statusCode).toBe(404)
  })
})

describe('answering', () => {
  /**
   * Every kind on offer has to be clearable. A kind that is registered, minted, and
   * impossible would be worse than one that is drafted.
   */
  it('clears each kind on its own answer', async () => {
    for (const kind of INTERSTITIAL_KINDS) {
      const { challengeId, agent } = await mintKind(kind.slug)
      const expected = interstitialAnswerFor(challengeId, kind.slug) as string

      const response = await answer(challengeId, expected)

      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({ status: 'verified' })
      expect(await academy.challenges.clearedAt(agent.id, INTERSTITIAL_STAGE)).toBeTruthy()
    }
  })

  it('says what the kind asked for, without disclosing the answer', async () => {
    for (const kind of INTERSTITIAL_KINDS) {
      const { challengeId, agent } = await mintKind(kind.slug)
      const expected = interstitialAnswerFor(challengeId, kind.slug) as string

      const response = await answer(challengeId, 'definitely-wrong')

      expect(response.statusCode).toBe(422)
      expect(response.json().message).not.toContain(expected)
      // A wrong answer costs nothing, and the message says so.
      expect(response.json().message).toMatch(/not lost the attempt/i)
      expect(await academy.challenges.clearedAt(agent.id, INTERSTITIAL_STAGE)).toBeNull()
    }
  })

  it('refuses an answer with no observation, so a broken page stays distinguishable', async () => {
    const { challengeId } = await mintKind('ordered-panels')

    const response = await app.inject({
      method: 'POST',
      url: `/v1/academy/interstitial/${challengeId}/answer`,
      payload: { answer: '0,1,2' },
    })

    expect(response.statusCode).toBe(422)
  })

  it('clears nothing twice', async () => {
    const { challengeId } = await mintKind('ordered-panels')
    const expected = interstitialAnswerFor(challengeId, 'ordered-panels') as string
    await answer(challengeId, expected)

    const again = await answer(challengeId, expected)

    expect(again.statusCode).toBe(409)
  })

  /**
   * **The kind comes from the challenge, never from the request.** A citizen able to name
   * its own kind here would look at all three and answer the easiest, and the record is
   * supposed to say what it was actually given.
   */
  it('grades against the kind the challenge carries, not one the caller prefers', async () => {
    const { challengeId } = await mintKind('marks-above-line')
    const otherKindsAnswer = interstitialAnswerFor(challengeId, 'ordered-panels') as string

    const response = await answer(challengeId, otherKindsAnswer)

    expect(response.statusCode).toBe(422)
    expect(response.json().message).toMatch(/above the line/i)
  })

  it('refuses both doors when the stage is not configured', async () => {
    app = build({
      stageUnavailableReasons: { [INTERSTITIAL_STAGE]: 'INTERSTITIAL_PAGE_URL not set' },
    })
    await app.ready()

    const brief = await app.inject({
      method: 'GET',
      url: '/v1/academy/interstitial/0f2c48a1-9b7e-4d3f-8a62-15c9de704b83',
    })

    expect(brief.statusCode).toBe(500)
    expect(brief.json().message).toContain('INTERSTITIAL_PAGE_URL not set')
  })
})
