import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { AccountKindSchema, RegisterAgentRequestSchema, type AgentId } from '@kolonie-ai/core'
import { generateApiKey } from '../api-key.js'
import type { Database } from '../client.js'
import { accountOfferOutcomes, accountOffers, accountTransfers, accounts } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import {
  acceptAccountOffer,
  declineAccountOffer,
  deleteExpiredAccountOffers,
  giveAccount,
  withdrawAccountOffer,
} from './account-offers.js'
import { setVaultEntry } from './vault.js'
import { wakeupChanges } from './wakeup.js'

const target = databaseTestTarget()

/** Any 32 bytes. Never a real key, and nothing in this file is a real secret. */
const SEALING_KEY = 'a-test-sealing-key-that-is-long-enough'

/** A fixture, not a credential. */
const FIXTURE_VALUE = 'fixture-value-not-a-credential-0000'

const kind = (value: string) => AccountKindSchema.parse(value)

/**
 * How an offer ended, reaching the citizen that made it (`#1215`).
 *
 * Every terminal path deletes the offer row — an acceptance cascades it with the
 * account, and decline, withdrawal and the sweep delete it outright — so before
 * this the giver's only signal was an account quietly leaving its list, and *row
 * gone* read the same as an acceptance, a bug or a misremembering.
 *
 * The three examples the issue names are the first three tests here. The two
 * after them are the ones that decide whether the channel is honest: an expiry
 * is announced exactly once whether or not anything has swept it yet, and an
 * offer to a handle nobody holds ends indistinguishably from one somebody
 * ignored — which is `giveAccount`'s decision 5, and the whole reason this is a
 * receipt rather than a status.
 */
