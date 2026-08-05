import { fakeArtefactChallenges } from '../__fixtures__/artefact.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { SPL_TOKEN_PROGRAM, USDC_MINT } from '@kolonie-ai/core'
import { buildApp } from '../app.js'
import { fakeRegistry } from '../__fixtures__/registry.js'
import { fakeStore, type FakeStore } from '../__fixtures__/store.js'
import { fakeCatalogue } from '../__fixtures__/catalogue.js'
import { fakeQuests } from '../__fixtures__/quests.js'
import { aTransfer, fakeChain, fakeDeposits, fakeWatcher } from '../__fixtures__/deposits.js'
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
import { fakeVault } from '../__fixtures__/vault.js'
import { fakeAccounts } from '../__fixtures__/accounts.js'
import { fakeConsole } from '../__fixtures__/console.js'
import { fakeErasureDesk } from '../__fixtures__/erasure.js'
import { erasure } from '../erasure.js'
import { noObstruction } from '../__fixtures__/obstruction.js'
import {
  reconcileDeposits,
  webhookAuthorised,
  type DepositDesk,
  type DepositWatcher,
} from '../deposits.js'

const SECRET = 'a-webhook-secret'

let app: FastifyInstance
let store: FakeStore
let desk: ReturnType<typeof fakeDeposits>
let apiKey: string
let agentId: string

/**
 * `null` and not `undefined` for *no secret*: an explicit `undefined` argument
 * takes the default parameter, which is how the first version of this test
 * built a configured app and asserted it was unconfigured.
 */
const build = (webhookSecret: string | null = SECRET, watcher?: DepositWatcher) => {
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
    deposits: {
      desk,
      ...(webhookSecret !== null && { webhookSecret }),
      ...(watcher !== undefined && { watcher }),
    },
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
  })
}

beforeEach(async () => {
  app = build()
  await app.ready()
  const issued = store.issue({})
  apiKey = String(issued.apiKey)
  agentId = String(issued.agent.id)
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

  /**
   * `#266`: an account opened from the console gets no funding channel until
   * somebody has read the mail sent to its address. This is the on-chain half —
   * no address means no transfer can arrive, which is the only point at which
   * refusing costs nothing.
   */
  it('hands out no address before the sign-up address is confirmed', async () => {
    desk.leaveUnconfirmed(agentId as never)

    const response = await askForAddress()

    expect(response.statusCode).toBe(409)
    expect(response.json().message).toContain('confirmed')
    // Authenticated and refused: this is a fact about the account, not the key.
    expect(response.json().code).toBe('conflict')
  })
})

/**
 * The webhook, against what Helius actually sends (`#321`).
 *
 * These tests are built rather than reusing the app `beforeEach` made, because
 * the route now needs a chain to ask and the watcher is wired at build time.
 * The delivery names a signature; what is credited is what the chain says that
 * signature moved.
 */
