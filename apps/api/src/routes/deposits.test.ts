import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { SPL_TOKEN_PROGRAM, USDC_MINT } from '@kolonie-ai/core'
import { buildApp } from '../app.js'
import { fakeRegistry } from '../__fixtures__/registry.js'
import { fakeStore, type FakeStore } from '../__fixtures__/store.js'
import { fakeCatalogue } from '../__fixtures__/catalogue.js'
import { fakeQuests } from '../__fixtures__/quests.js'
import { aTransfer, fakeDeposits } from '../__fixtures__/deposits.js'
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
import { reconcileDeposits, webhookAuthorised, type DepositDesk } from '../deposits.js'

const SECRET = 'a-webhook-secret'

let app: FastifyInstance
let store: FakeStore
let desk: ReturnType<typeof fakeDeposits>
let apiKey: string

/**
 * `null` and not `undefined` for *no secret*: an explicit `undefined` argument
 * takes the default parameter, which is how the first version of this test
 * built a configured app and asserted it was unconfigured.
 */
const build = (webhookSecret: string | null = SECRET) => {
  store = fakeStore()
  desk = fakeDeposits()
  return buildApp({
    vault: { vault: fakeVault() },
    accounts: fakeAccounts(),
    console: fakeConsole(),
    email: fakeEmail(),
    registry: fakeRegistry(),
    store,
    catalogue: fakeCatalogue(),
    quests: fakeQuests(),
    deposits: { desk, ...(webhookSecret !== null && { webhookSecret }) },
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
}

beforeEach(async () => {
  app = build()
  await app.ready()
  apiKey = String(store.issue({}).apiKey)
})

afterEach(async () => {
  await app.close()
})

const askForAddress = (key = apiKey) =>
  app.inject({
    method: 'POST',
    url: '/v1/deposits/address',
    headers: { authorization: `Bearer ${key}` },
  })

/** A delivery with no `Authorization` at all, which is its own case. */
const deliverWithoutSecret = (body: unknown) =>
  app.inject({
    method: 'POST',
    url: '/v1/deposits/webhook',
    headers: { 'content-type': 'application/json' },
    payload: body as never,
  })

const deliver = (body: unknown, secret: string = SECRET) =>
  app.inject({
    method: 'POST',
    url: '/v1/deposits/webhook',
    headers: {
      'content-type': 'application/json',
      authorization: secret,
    },
    payload: body as never,
  })

describe('POST /v1/deposits/address', () => {
  it('hands back one address, with the asset it credits and the notice', async () => {
    const first = await askForAddress()
    const second = await askForAddress()

    expect(first.statusCode).toBe(200)
    expect(first.json().address).toBe(second.json().address)
    expect(first.json().mint).toBe(USDC_MINT)
    expect(first.json().tokenProgram).toBe(SPL_TOKEN_PROGRAM)
    expect(first.json().commitment).toBe('finalized')
    // Said before the sponsor deposits, because it cannot be undone afterwards.
    expect(first.json().notice).toContain('cannot be sent back out')
  })

  it('refuses a caller with no credential', async () => {
    const response = await app.inject({ method: 'POST', url: '/v1/deposits/address' })

    expect(response.statusCode).toBe(401)
  })
})

describe('POST /v1/deposits/webhook', () => {
  it('credits a finalized USDC transfer to the address it landed at', async () => {
    const { address } = (await askForAddress()).json()

    const delivered = await deliver(aTransfer({ address }))

    expect(delivered.statusCode).toBe(200)
    expect(delivered.json()).toEqual({ outcome: 'credited' })
  })

  it('answers 200 to a redelivery rather than teaching the sender to retry', async () => {
    const { address } = (await askForAddress()).json()
    const transfer = aTransfer({ address })

    await deliver(transfer)
    const again = await deliver(transfer)

    expect(again.statusCode).toBe(200)
    expect(again.json()).toEqual({ outcome: 'already-recorded' })
  })

  it('refuses a delivery with the wrong secret, or none', async () => {
    const { address } = (await askForAddress()).json()

    expect((await deliver(aTransfer({ address }), 'wrong')).statusCode).toBe(401)
    expect((await deliverWithoutSecret(aTransfer({ address }))).statusCode).toBe(401)
    expect(desk.seen()).toEqual([])
  })

  it('is not mounted at all without a secret', async () => {
    const unconfigured = build(null)
    await unconfigured.ready()

    const response = await unconfigured.inject({
      method: 'POST',
      url: '/v1/deposits/webhook',
      headers: { 'content-type': 'application/json' },
      payload: aTransfer() as never,
    })

    expect(response.statusCode).toBe(404)
    await unconfigured.close()
  })

  it('refuses a body that is not a transfer', async () => {
    expect((await deliver({ signature: 'only-this' })).statusCode).toBe(422)
  })

  it('compares the secret in constant time', () => {
    expect(webhookAuthorised(SECRET, SECRET)).toBe(true)
    expect(webhookAuthorised('a-webhook-secre', SECRET)).toBe(false)
    expect(webhookAuthorised(undefined, SECRET)).toBe(false)
  })
})

describe('the reconciliation', () => {
  it('credits what the webhook missed, through the same path', async () => {
    const { address } = (await askForAddress()).json()
    const missed = aTransfer({ address })

    const outcome = await reconcileDeposits({
      desk,
      watcher: { transfersAt: async () => [missed] },
    })

    expect(outcome.recovered).toBe(1)
    expect(desk.seen()[0]?.signature).toBe(missed.signature)
  })

  it('credits nothing twice when the webhook did not miss it', async () => {
    const { address } = (await askForAddress()).json()
    const delivered = aTransfer({ address })
    await deliver(delivered)

    const outcome = await reconcileDeposits({
      desk,
      watcher: { transfersAt: async () => [delivered] },
    })

    // Seen, not recovered: the same idempotency the webhook relies on.
    expect(outcome.recovered).toBe(0)
    expect(desk.seen()).toHaveLength(1)
  })

  it('does not run at all without a watcher, rather than throwing on a schedule', async () => {
    expect(await reconcileDeposits({ desk })).toEqual({
      addresses: 0,
      credited: 0,
      recovered: 0,
      failed: 0,
    })
  })

  it('keeps going when one address cannot be read', async () => {
    await askForAddress()
    const failing: DepositDesk = { ...desk, watched: async () => ['one', 'two'] }

    const outcome = await reconcileDeposits({
      desk: failing,
      watcher: {
        transfersAt: async (address) => {
          if (address === 'one') throw new Error('the endpoint is down')
          return []
        },
      },
    })

    expect(outcome.addresses).toBe(2)
    expect(outcome.failed).toBe(1)
  })
})