describe('how an offer ended, in the giver’s digest', () => {
  let db: Database
  let giver: AgentId
  let recipient: AgentId
  let giverToken: string
  let accountId: string

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)

    giverToken = String(generateApiKey())
    giver = await anAgent('giver')
    recipient = await anAgent('recipient')

    const stored = await setVaultEntry(
      db,
      giverToken,
      giver,
      'provider/handle',
      FIXTURE_VALUE,
      'a fixture description, also not a credential',
    )
    expect(stored.outcome).toBe('stored')

    const [row] = await db
      .insert(accounts)
      .values({
        agentId: giver,
        kind: kind('github'),
        identifier: 'a-spare-handle',
        provider: 'example.test',
        proved: true,
        provedAt: sql`now()`,
        vaultKey: 'provider/handle',
      })
      .returning({ id: accounts.id })
    if (row === undefined) throw new Error('inserting an account returned no row')
    accountId = row.id
  })

  const anAgent = async (name: string): Promise<AgentId> => {
    const result = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name, platform: 'openclaw' }),
    )
    if (result.outcome !== 'registered') throw new Error(result.outcome)
    return result.agent.id
  }

  const give = async (to = 'recipient') => {
    const offered = await giveAccount(
      db,
      { fromAgentId: giver, accountId, toHandle: to },
      giverToken,
      SEALING_KEY,
    )
    if (offered.outcome !== 'offered') throw new Error(offered.outcome)
    return offered.offerId
  }

  /** The window is *since a moment*, and every test here opens it wide. */
  const outcomes = async (agentId: AgentId = giver) =>
    (await wakeupChanges(db, agentId, '2000-01-01T00:00:00.000Z')).offerOutcomes

  /**
   * The window heals by the passage of a week, which no surface can produce.
   * Both dates move: `account_offers_expiry_after_creation` refuses a row that
   * lapsed before it was written.
   */
  const ageOut = async () => {
    await db.update(accountOffers).set({
      createdAt: sql`now() - interval '8 days'`,
      expiresAt: sql`now() - interval '1 hour'`,
    })
    await db.update(accountTransfers).set({
      createdAt: sql`now() - interval '8 days'`,
      expiresAt: sql`now() - interval '1 hour'`,
    })
  }

  it('names an acceptance, and the account is gone from the giver’s list', async () => {
    const offerId = await give()
    const taken = await acceptAccountOffer(
      db,
      { offerId, toAgentId: recipient, vaultKey: 'mine/the-account' },
      String(generateApiKey()),
      SEALING_KEY,
    )
    expect(taken.outcome).toBe('accepted')

    expect(await outcomes()).toEqual([
      {
        offerId,
        toHandle: 'recipient',
        accountKind: 'github',
        accountIdentifier: 'a-spare-handle',
        accountProvider: 'example.test',
        outcome: 'accepted',
        at: expect.any(String),
      },
    ])
    // What the receipt describes really did happen: the giver's row is gone.
    expect(await db.select().from(accounts)).toHaveLength(1)
  })

  it('names a decline, with the account still the giver’s', async () => {
    const offerId = await give()
    expect(await declineAccountOffer(db, { offerId, toAgentId: recipient })).toEqual({
      outcome: 'declined',
    })

    expect(await outcomes()).toMatchObject([{ offerId, outcome: 'declined' }])
    // Nothing moved, which is what the recipient chose.
    const [account] = await db.select().from(accounts)
    expect(account).toMatchObject({ agentId: giver, identifier: 'a-spare-handle' })
  })

  it('names an expiry, with the account still the giver’s and the parcel gone', async () => {
    const offerId = await give()
    await ageOut()
    expect(await deleteExpiredAccountOffers(db)).toBe(1)

    expect(await outcomes()).toMatchObject([{ offerId, outcome: 'expired' }])
    expect(await db.select().from(accountTransfers)).toEqual([])
    const [account] = await db.select().from(accounts)
    expect(account).toMatchObject({ agentId: giver })
  })

  it('names a withdrawal, which nobody else is told about', async () => {
    const offerId = await give()
    expect(await withdrawAccountOffer(db, { offerId, fromAgentId: giver })).toEqual({
      outcome: 'withdrawn',
    })

    expect(await outcomes()).toMatchObject([{ offerId, outcome: 'withdrawn' }])
    // The other citizen's digest is where a leak would show, and it is empty.
    expect(await outcomes(recipient)).toEqual([])
  })

  /**
   * Nothing schedules either expiry sweep, so an offer can sit lapsed in
   * `account_offers` indefinitely — and a channel that only spoke when a sweep
   * ran would be silent for exactly as long. The digest reads both places, and
   * the sweep stamps the receipt with `expiresAt` rather than `now()`, so the
   * same expiry carries the same moment from either source: announced once
   * before the sweep, once after, and never twice in one window.
   */
  it('announces a lapsed offer once, before a sweep and after it alike', async () => {
    const offerId = await give()
    await ageOut()

    const unswept = await outcomes()
    expect(unswept).toMatchObject([{ offerId, outcome: 'expired' }])

    expect(await deleteExpiredAccountOffers(db)).toBe(1)

    const swept = await outcomes()
    expect(swept).toEqual(unswept)
  })

  /**
   * Decision 5, on the other side of the transaction: `giveAccount` refuses to
   * say whether a handle is held, and an outcome that distinguished *ignored*
   * from *nobody there* would hand a giver the same answer one wake-up later.
   */
  it('ends an offer to a handle nobody holds exactly as one that was ignored', async () => {
    const held = await give('recipient')
    await ageOut()
    expect(await deleteExpiredAccountOffers(db)).toBe(1)

    const nobody = await give('nobody-answers-to-this')
    await ageOut()
    expect(await deleteExpiredAccountOffers(db)).toBe(1)

    const [first, second] = await outcomes()
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    // Compared field by field: the only two that may differ are the offer's own
    // id, the moment it lapsed, and the handle the giver itself typed.
    for (const key of Object.keys(first!) as (keyof typeof first)[]) {
      if (key === 'offerId' || key === 'toHandle' || key === 'at') continue
      expect(first![key]).toEqual(second![key])
    }
    expect([first!.offerId, second!.offerId].sort()).toEqual([held, nobody].sort())
    expect([first!.toHandle, second!.toHandle].sort()).toEqual(
      ['nobody-answers-to-this', 'recipient'].sort(),
    )
  })

  /** Decision 13's limit, applied to the row that outlives the offer. */
  it('keeps nothing in the receipt that opens the account', async () => {
    const offerId = await give()
    await acceptAccountOffer(
      db,
      { offerId, toAgentId: recipient, vaultKey: 'mine/the-account' },
      String(generateApiKey()),
      SEALING_KEY,
    )

    const everyColumn = JSON.stringify(await db.select().from(accountOfferOutcomes))
    expect(everyColumn).not.toContain(FIXTURE_VALUE)
    expect(everyColumn).not.toContain('provider/handle')
    expect(everyColumn).not.toContain('mine/the-account')
  })

  it('says nothing to a citizen that made no offers', async () => {
    await give()
    expect(await outcomes(recipient)).toEqual([])
  })
})
