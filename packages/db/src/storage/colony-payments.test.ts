import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { LAMPORTS_PER_SOL, type AgentId, type ObservedPayment } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agents, colonyPayments, solanaWalletChallenges } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import * as colonyPaymentsModule from './colony-payments.js'
import {
  colonyPaymentRecorded,
  colonyPaymentsFrom,
  quarantinedPayments,
  recordColonyPayment,
  resolveQuarantinedPayment,
} from './colony-payments.js'

const target = databaseTestTarget()

const COLONY = 'CoLoNyWaLLeTaDdReSs'

/**
 * The way in after D-106 (`#503`).
 *
 * The tests that matter are the ones about **what must not be attributed**:
 * money from an address nobody proved they control, money the Colony sent
 * itself, and a second row for one signature.
 */
describe('a payment to the Colony wallet', () => {
  let db: Database

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
  })

  const anAgent = async (name: string): Promise<AgentId> => {
    const [row] = await db
      .insert(agents)
      .values({ name, platform: 'openclaw', status: 'citizen' })
      .returning({ id: agents.id })
    return row!.id as AgentId
  }

  /** A citizen that has cleared the `solana-wallet` rung with this address. */
  const withVerifiedWallet = async (agentId: AgentId, address: string): Promise<void> => {
    await db.insert(solanaWalletChallenges).values({
      agentId,
      nonce: `nonce-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      address,
      signature: 'a-signature',
      verifiedAt: new Date().toISOString(),
    })
  }

  const aPayment = (overrides: Partial<ObservedPayment> = {}): ObservedPayment => ({
    signature: `sig-${crypto.randomUUID()}`,
    sender: 'a-wallet',
    recipient: COLONY,
    lamports: LAMPORTS_PER_SOL / 100,
    commitment: 'finalized',
    ...overrides,
  })

  it('is attributed to the citizen whose verified wallet sent it', async () => {
    const agentId = await anAgent('Payer')
    await withVerifiedWallet(agentId, 'payer-wallet')

    const outcome = await recordColonyPayment(db, aPayment({ sender: 'payer-wallet' }), COLONY)

    expect(outcome).toEqual({
      outcome: 'attributed',
      agentId,
      lamports: LAMPORTS_PER_SOL / 100,
    })
    expect(await colonyPaymentsFrom(db, agentId)).toHaveLength(1)
  })

  /**
   * An open or failed attempt has proved nothing. Attributing to one would let
   * anybody be paid for naming somebody else's wallet.
   */
  it('is not attributed to a citizen whose attempt at the rung never cleared', async () => {
    const agentId = await anAgent('Unproven')
    await db.insert(solanaWalletChallenges).values({
      agentId,
      nonce: `nonce-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      address: 'claimed-wallet',
      signature: 'a-signature',
    })

    const outcome = await recordColonyPayment(db, aPayment({ sender: 'claimed-wallet' }), COLONY)

    expect(outcome).toEqual({ outcome: 'quarantined', quarantine: 'unverified-sender' })
    expect(await colonyPaymentsFrom(db, agentId)).toHaveLength(0)
  })

  /** Recorded and visible, never dropped and never credited (`#503`). */
  it('quarantines a stranger and leaves a row a maintainer can read', async () => {
    const outcome = await recordColonyPayment(db, aPayment({ sender: 'an-exchange' }), COLONY)
    expect(outcome).toEqual({ outcome: 'quarantined', quarantine: 'unverified-sender' })

    const open = await quarantinedPayments(db)
    expect(open).toHaveLength(1)
    expect(open[0]?.sender).toBe('an-exchange')
    expect(open[0]?.attributedAt).toBeNull()
  })

  /** `#505` pays out of this wallet; a payout must never read back as income. */
  it('quarantines the Colony paying itself, even from an address a citizen verified', async () => {
    const agentId = await anAgent('Colony-ish')
    await withVerifiedWallet(agentId, COLONY)

    const outcome = await recordColonyPayment(db, aPayment({ sender: COLONY }), COLONY)

    expect(outcome).toEqual({ outcome: 'quarantined', quarantine: 'colony-sender' })
    expect(await colonyPaymentsFrom(db, agentId)).toHaveLength(0)
  })

  /** Webhook redelivery is normal operation, and the reconciliation reads the same rows. */
  it('records one row per signature, however often it is told', async () => {
    const agentId = await anAgent('Payer')
    await withVerifiedWallet(agentId, 'payer-wallet')
    const payment = aPayment({ sender: 'payer-wallet' })

    expect((await recordColonyPayment(db, payment, COLONY)).outcome).toBe('attributed')
    expect((await recordColonyPayment(db, payment, COLONY)).outcome).toBe('already-recorded')

    const rows = await db
      .select()
      .from(colonyPayments)
      .where(eq(colonyPayments.signature, payment.signature))
    expect(rows).toHaveLength(1)
  })

  /** A row saying money arrived, for a transfer that can still vanish, is worse than no row. */
  it('writes nothing at all for a transfer that is not finalized', async () => {
    const payment = aPayment({ commitment: 'confirmed' })

    expect((await recordColonyPayment(db, payment, COLONY)).outcome).toBe('not-final')
    expect(await colonyPaymentRecorded(db, payment.signature)).toBe(false)
  })

  it("takes a settled quarantine out of the maintainer's queue and keeps the row", async () => {
    const payment = aPayment({ sender: 'an-exchange' })
    await recordColonyPayment(db, payment, COLONY)

    expect(await resolveQuarantinedPayment(db, payment.signature, 'Returned by hand.')).toBe(true)
    expect(await quarantinedPayments(db)).toHaveLength(0)

    const [row] = await db
      .select()
      .from(colonyPayments)
      .where(eq(colonyPayments.signature, payment.signature))
    expect(row?.resolution).toBe('Returned by hand.')
  })

  it('refuses to settle an attributed payment, which was never a quarantine', async () => {
    const agentId = await anAgent('Payer')
    await withVerifiedWallet(agentId, 'payer-wallet')
    const payment = aPayment({ sender: 'payer-wallet' })
    await recordColonyPayment(db, payment, COLONY)

    expect(await resolveQuarantinedPayment(db, payment.signature, 'Nothing to settle.')).toBe(false)
  })

  /**
   * The property `#506` asks to survive the deposit module's removal, asserted
   * on the exports rather than promised in a comment.
   *
   * **Nothing in this module generates, seals or unseals a key.** The Colony
   * holds one wallet, whose secret is on the deploy host, and no key to anybody
   * else's money. A later change that reintroduces custody fails here rather
   * than in a review.
   */
  it("exports nothing that could hold anybody else's key", () => {
    const forbidden = /keypair|seal|unseal|secret|private|sweep|withdraw|transferout/i

    for (const name of Object.keys(colonyPaymentsModule)) {
      expect(name).not.toMatch(forbidden)
    }
  })
})
