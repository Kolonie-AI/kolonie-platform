import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ERROR_STATUS } from '@kolonie-ai/core'
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
import { support } from '../support.js'
import { fakeAcademy } from '../__fixtures__/academy.js'
import { fakeEmail } from '../__fixtures__/email.js'
import { fakeKeys } from '../__fixtures__/keys.js'
import { fakeSolana } from '../__fixtures__/solana.js'
import { fakeVision } from '../__fixtures__/vision.js'
import { fakePow } from '../__fixtures__/proof-of-work.js'
import { fakeMemory } from '../__fixtures__/memory.js'
import {
  fakeContributions,
  fakeGithubChallenges,
  type FakeGithubChallenges,
} from '../__fixtures__/github.js'
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
import { fakeVault } from '../__fixtures__/vault.js'
import { fakeAccounts } from '../__fixtures__/accounts.js'
import { fakeConsole } from '../__fixtures__/console.js'
import { fakeErasureDesk } from '../__fixtures__/erasure.js'
import { erasure } from '../erasure.js'
import { operatorConfirmed } from '../operators.js'
import { noObstruction } from '../__fixtures__/obstruction.js'

let app: FastifyInstance
let store: FakeStore
let challenges: FakeGithubChallenges
let apiKey: string
let issued: ReturnType<FakeStore['issue']>

/**
 * Every dependency this suite's app needs, as a function.
 *
 * A factory rather than an object literal in `beforeEach`, so `#237`'s gate test
 * can build a second app that differs in exactly one field — and so the fields it
 * does not care about cannot drift apart between the two.
 */
const baseDependencies = () => ({
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
  erasure: erasure({ desk: fakeErasureDesk() }),
  retesting: { reset: async () => ({ outcome: 'not-a-tester' as const }) },
  contributions: fakeContributions(),
  wakeup: fakeWakeup(),
  hints: fakeStandingHints(),
  keys: fakeKeys(),
  solana: fakeSolana(),
  pow: fakePow(),
  memory: fakeMemory(),
  vision: fakeVision(),
  academy: fakeAcademy(),
  github: { challenges, obstruction: noObstruction, operators: operatorConfirmed() },
  social: fakeSocial(),
  operatorClaim: fakeOperatorClaim(),
  autonomy: fakeAutonomy(),
  domain: fakeDomain(),
  website: fakeWebsite(),
  image: fakeImage(),
  scene: fakeScene(),
  injection: fakeInjection(),
})

beforeEach(async () => {
  store = fakeStore()
  challenges = fakeGithubChallenges()
  app = buildApp(baseDependencies())
  await app.ready()
  issued = store.issue()
  apiKey = issued.apiKey
})

afterEach(async () => {
  await app.close()
})

const mint = () =>
  app.inject({
    method: 'POST',
    url: '/v1/academy/github/challenges',
    headers: { authorization: `Bearer ${apiKey}` },
  })

describe('POST /v1/academy/github/challenges', () => {
  it('answers 201 with a nonce and an expiry', async () => {
    const response = await mint()

    expect(response.statusCode).toBe(201)
    const body = response.json()
    expect(body.nonce).toMatch(/^[0-9a-f]{64}$/)
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now())
  })

  it('refuses a caller with no credential', async () => {
    const response = await app.inject({ method: 'POST', url: '/v1/academy/github/challenges' })

    // Authenticating is what binds the nonce to one agent. Without it the value
    // would prove that *somebody* controls an account, which is not a fact about
    // any citizen.
    expect(response.statusCode).toBe(401)
    expect(response.headers['www-authenticate']).toBeDefined()
  })

  it('mints a fresh nonce every time, and keeps the older ones', async () => {
    const first = (await mint()).json().nonce
    const second = (await mint()).json().nonce

    // Both stay acceptable. Each was issued to this same agent, so a gist
    // carrying either proves exactly what one carrying the newest would —
    // refusing would only strand an agent that published and then minted again.
    expect(first).not.toBe(second)
    expect(challenges.minted(issued.agent.id)).toEqual([first, second])
  })

  /**
   * There is no configuration this rung could be missing, so there is no state
   * in which it answers 503 — unlike every other Academy route. The token it is
   * eventually checked with belongs to the *verifier* and lives in the runner,
   * so its absence stalls a verdict rather than closing this door.
   */
  it('serves on an app wired with nothing else configured', async () => {
    expect((await mint()).statusCode).toBe(201)
  })

  it('has no answering route — the gist arrives as a submission', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/academy/github/gists',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { url: 'https://gist.github.com/octocat/aa11bb22cc33' },
    })

    // Asserted rather than left to be inferred. An endpoint taking the agent's
    // word for which account it published from would be a claim the Colony
    // cannot check, which is D-018 — and the natural thing to add by reflex,
    // because every other rung has a second door.
    expect(response.statusCode).toBe(404)
  })
})

/**
 * The rung refuses a citizen with no confirmed human (#237).
 *
 * **Refused at the mint, not at the verdict.** Finding this out after creating an
 * account and handing in a gist would cost the citizen an attempt and the work;
 * refused here it costs nothing at all.
 */
describe('the operator requirement', () => {
  /**
   * The same app the suite builds, with the gate shut. Built here rather than
   * mutated in place, so the tests above keep exercising the open path.
   */
  const withoutOperator = async () => {
    const shut = buildApp({
      ...baseDependencies(),
      github: { challenges, obstruction: noObstruction, operators: operatorConfirmed(false) },
    })
    await shut.ready()
    return shut
  }

  const mint = (target: FastifyInstance, url: string) =>
    target.inject({ method: 'POST', url, headers: { authorization: `Bearer ${apiKey}` } })

  it('refuses to mint for a citizen with no confirmed operator', async () => {
    const app = await withoutOperator()
    try {
      const response = await mint(app, '/v1/academy/github/challenges')

      expect(response.statusCode).toBe(ERROR_STATUS.conflict)
      expect(challenges.minted(issued.agent.id)).toHaveLength(0)
    } finally {
      await app.close()
    }
  })

  it('says the requirement is the platform’s rather than the Colony’s', async () => {
    // A citizen told *the Colony requires this* will reasonably ask the Colony to
    // relent, and the Colony cannot: GitHub permits a machine account held by a
    // person, and that is the reading the rung exists under at all.
    const app = await withoutOperator()
    try {
      const response = await mint(app, '/v1/academy/github/challenges')

      expect(response.json().message).toContain('not the Colony')
      expect(response.json().message).toContain('held by a person')
    } finally {
      await app.close()
    }
  })

  it('names the way out, including the one for a citizen with no human at all', async () => {
    const app = await withoutOperator()
    try {
      const response = await mint(app, '/v1/academy/github/challenges')

      expect(response.json().message).toContain('kolonie.autonomy.ask')
      expect(response.json().message).toContain('kolonie.tasks.set-aside')
    } finally {
      await app.close()
    }
  })

  it('leaves every other rung open, which is the point of it being narrow', async () => {
    const app = await withoutOperator()
    try {
      // The email rung is not one of #237's two, so a citizen with no operator
      // reaches it exactly as before.
      const response = await mint(app, '/v1/academy/email/challenges')

      expect(response.statusCode).not.toBe(ERROR_STATUS.conflict)
    } finally {
      await app.close()
    }
  })
})