describe('POST /v1/deposits/webhook', () => {
  let chain: ReturnType<typeof fakeChain>
  let configured: FastifyInstance
  let address: string

  /** An enhanced Helius delivery, in the shape the sender posts it. */
  const aDelivery = (signature: string, toUserAccount: string): unknown => [
    {
      signature,
      slot: 300_000_000,
      timestamp: 1_770_000_000,
      type: 'TRANSFER',
      tokenTransfers: [
        {
          fromUserAccount: 'a-payer',
          toUserAccount,
          mint: USDC_MINT,
          tokenAmount: 10,
          tokenStandard: 'Fungible',
        },
      ],
    },
  ]

  const post = (body: unknown, secret: string | null = SECRET) =>
    configured.inject({
      method: 'POST',
      url: '/v1/deposits/webhook',
      headers: {
        'content-type': 'application/json',
        ...(secret !== null && { authorization: secret }),
      },
      payload: body as never,
    })

  beforeEach(async () => {
    chain = fakeChain()
    configured = build(SECRET, chain)
    await configured.ready()

    const key = String(store.issue({}).apiKey)
    address = (
      await configured.inject({
        method: 'POST',
        url: '/v1/deposits/address',
        headers: { authorization: `Bearer ${key}` },
      })
    ).json().address
  })

  afterEach(async () => {
    await configured.close()
  })

  it('credits what the chain says the delivered signature moved', async () => {
    chain.put(aTransfer({ address, signature: 'a-signature' }))

    const delivered = await post(aDelivery('a-signature', address))

    expect(delivered.statusCode).toBe(200)
    expect(delivered.json()).toEqual({
      claims: 1,
      ignored: 0,
      credited: 1,
      rejected: 0,
      unverified: 0,
    })
  })

  /**
   * The defect this issue records: `#219` validated the body against
   * `ObservedTransferSchema`, and no observer emits that shape. A Helius
   * webhook pointed at this route answered `422` forever.
   */
  it('refuses the flat six-field shape nothing ever sent', async () => {
    expect((await post(aTransfer({ address }))).statusCode).toBe(422)
  })

  it('refuses a body that is not a delivery at all', async () => {
    expect((await post({ signature: 'only-this' })).statusCode).toBe(422)
  })

  /**
   * The delivery carries neither a token program nor a commitment, so this is
   * the case that could not be reached at all before: the chain is asked, and
   * it answers with some other mint.
   */
  it('records a transfer of some other SPL token, and credits nothing', async () => {
    chain.put(aTransfer({ address, signature: 'a-signature', mint: 'some-other-mint' }))

    const delivered = await post(aDelivery('a-signature', address))

    expect(delivered.json()).toMatchObject({ credited: 0, rejected: 1 })
    expect(desk.seen()[0]).toMatchObject({ rejection: 'wrong-mint', credits: 0 })
  })

  it('answers 200 to a redelivery rather than teaching the sender to retry', async () => {
    chain.put(aTransfer({ address, signature: 'a-signature' }))

    expect((await post(aDelivery('a-signature', address))).json()).toMatchObject({ credited: 1 })
    const again = await post(aDelivery('a-signature', address))

    expect(again.statusCode).toBe(200)
    expect(again.json()).toMatchObject({ credited: 0, rejected: 0, unverified: 0 })
    expect(desk.seen()).toHaveLength(1)
  })

  /**
   * Whoever holds the secret chooses which addresses a delivery names. A row
   * per named stranger would let the sender fill the deposits table.
   */
  it('ignores an address the Colony never generated, without asking the chain', async () => {
    const delivered = await post(aDelivery('a-signature', 'an-address-of-somebody-elses'))

    expect(delivered.json()).toMatchObject({ claims: 1, ignored: 1, credited: 0 })
    expect(chain.asked()).toEqual([])
    expect(desk.seen()).toEqual([])
  })

  /** A webhook fires the moment a transaction lands; finalization comes later. */
  it('leaves a signature the chain has not finalized to the reconciliation', async () => {
    const delivered = await post(aDelivery('not-final-yet', address))

    expect(delivered.statusCode).toBe(200)
    expect(delivered.json()).toMatchObject({ unverified: 1, credited: 0 })
    expect(desk.seen()).toEqual([])
  })

  it('counts a delivery it cannot verify rather than failing the sender', async () => {
    chain.put(aTransfer({ address, signature: 'a-signature' }))
    chain.breakAt('a-signature')

    const delivered = await post(aDelivery('a-signature', address))

    expect(delivered.statusCode).toBe(200)
    expect(delivered.json()).toMatchObject({ unverified: 1, credited: 0 })
  })

  /**
   * A deployment with a webhook and no RPC endpoint credits nothing promptly
   * and loses nothing: kolonie-infra#72's hourly pass is what catches these.
   */
  it('verifies nothing when no chain is configured, and writes nothing', async () => {
    const noChain = build(SECRET)
    await noChain.ready()

    const delivered = await noChain.inject({
      method: 'POST',
      url: '/v1/deposits/webhook',
      headers: { 'content-type': 'application/json', authorization: SECRET },
      payload: aDelivery('a-signature', address) as never,
    })

    expect(delivered.statusCode).toBe(200)
    expect(delivered.json()).toMatchObject({ claims: 1, unverified: 1, credited: 0 })

    await noChain.close()
  })

  it('reads one signature once, however many hops it names', async () => {
    chain.put(aTransfer({ address, signature: 'a-signature' }))

    await post([
      {
        signature: 'a-signature',
        tokenTransfers: [{ toUserAccount: address }, { toUserAccount: address }],
      },
    ])

    expect(chain.asked()).toEqual(['a-signature'])
  })

  it('refuses a delivery with the wrong secret, or none', async () => {
    chain.put(aTransfer({ address, signature: 'a-signature' }))

    expect((await post(aDelivery('a-signature', address), 'wrong')).statusCode).toBe(401)
    expect((await post(aDelivery('a-signature', address), null)).statusCode).toBe(401)
    expect(desk.seen()).toEqual([])
  })

  it('is not mounted at all without a secret', async () => {
    const unconfigured = build(null)
    await unconfigured.ready()

    const response = await unconfigured.inject({
      method: 'POST',
      url: '/v1/deposits/webhook',
      headers: { 'content-type': 'application/json' },
      payload: aDelivery('a-signature', address) as never,
    })

    expect(response.statusCode).toBe(404)
    await unconfigured.close()
  })

  it('compares the secret in constant time', () => {
    expect(webhookAuthorised(SECRET, SECRET)).toBe(true)
    expect(webhookAuthorised('a-webhook-secre', SECRET)).toBe(false)
    expect(webhookAuthorised(undefined, SECRET)).toBe(false)
  })
})

