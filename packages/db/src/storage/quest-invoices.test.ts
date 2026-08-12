import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { LAMPORTS_PER_SOL, type AgentId, type ObservedPayment, type TaskId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agentSkills, agents, solanaWalletChallenges, tasks } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { recordColonyPayment } from './colony-payments.js'
import { expireUnpaidQuests, outstandingInvoice } from './quest-invoices.js'

const target = databaseTestTarget()

const COLONY = 'CoLoNyWaLLeTaDdReSs'
const PRICE = LAMPORTS_PER_SOL / 100

/**
 * A sponsor's payment meeting the quest it was for — D-106 (`#504`).
 *
 * The tests that matter are the ones about **what the sponsor does not get
 * back**: an over-payment, a part payment on a quest that expires, and a payment
 * from an address nobody verified.
 */
describe('a quest waiting for its invoice', () => {
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

  const aSponsor = async (name: string, wallet: string): Promise<AgentId> => {
    const [row] = await db
      .insert(agents)
      .values({ name, platform: 'openclaw', status: 'citizen' })
      .returning({ id: agents.id })
    const agentId = row!.id as AgentId

    await db.insert(solanaWalletChallenges).values({
      agentId,
      nonce: `nonce-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      address: wallet,
      signature: 'a-signature',
      verifiedAt: new Date().toISOString(),
    })

    return agentId
  }

  const aWaitingQuest = async (
    sponsorId: AgentId,
    invoiceLamports: number,
    waitingSince = new Date().toISOString(),
  ): Promise<TaskId> => {
    const [row] = await db
      .insert(tasks)
      .values({
        kind: 'quest',
        type: `quest-${crypto.randomUUID()}`,
        title: 'A quest',
        description: 'Do the thing and say how it went.',
        instructions: 'Do the thing.',
        // Priced in lamports and not in credits, which is what D-106 replaces.
        rewardReputation: 5,
        timeoutHours: 24,
        expiresAt: '2026-12-31T00:00:00.000Z',
        status: 'awaiting_payment',
        createdBy: sponsorId,
        slots: 10,
        rewardLamports: PRICE,
        invoiceLamports,
        awaitingPaymentSince: waitingSince,
      })
      .returning({ id: tasks.id })

    return row!.id as TaskId
  }

  const pay = async (sender: string, lamports: number): Promise<ObservedPayment> => {
    const payment: ObservedPayment = {
      signature: `sig-${crypto.randomUUID()}`,
      sender,
      recipient: COLONY,
      lamports,
      commitment: 'finalized',
    }
    await recordColonyPayment(db, payment, COLONY)
    return payment
  }

  const statusOf = async (taskId: TaskId): Promise<string> => {
    const [row] = await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId))
    return row!.status
  }

  it('goes live when the invoice is paid in full', async () => {
    const sponsorId = await aSponsor('Payer', 'payer-wallet')
    const taskId = await aWaitingQuest(sponsorId, PRICE * 10)

    await pay('payer-wallet', PRICE * 10)

    expect(await statusOf(taskId)).toBe('active')
    expect(await outstandingInvoice(db, taskId)).toBeUndefined()
  })

  /** A sponsor whose wallet cannot cover the invoice in one transaction is not stuck. */
  it('accumulates part payments and stays invisible until they add up', async () => {
    const sponsorId = await aSponsor('Payer', 'payer-wallet')
    const taskId = await aWaitingQuest(sponsorId, PRICE * 10)

    await pay('payer-wallet', PRICE * 4)
    expect(await statusOf(taskId)).toBe('awaiting_payment')
    expect(await outstandingInvoice(db, taskId)).toEqual({
      invoiceLamports: PRICE * 10,
      paidLamports: PRICE * 4,
    })

    await pay('payer-wallet', PRICE * 6)
    expect(await statusOf(taskId)).toBe('active')
  })

  /** Kept, and it does not buy capacity a steward never reviewed. */
  it('keeps an over-payment and does not extend the quest', async () => {
    const sponsorId = await aSponsor('Payer', 'payer-wallet')
    const taskId = await aWaitingQuest(sponsorId, PRICE * 10)

    const outcome = await recordColonyPayment(
      db,
      {
        signature: `sig-${crypto.randomUUID()}`,
        sender: 'payer-wallet',
        recipient: COLONY,
        lamports: PRICE * 25,
        commitment: 'finalized',
      },
      COLONY,
    )

    expect(outcome.outcome).toBe('attributed')
    expect(outcome.outcome === 'attributed' && outcome.invoice).toMatchObject({
      applied: PRICE * 10,
      surplus: PRICE * 15,
      settled: true,
    })

    const [row] = await db
      .select({ paid: tasks.paidLamports, slots: tasks.slots })
      .from(tasks)
      .where(eq(tasks.id, taskId))
    expect(row).toEqual({ paid: PRICE * 10, slots: 10 })
  })

  /**
   * Attribution is by sender and a transfer carries no reference to a quest, so
   * *which one* has to be answered by a rule rather than by the sponsor.
   */
  it('pays the oldest waiting quest first, and only that one', async () => {
    const sponsorId = await aSponsor('Payer', 'payer-wallet')
    const older = await aWaitingQuest(sponsorId, PRICE * 10, '2026-08-01T00:00:00.000Z')
    const newer = await aWaitingQuest(sponsorId, PRICE * 10, '2026-08-05T00:00:00.000Z')

    await pay('payer-wallet', PRICE * 30)

    expect(await statusOf(older)).toBe('active')
    expect(await statusOf(newer)).toBe('awaiting_payment')
  })

  /** Paying is the proof, and a part payment is still a transaction that left. */
  it('grants the transfer skill on the first payment, once', async () => {
    const sponsorId = await aSponsor('Payer', 'payer-wallet')
    await aWaitingQuest(sponsorId, PRICE * 10)

    await pay('payer-wallet', PRICE)
    await pay('payer-wallet', PRICE)

    const held = await db
      .select({ skill: agentSkills.skill })
      .from(agentSkills)
      .where(eq(agentSkills.agentId, sponsorId))

    expect(held).toEqual([{ skill: 'transfer' }])
  })

  /**
   * **What a sponsor polls has to move when its money lands** (`#760`).
   *
   * `updated_at` was the moment the quest was invoiced, so a part payment that
   * was credited correctly left the row reading exactly as it had before the
   * transfer — and a sponsor topping up in two goes had no way to confirm the
   * first half counted before sending the second. Both shapes are asserted
   * because only the settling one moved anything else about the row.
   */
  it('moves the timestamp on a part payment and on the one that settles', async () => {
    const sponsorId = await aSponsor('Payer', 'payer-wallet')
    const taskId = await aWaitingQuest(sponsorId, PRICE * 10)

    // Stamped back rather than compared against a sibling statement's `now()`:
    // what is being asserted is that the column was written at all.
    const stale = '2026-08-01T00:00:00.000Z'
    const staleAgain = async () =>
      db.update(tasks).set({ updatedAt: stale }).where(eq(tasks.id, taskId))
    const updatedAtOf = async () => {
      const [row] = await db
        .select({ updatedAt: tasks.updatedAt })
        .from(tasks)
        .where(eq(tasks.id, taskId))
      return new Date(row!.updatedAt).toISOString()
    }

    await staleAgain()
    await pay('payer-wallet', PRICE * 4)
    expect(await statusOf(taskId)).toBe('awaiting_payment')
    expect(await updatedAtOf()).not.toBe(stale)

    await staleAgain()
    await pay('payer-wallet', PRICE * 6)
    expect(await statusOf(taskId)).toBe('active')
    expect(await updatedAtOf()).not.toBe(stale)
  })

  /** Money with no invoice to meet is kept, exactly as an over-payment is. */
  it('keeps a payment from a sponsor with nothing waiting', async () => {
    const sponsorId = await aSponsor('Payer', 'payer-wallet')

    const outcome = await recordColonyPayment(
      db,
      {
        signature: `sig-${crypto.randomUUID()}`,
        sender: 'payer-wallet',
        recipient: COLONY,
        lamports: PRICE,
        commitment: 'finalized',
      },
      COLONY,
    )

    expect(outcome.outcome === 'attributed' && outcome.invoice).toEqual({
      taskId: null,
      applied: 0,
      surplus: PRICE,
      settled: false,
    })
    expect(sponsorId).toBeDefined()
  })

  describe('when nobody pays', () => {
    it('returns the quest to draft after seven days and forfeits the part payment', async () => {
      const sponsorId = await aSponsor('Payer', 'payer-wallet')
      const taskId = await aWaitingQuest(sponsorId, PRICE * 10, '2026-08-01T00:00:00.000Z')
      await pay('payer-wallet', PRICE * 3)

      const expired = await expireUnpaidQuests(db, new Date('2026-08-08T00:00:01.000Z'))

      expect(expired).toEqual([{ taskId, forfeited: PRICE * 3 }])
      expect(await statusOf(taskId)).toBe('draft')

      // Reset with the status: a quest resubmitted later starts from nothing
      // rather than carrying a credit nobody agreed to.
      const [row] = await db
        .select({ paid: tasks.paidLamports, invoice: tasks.invoiceLamports })
        .from(tasks)
        .where(eq(tasks.id, taskId))
      expect(row).toEqual({ paid: 0, invoice: null })
    })

    it('leaves a quest that is still inside its seven days alone', async () => {
      const sponsorId = await aSponsor('Payer', 'payer-wallet')
      const taskId = await aWaitingQuest(sponsorId, PRICE * 10, '2026-08-01T00:00:00.000Z')

      expect(await expireUnpaidQuests(db, new Date('2026-08-07T23:59:59.000Z'))).toEqual([])
      expect(await statusOf(taskId)).toBe('awaiting_payment')
    })
  })

  /** The sender has to be somebody the Colony can name, or nothing happens. */
  it('leaves the quest waiting when the payment came from an unverified address', async () => {
    const sponsorId = await aSponsor('Payer', 'payer-wallet')
    const taskId = await aWaitingQuest(sponsorId, PRICE * 10)

    await pay('an-exchange-hot-wallet', PRICE * 10)

    expect(await statusOf(taskId)).toBe('awaiting_payment')
  })
})
