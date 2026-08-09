import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { QUEST_MAX_SLOTS, type AgentId, type TaskId } from '@kolonie-ai/core'
import type { Database } from '../../client.js'
import { agents, tasks } from '../../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../../testing.js'
import { applyPaymentToInvoice } from '../quest-invoices.js'
import { topUpQuest } from './write.js'

const target = databaseTestTarget()

/**
 * `#629` — a sponsor buys more places on a quest that is already running.
 *
 * **The property worth a real database is the one a fake cannot have**: that
 * capacity and the money for it never move apart. Between *I want three more*
 * and the lamports arriving there is a window, and a test that stubbed the
 * payment would step over exactly the state this issue is about.
 */
describe('buying more places on a running quest', () => {
  let db: Database
  let sponsorId: AgentId
  let strangerId: AgentId

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  const anAgent = async (handle: string): Promise<AgentId> => {
    const [row] = await db
      .insert(agents)
      .values({ name: handle, platform: 'openclaw', status: 'citizen' })
      .returning({ id: agents.id })
    return row!.id as AgentId
  }

  beforeEach(async () => {
    await truncateAll(db)
    sponsorId = await anAgent('sponsor')
    strangerId = await anAgent('stranger')
  })

  const aQuest = async (overrides: Record<string, unknown> = {}): Promise<TaskId> => {
    const [row] = await db
      .insert(tasks)
      .values({
        type: 'quest-report',
        kind: 'quest',
        title: 'A thousand registrations',
        description: 'What this quest is.',
        instructions: 'Register and report.',
        rewardLamports: 1_000_000,
        rewardReputation: 1,
        slots: 3,
        createdBy: sponsorId,
        timeoutHours: 24,
        status: 'active' as const,
        expiresAt: '2026-08-20T12:00:00.000Z',
        invoiceLamports: 3_750_000,
        paidLamports: 3_750_000,
        ...overrides,
      })
      .returning({ id: tasks.id })
    return row!.id as TaskId
  }

  const readQuest = async (taskId: TaskId) => {
    const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId))
    return row!
  }

  it('records the places and what they cost, without offering them yet', async () => {
    const taskId = await aQuest()

    const result = await topUpQuest(db, { sponsorId, taskId, slots: 3 })

    expect(result.outcome).toBe('bought')
    const row = await readQuest(taskId)
    // The places are bought and not yet answerable: capacity is untouched.
    expect(row.slots).toBe(3)
    expect(row.pendingSlots).toBe(3)
    // Three more answers at the price this quest already carries, and nothing
    // for the obstacle pool — the discovery cost does not scale with capacity.
    expect(row.invoiceLamports).toBe(3_750_000 + 3_000_000)
  })

  it('adds them when the payment settles, in the transaction that books it', async () => {
    const taskId = await aQuest()
    await topUpQuest(db, { sponsorId, taskId, slots: 3 })

    await db.transaction(async (tx) => {
      await applyPaymentToInvoice(tx, { sponsorId, lamports: 3_000_000 })
    })

    const row = await readQuest(taskId)
    expect(row.slots).toBe(6)
    expect(row.pendingSlots).toBeNull()
    expect(row.paidLamports).toBe(6_750_000)
    // It never entered `awaiting_payment`, so the citizens answering the first
    // three places never saw it leave the board.
    expect(row.status).toBe('active')
  })

  /** Half of a purchase is half a place, and there is no such thing. */
  it('adds nothing on a part payment', async () => {
    const taskId = await aQuest()
    await topUpQuest(db, { sponsorId, taskId, slots: 3 })

    await db.transaction(async (tx) => {
      await applyPaymentToInvoice(tx, { sponsorId, lamports: 1_000_000 })
    })

    const row = await readQuest(taskId)
    expect(row.slots).toBe(3)
    expect(row.pendingSlots).toBe(3)
    expect(row.paidLamports).toBe(4_750_000)
  })

  it('changes nothing else about the quest', async () => {
    const taskId = await aQuest()
    const before = await readQuest(taskId)

    await topUpQuest(db, { sponsorId, taskId, slots: 5 })
    await db.transaction(async (tx) => {
      await applyPaymentToInvoice(tx, { sponsorId, lamports: 5_000_000 })
    })
    const after = await readQuest(taskId)

    expect(after.rewardLamports).toBe(before.rewardLamports)
    expect(after.expiresAt).toBe(before.expiresAt)
    expect(after.questions).toEqual(before.questions)
    expect(after.proofVerifier).toBe(before.proofVerifier)
    expect(after.publishObstacles).toBe(before.publishObstacles)
    expect(after.status).toBe(before.status)
  })

  it('reports how long the quest has left, so a late top-up is not quiet', async () => {
    const taskId = await aQuest()

    const result = await topUpQuest(db, { sponsorId, taskId, slots: 1 })

    expect(result).toMatchObject({ outcome: 'bought', expiresAt: '2026-08-20T12:00:00.000Z' })
  })

  /** The rejection case: somebody else's quest is not yours to spend on. */
  it('refuses a caller that did not write the quest', async () => {
    const taskId = await aQuest()

    expect(await topUpQuest(db, { sponsorId: strangerId, taskId, slots: 3 })).toEqual({
      outcome: 'not-yours',
    })
    expect((await readQuest(taskId)).pendingSlots).toBeNull()
  })

  it.each(['draft', 'pending_review', 'awaiting_payment', 'retired'] as const)(
    'refuses a quest that is %s rather than running',
    async (status) => {
      const taskId = await aQuest({
        status,
        ...(status === 'awaiting_payment'
          ? { awaitingPaymentSince: '2026-08-09T10:00:00.000Z', paidLamports: 0 }
          : {}),
      })

      const result = await topUpQuest(db, { sponsorId, taskId, slots: 3 })

      expect(result).toMatchObject({ outcome: 'not-running', status })
      expect((await readQuest(taskId)).pendingSlots).toBeNull()
    },
  )

  it('refuses a second top-up while the first is outstanding', async () => {
    const taskId = await aQuest()
    await topUpQuest(db, { sponsorId, taskId, slots: 3 })

    expect(await topUpQuest(db, { sponsorId, taskId, slots: 2 })).toEqual({
      outcome: 'already-topping-up',
      pendingSlots: 3,
    })
    // And the first purchase is untouched by the refusal.
    expect((await readQuest(taskId)).invoiceLamports).toBe(3_750_000 + 3_000_000)
  })

  it('refuses a total beyond what one quest may hold', async () => {
    const taskId = await aQuest({ slots: QUEST_MAX_SLOTS })

    expect(await topUpQuest(db, { sponsorId, taskId, slots: 1 })).toEqual({
      outcome: 'over-capacity',
      ceiling: QUEST_MAX_SLOTS,
    })
  })

  /**
   * A quest that pays reputation has nothing to invoice, so there is nothing to
   * wait for and the places are live at once.
   */
  it('adds the places immediately where the quest pays nothing', async () => {
    const taskId = await aQuest({ rewardLamports: 0, invoiceLamports: null, paidLamports: 0 })

    const result = await topUpQuest(db, { sponsorId, taskId, slots: 4 })

    expect(result).toMatchObject({ outcome: 'bought', pendingSlots: 0 })
    const row = await readQuest(taskId)
    expect(row.slots).toBe(7)
    expect(row.pendingSlots).toBeNull()
  })

  /**
   * A top-up is capacity on a quest citizens are answering now; a quest in
   * `awaiting_payment` has not started and nobody is looking at it.
   */
  it('settles a running quest’s top-up before a quest that has not started', async () => {
    const running = await aQuest()
    await topUpQuest(db, { sponsorId, taskId: running, slots: 1 })
    const waiting = await aQuest({
      status: 'awaiting_payment',
      awaitingPaymentSince: '2026-08-01T10:00:00.000Z',
      invoiceLamports: 1_000_000,
      paidLamports: 0,
      slots: 1,
    })

    await db.transaction(async (tx) => {
      await applyPaymentToInvoice(tx, { sponsorId, lamports: 1_000_000 })
    })

    expect((await readQuest(running)).slots).toBe(4)
    expect((await readQuest(waiting)).paidLamports).toBe(0)
  })
})