describe('POST /v1/deposits/reconcile', () => {
  const run = (secret: string = SECRET) =>
    app.inject({
      method: 'POST',
      url: '/v1/deposits/reconcile',
      headers: { authorization: secret },
    })

  it('credits what the webhook missed and says what it recovered', async () => {
    // The watcher is wired at build time, so this app is built rather than
    // reusing the one `beforeEach` made — and its address is asked for on
    // itself, because the desk is the app's own.
    const watched: string[] = []
    const configured = build(
      SECRET,
      fakeWatcher({
        transfersAt: async (address) => {
          watched.push(address)
          return [aTransfer({ address })]
        },
      }),
    )
    await configured.ready()

    const key = String(store.issue({}).apiKey)
    await configured.inject({
      method: 'POST',
      url: '/v1/deposits/address',
      headers: { authorization: `Bearer ${key}` },
    })

    const response = await configured.inject({
      method: 'POST',
      url: '/v1/deposits/reconcile',
      headers: { authorization: SECRET },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ addresses: 1, credited: 1, recovered: 1, failed: 0 })
    expect(watched).toHaveLength(1)

    await configured.close()
  })

  it('credits nothing twice when it is run again', async () => {
    const configured = build(
      SECRET,
      fakeWatcher({
        transfersAt: async (address) => [aTransfer({ address, signature: 'the-same-one' })],
      }),
    )
    await configured.ready()

    const key = String(store.issue({}).apiKey)
    await configured.inject({
      method: 'POST',
      url: '/v1/deposits/address',
      headers: { authorization: `Bearer ${key}` },
    })

    const reconcile = () =>
      configured.inject({
        method: 'POST',
        url: '/v1/deposits/reconcile',
        headers: { authorization: SECRET },
      })

    expect((await reconcile()).json()).toMatchObject({ credited: 1, recovered: 1 })
    // The second pass sees the same signature and the unique index holds.
    expect((await reconcile()).json()).toMatchObject({ credited: 0, recovered: 0 })

    await configured.close()
  })

  it('refuses a caller with the wrong secret, or none', async () => {
    expect((await run('wrong')).statusCode).toBe(401)
    expect((await app.inject({ method: 'POST', url: '/v1/deposits/reconcile' })).statusCode).toBe(
      401,
    )
  })

  it('is not mounted at all without a secret, like the webhook it shares', async () => {
    const unconfigured = build(null)
    await unconfigured.ready()

    expect(
      (await unconfigured.inject({ method: 'POST', url: '/v1/deposits/reconcile' })).statusCode,
    ).toBe(404)

    await unconfigured.close()
  })

  it('answers zeros rather than an error when no RPC endpoint is configured', async () => {
    const response = await run()

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ addresses: 0, credited: 0, recovered: 0, failed: 0 })
  })
})

describe('the reconciliation', () => {
  it('credits what the webhook missed, through the same path', async () => {
    const { address } = (await askForAddress()).json()
    const missed = aTransfer({ address })

    const outcome = await reconcileDeposits({
      desk,
      watcher: fakeWatcher({ transfersAt: async () => [missed] }),
    })

    expect(outcome.recovered).toBe(1)
    expect(desk.seen()[0]?.signature).toBe(missed.signature)
  })

  it('credits nothing twice when the webhook did not miss it', async () => {
    // Through the route rather than through the desk, because the claim being
    // made is that the two paths share their idempotency.
    const chain = fakeChain()
    const configured = build(SECRET, chain)
    await configured.ready()

    const key = String(store.issue({}).apiKey)
    const address = (
      await configured.inject({
        method: 'POST',
        url: '/v1/deposits/address',
        headers: { authorization: `Bearer ${key}` },
      })
    ).json().address

    const delivered = aTransfer({ address, signature: 'a-signature' })
    chain.put(delivered)
    await configured.inject({
      method: 'POST',
      url: '/v1/deposits/webhook',
      headers: { 'content-type': 'application/json', authorization: SECRET },
      payload: [
        { signature: 'a-signature', tokenTransfers: [{ toUserAccount: address }] },
      ] as never,
    })

    const outcome = await reconcileDeposits({
      desk,
      watcher: fakeWatcher({ transfersAt: async () => [delivered] }),
    })

    // Seen, not recovered: the same idempotency the webhook relies on.
    expect(outcome.recovered).toBe(0)
    expect(desk.seen()).toHaveLength(1)

    await configured.close()
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
      watcher: fakeWatcher({
        transfersAt: async (address) => {
          if (address === 'one') throw new Error('the endpoint is down')
          return []
        },
      }),
    })

    expect(outcome.addresses).toBe(2)
    expect(outcome.failed).toBe(1)
  })
})
