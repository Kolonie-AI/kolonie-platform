import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import type { AgentId, SubmissionId, TaskId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agents, ledgerEntries, submissions, taskAttempts, tasks } from '../schema/index.js'
import { connectForTests, databaseTestTarget, expectRejection, truncateAll } from '../testing.js'
import {
  availableBalance,
  canCommit,
  commitmentsBy,
  escrowHeldFor,
  fundQuestEscrow,
  payQuestReport,
  refundQuestRemainder,
  sweepQuestRefunds,
} from './escrow.js'

const target = databaseTestTarget()

/**
 * Prepaid, reserved, escrowed, released or refunded (`#174`).
 *
 * Nothing here mints. A quest moves a credit the sponsor already had, and the
 * mint's balance is asserted to be untouched at the end of a quest's whole life
 * — which is the readable form of D-038.
 */
describe('the sponsor’s balance and the escrow', () => {
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

  /** A steward crediting a sponsor's balance by hand, which is the only way in today. */
  const credit = async (agentId: AgentId, amount: number): Promise<void> => {
    const transactionId = crypto.randomUUID()
    await db.insert(ledgerEntries).values([
      {
        transactionId,
        accountKind: 'system' as const,
        systemAccount: 'treasury' as const,
        amount: -amount,
        type: 'adjustment' as const,
        reference: `bootstrap:${agentId}`,
      },
      {
        transactionId,
        accountKind: 'agent' as const,
        agentId,
        amount,
        type: 'adjustment' as const,
        reference: `bootstrap:${agentId}`,
      },
    ])
  }

  const aQuest = async (options: {
    readonly sponsorId: AgentId | null
    readonly price: number
    readonly capacity: number | null
    readonly status?: 'draft' | 'pending_review' | 'active'
  }): Promise<TaskId> => {
    const [row] = await db
      .insert(tasks)
      .values({
        type: 'quest-report',
        kind: 'quest' as const,
        title: 'A thousand registrations',
        description: 'A description.',
        instructions: 'Register and report.',
        rewardCredits: options.price,
        rewardReputation: 1,
        slots: options.capacity,
        createdBy: options.sponsorId,
        timeoutHours: 24,
        status: options.status ?? 'pending_review',
      })
      .returning({ id: tasks.id })
    return row!.id as TaskId
  }

  const anAcceptedReport = async (taskId: TaskId, agentId: AgentId): Promise<SubmissionId> => {
    const [attempt] = await db
      .insert(taskAttempts)
      .values({ agentId, taskId, attempt: 1, opener: 'submission' as const })
      .returning({ id: taskAttempts.id })
    const [row] = await db
      .insert(submissions)
      .values({
        taskId,
        agentId,
        attemptId: attempt!.id,
        attempt: 1,
        payload: {},
        status: 'passed' as const,
        verifiedAt: sql`now()`,
      })
      .returning({ id: submissions.id })
    return row!.id as SubmissionId
  }

  const balanceOf = async (agentId: AgentId): Promise<number> => {
    const [row] = await db
      .select({ total: sql<string>`coalesce(sum(${ledgerEntries.amount}), 0)::text` })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.agentId, agentId))
    return Number(row?.total ?? 0)
  }

  const systemBalance = async (account: 'mint' | 'treasury' | 'escrow'): Promise<number> => {
    const [row] = await db
      .select({ total: sql<string>`coalesce(sum(${ledgerEntries.amount}), 0)::text` })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.systemAccount, account))
    return Number(row?.total ?? 0)
  }

  describe('the reservation', () => {
    it('is nothing before a quest is submitted', async () => {
      const sponsor = await anAgent('sponsor')
      await credit(sponsor, 1000)

      expect(await availableBalance(db, sponsor)).toEqual({
        balance: 1000,
        reserved: 0,
        available: 1000,
      })
    })

    it('holds capacity times price while a quest waits for review', async () => {
      const sponsor = await anAgent('sponsor')
      await credit(sponsor, 1000)
      await aQuest({ sponsorId: sponsor, price: 5, capacity: 100 })

      expect(await availableBalance(db, sponsor)).toEqual({
        balance: 1000,
        reserved: 500,
        available: 500,
      })
    })

    it('does not reserve against a draft, which nobody has committed to', async () => {
      const sponsor = await anAgent('sponsor')
      await credit(sponsor, 1000)
      await aQuest({ sponsorId: sponsor, price: 5, capacity: 100, status: 'draft' })

      expect((await availableBalance(db, sponsor)).reserved).toBe(0)
    })

    /**
     * The acceptance criterion, asserted against the schema rather than against
     * behaviour: a reservations table would be a second place a balance lives,
     * and the two would disagree (D-002).
     */
    it('is held in no table at all', async () => {
      const rows = await db.execute<{ table_name: string }>(
        sql`select table_name from information_schema.tables
             where table_schema = 'public'
               and (table_name like '%reservation%' or table_name like '%reserved%')`,
      )
      expect([...rows]).toEqual([])

      const columns = await db.execute<{ column_name: string }>(
        sql`select column_name from information_schema.columns
             where table_schema = 'public'
               and (column_name like '%reserved%' or column_name like '%reservation%')`,
      )
      expect([...columns]).toEqual([])
    })

    it('refuses a commitment above the available balance, naming the shortfall', async () => {
      const sponsor = await anAgent('sponsor')
      await credit(sponsor, 100)

      expect(await canCommit(db, sponsor, 250)).toEqual({ ok: false, shortfall: 150 })
    })

    it('allows one the balance covers', async () => {
      const sponsor = await anAgent('sponsor')
      await credit(sponsor, 300)

      expect(await canCommit(db, sponsor, 250)).toEqual({ ok: true })
    })

    it('counts an existing reservation against the next commitment', async () => {
      const sponsor = await anAgent('sponsor')
      await credit(sponsor, 300)
      await aQuest({ sponsorId: sponsor, price: 1, capacity: 200 })

      expect(await canCommit(db, sponsor, 200)).toEqual({ ok: false, shortfall: 100 })
    })
  })

  /**
   * The decomposition of `reserved` (`#324`).
   *
   * A citizen reported the consequence of it being a scalar: with two quests
   * settling it could not tell which one had released what, so the refund rule
   * was unobservable even to a sponsor watching for it.
   */
  describe('what each quest is holding', () => {
    it('sums to the scalar it decomposes', async () => {
      const sponsor = await anAgent('sponsor')
      await credit(sponsor, 1000)
      await aQuest({ sponsorId: sponsor, price: 10, capacity: 20 })
      await aQuest({ sponsorId: sponsor, price: 5, capacity: 4 })

      const rows = await commitmentsBy(db, sponsor)

      expect(rows.reduce((total, row) => total + row.reserved, 0)).toBe(
        (await availableBalance(db, sponsor)).reserved,
      )
      expect(rows.map((row) => row.reserved).sort((a, b) => a - b)).toEqual([20, 200])
    })

    it('moves a quest from reserved to escrowed when it is published', async () => {
      const sponsor = await anAgent('sponsor')
      await credit(sponsor, 1000)
      const taskId = await aQuest({ sponsorId: sponsor, price: 10, capacity: 20 })

      expect(await commitmentsBy(db, sponsor)).toEqual([
        expect.objectContaining({ taskId, reserved: 200, escrowed: 0 }),
      ])

      await db.transaction(async (tx) => {
        await fundQuestEscrow(tx, { taskId, sponsorId: sponsor, credits: 10, capacity: 20 })
        await tx.update(tasks).set({ status: 'active' }).where(eq(tasks.id, taskId))
      })

      // Never both at once: publication is what turns one into the other, in one
      // transaction.
      expect(await commitmentsBy(db, sponsor)).toEqual([
        expect.objectContaining({ taskId, reserved: 0, escrowed: 200 }),
      ])
    })

    it('drops a quest a steward refused, whose reservation is released at once', async () => {
      const sponsor = await anAgent('sponsor')
      await credit(sponsor, 1000)
      const taskId = await aQuest({ sponsorId: sponsor, price: 10, capacity: 20 })

      await db
        .update(tasks)
        .set({ status: 'rejected', rejectionReason: 'Not this one.' })
        .where(eq(tasks.id, taskId))

      expect(await commitmentsBy(db, sponsor)).toEqual([])
      expect((await availableBalance(db, sponsor)).reserved).toBe(0)
    })

    it('shows the escrow falling as reports are paid, not as slots are filled', async () => {
      const sponsor = await anAgent('sponsor')
      const citizen = await anAgent('citizen')
      await credit(sponsor, 1000)
      const taskId = await aQuest({ sponsorId: sponsor, price: 10, capacity: 20, status: 'active' })
      await db.transaction((tx) =>
        fundQuestEscrow(tx, { taskId, sponsorId: sponsor, credits: 10, capacity: 20 }),
      )

      const submissionId = await anAcceptedReport(taskId, citizen)
      await db.transaction((tx) =>
        payQuestReport(tx, {
          taskId,
          submissionId,
          agentId: citizen,
          credits: 10,
          memo: 'One accepted report.',
        }),
      )

      expect(await commitmentsBy(db, sponsor)).toEqual([
        expect.objectContaining({ taskId, reserved: 0, escrowed: 190 }),
      ])
    })

    it('leaves the list once the quest has settled, which is the refund arriving', async () => {
      const sponsor = await anAgent('sponsor')
      await credit(sponsor, 1000)
      const taskId = await aQuest({ sponsorId: sponsor, price: 10, capacity: 20, status: 'active' })
      await db.transaction((tx) =>
        fundQuestEscrow(tx, { taskId, sponsorId: sponsor, credits: 10, capacity: 20 }),
      )
      await db.update(tasks).set({ status: 'retired' }).where(eq(tasks.id, taskId))

      await sweepQuestRefunds(db)

      expect(await commitmentsBy(db, sponsor)).toEqual([])
      // Every unfilled slot came back, which is the rule `#324` asked to have
      // stated: the sponsor bought twenty answers, received none, and paid for
      // none.
      expect(await balanceOf(sponsor)).toBe(1000)
    })

    it('says nothing about another sponsor’s quests', async () => {
      const sponsor = await anAgent('sponsor')
      const other = await anAgent('other')
      await credit(sponsor, 1000)
      await aQuest({ sponsorId: sponsor, price: 10, capacity: 20 })

      expect(await commitmentsBy(db, other)).toEqual([])
    })
  })

  describe('publication moves the money', () => {
    it('books sponsor to escrow for capacity times price', async () => {
      const sponsor = await anAgent('sponsor')
      await credit(sponsor, 1000)
      const taskId = await aQuest({ sponsorId: sponsor, price: 5, capacity: 100 })

      await db.transaction((tx) =>
        fundQuestEscrow(tx, { taskId, sponsorId: sponsor, credits: 5, capacity: 100 }),
      )

      expect(await balanceOf(sponsor)).toBe(500)
      expect(await escrowHeldFor(db, taskId)).toBe(500)
      expect(await systemBalance('mint')).toBe(0)
    })

    it('refuses a second publication of the same quest', async () => {
      const sponsor = await anAgent('sponsor')
      await credit(sponsor, 1000)
      const taskId = await aQuest({ sponsorId: sponsor, price: 5, capacity: 10 })
      await db.transaction((tx) =>
        fundQuestEscrow(tx, { taskId, sponsorId: sponsor, credits: 5, capacity: 10 }),
      )

      await expectRejection(
        () =>
          db.transaction((tx) =>
            fundQuestEscrow(tx, { taskId, sponsorId: sponsor, credits: 5, capacity: 10 }),
          ),
        /ledger_entries_quest_money/,
      )
    })

    /** Zero books nothing: a reputation-only quest produces no ledger entries at all. */
    it('writes no entry at all for a quest that pays nothing', async () => {
      const sponsor = await anAgent('sponsor')
      const taskId = await aQuest({ sponsorId: sponsor, price: 0, capacity: 100 })

      await db.transaction((tx) =>
        fundQuestEscrow(tx, { taskId, sponsorId: sponsor, credits: 0, capacity: 100 }),
      )

      const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(ledgerEntries)
      expect(row?.count).toBe(0)
    })
  })

  describe('an accepted report is paid out of escrow', () => {
    it('moves one price from escrow to the citizen', async () => {
      const sponsor = await anAgent('sponsor')
      const citizen = await anAgent('citizen')
      await credit(sponsor, 1000)
      const taskId = await aQuest({ sponsorId: sponsor, price: 5, capacity: 10 })
      await db.transaction((tx) =>
        fundQuestEscrow(tx, { taskId, sponsorId: sponsor, credits: 5, capacity: 10 }),
      )
      const submissionId = await anAcceptedReport(taskId, citizen)

      await db.transaction((tx) =>
        payQuestReport(tx, {
          taskId,
          submissionId,
          agentId: citizen,
          credits: 5,
          memo: 'Quest report accepted',
        }),
      )

      expect(await balanceOf(citizen)).toBe(5)
      expect(await escrowHeldFor(db, taskId)).toBe(45)
    })

    it('refuses to pay the same report twice', async () => {
      const sponsor = await anAgent('sponsor')
      const citizen = await anAgent('citizen')
      await credit(sponsor, 1000)
      const taskId = await aQuest({ sponsorId: sponsor, price: 5, capacity: 10 })
      await db.transaction((tx) =>
        fundQuestEscrow(tx, { taskId, sponsorId: sponsor, credits: 5, capacity: 10 }),
      )
      const submissionId = await anAcceptedReport(taskId, citizen)
      await db.transaction((tx) =>
        payQuestReport(tx, {
          taskId,
          submissionId,
          agentId: citizen,
          credits: 5,
          memo: 'Quest report accepted',
        }),
      )

      await expectRejection(
        () =>
          db.transaction((tx) =>
            payQuestReport(tx, {
              taskId,
              submissionId,
              agentId: citizen,
              credits: 5,
              memo: 'Quest report accepted',
            }),
          ),
        /ledger_entries_quest_money/,
      )
    })
  })

  describe('what is left over at the end', () => {
    /**
     * The acceptance criterion in full: a quest that fills half its capacity and
     * then ends leaves the sponsor whole.
     */
    it('returns the unspent remainder, and the sponsor’s balance is whole again', async () => {
      const sponsor = await anAgent('sponsor')
      await credit(sponsor, 1000)
      const taskId = await aQuest({ sponsorId: sponsor, price: 10, capacity: 10 })
      await db.transaction((tx) =>
        fundQuestEscrow(tx, { taskId, sponsorId: sponsor, credits: 10, capacity: 10 }),
      )

      let paidOut = 0
      for (let index = 0; index < 5; index += 1) {
        const citizen = await anAgent(`citizen-${index}`)
        const submissionId = await anAcceptedReport(taskId, citizen)
        await db.transaction((tx) =>
          payQuestReport(tx, {
            taskId,
            submissionId,
            agentId: citizen,
            credits: 10,
            memo: 'Quest report accepted',
          }),
        )
        paidOut += 10
      }

      await db.transaction((tx) => refundQuestRemainder(tx, { taskId }))

      expect(await balanceOf(sponsor)).toBe(1000 - paidOut)
      // The escrow nets to zero across a quest's whole life, and the mint was
      // never touched (D-038).
      expect(await escrowHeldFor(db, taskId)).toBe(0)
      expect(await systemBalance('escrow')).toBe(0)
      expect(await systemBalance('mint')).toBe(0)
    })

    /**
     * Two halves, because there are two mechanisms and only one of them is the
     * one that has to hold under concurrency.
     */
    it('makes a second refund a no-op, because the escrow is already empty', async () => {
      const sponsor = await anAgent('sponsor')
      await credit(sponsor, 100)
      const taskId = await aQuest({ sponsorId: sponsor, price: 10, capacity: 10 })
      await db.transaction((tx) =>
        fundQuestEscrow(tx, { taskId, sponsorId: sponsor, credits: 10, capacity: 10 }),
      )
      await db.transaction((tx) => refundQuestRemainder(tx, { taskId }))

      expect(await db.transaction((tx) => refundQuestRemainder(tx, { taskId }))).toBe(0)
      expect(await balanceOf(sponsor)).toBe(100)
    })

    /**
     * And the backstop, which is what actually matters: two refunds racing both
     * read a non-empty escrow, so the emptiness check above passes twice. The
     * index is the only participant that sees both inserts.
     */
    it('refuses a second refund booking even when the check was passed twice', async () => {
      const sponsor = await anAgent('sponsor')
      await credit(sponsor, 100)
      const taskId = await aQuest({ sponsorId: sponsor, price: 10, capacity: 10 })
      await db.transaction((tx) =>
        fundQuestEscrow(tx, { taskId, sponsorId: sponsor, credits: 10, capacity: 10 }),
      )
      await db.transaction((tx) => refundQuestRemainder(tx, { taskId }))

      const transactionId = crypto.randomUUID()
      await expectRejection(
        () =>
          db.insert(ledgerEntries).values([
            {
              transactionId,
              accountKind: 'system' as const,
              systemAccount: 'escrow' as const,
              amount: -100,
              type: 'task_funding' as const,
              reference: `quest:${taskId}:refund`,
            },
            {
              transactionId,
              accountKind: 'agent' as const,
              agentId: sponsor,
              amount: 100,
              type: 'task_funding' as const,
              reference: `quest:${taskId}:refund`,
            },
          ]),
        /ledger_entries_quest_money/,
      )
    })

    /**
     * An ownerless quest keeps paying out of the escrow it already holds, and its
     * remainder has nowhere to go — so it goes to the Colony rather than staying
     * in an escrow that would then never net to zero.
     */
    it('sends the remainder to the treasury when the author has erased itself', async () => {
      const sponsor = await anAgent('sponsor')
      await credit(sponsor, 1000)
      const taskId = await aQuest({ sponsorId: sponsor, price: 10, capacity: 10 })
      await db.transaction((tx) =>
        fundQuestEscrow(tx, { taskId, sponsorId: sponsor, credits: 10, capacity: 10 }),
      )
      const treasuryBefore = await systemBalance('treasury')
      await db.update(tasks).set({ createdBy: null }).where(eq(tasks.id, taskId))

      await db.transaction((tx) => refundQuestRemainder(tx, { taskId }))

      expect(await systemBalance('treasury')).toBe(treasuryBefore + 100)
      expect(await systemBalance('escrow')).toBe(0)
    })

    it('books nothing when the escrow is already empty', async () => {
      const sponsor = await anAgent('sponsor')
      const taskId = await aQuest({ sponsorId: sponsor, price: 0, capacity: 10 })

      expect(await db.transaction((tx) => refundQuestRemainder(tx, { taskId }))).toBe(0)
    })
  })

  /**
   * The double-entry trigger, exercised by the new bookings rather than assumed.
   * `ledger_entries_balanced` is deferred, so this is the commit that fails and
   * not the insert.
   */
  it('refuses an escrow transaction whose two halves do not sum to zero', async () => {
    const sponsor = await anAgent('sponsor')
    const transactionId = crypto.randomUUID()

    await expectRejection(
      () =>
        db.transaction(async (tx) => {
          await tx.insert(ledgerEntries).values([
            {
              transactionId,
              accountKind: 'agent' as const,
              agentId: sponsor,
              amount: -100,
              type: 'task_funding' as const,
              reference: 'quest:deliberately-unbalanced:funding',
            },
            {
              transactionId,
              accountKind: 'system' as const,
              systemAccount: 'escrow' as const,
              amount: 99,
              type: 'task_funding' as const,
              reference: 'quest:deliberately-unbalanced:funding',
            },
          ])
        }),
      /balanced|sum/i,
    )
  })

  /**
   * The sweep that gives the fourth leg a caller (`#315`).
   *
   * `refundQuestRemainder` was exported, tested and reachable from nothing in
   * `apps/` for as long as the escrow existed, which meant a quest could expire
   * with a sponsor's money in escrow and no path anywhere that returned it.
   * These assert the properties a loop needs rather than the booking, which the
   * cases above already cover.
   */
  describe('sweeping the quests that have finished', () => {
    /**
     * The expiry is written *before* the quest goes live, because
     * `tasks_published_quest_frozen` refuses any change to an active quest's
     * terms — the trigger `questsAwaitingRefund`'s own comment is about. A test
     * that brought the expiry forward on a live quest would be testing a write
     * production cannot make.
     */
    const anExpiredQuest = async (sponsorId: AgentId | null): Promise<TaskId> => {
      const taskId = await aQuest({ sponsorId, price: 10, capacity: 10 })
      await db
        .update(tasks)
        .set({ expiresAt: new Date(Date.now() - 60_000).toISOString(), status: 'active' })
        .where(eq(tasks.id, taskId))
      return taskId
    }

    it('returns unspent capacity to the sponsor without anybody running SQL', async () => {
      const sponsor = await anAgent('sponsor')
      await credit(sponsor, 500)
      const taskId = await anExpiredQuest(sponsor)
      await db.transaction((tx) =>
        fundQuestEscrow(tx, { taskId, sponsorId: sponsor, credits: 10, capacity: 10 }),
      )

      const outcome = await sweepQuestRefunds(db)

      expect(outcome.refunded).toEqual([{ taskId, credits: 100 }])
      expect(outcome.failed).toEqual([])
      expect(await escrowHeldFor(db, taskId)).toBe(0)
      expect((await availableBalance(db, sponsor)).balance).toBe(500)
    })

    /** A steward retiring a quest early finishes it, and waiting for the original
     * expiry would hold the money for a fortnight after the quest stopped. */
    it('refunds a retired quest by the same path', async () => {
      const sponsor = await anAgent('sponsor')
      await credit(sponsor, 500)
      const taskId = await aQuest({ sponsorId: sponsor, price: 10, capacity: 10, status: 'active' })
      await db.transaction((tx) =>
        fundQuestEscrow(tx, { taskId, sponsorId: sponsor, credits: 10, capacity: 10 }),
      )
      await db.update(tasks).set({ status: 'retired' }).where(eq(tasks.id, taskId))

      expect((await sweepQuestRefunds(db)).refunded).toEqual([{ taskId, credits: 100 }])
    })

    /**
     * **Idempotence is the property the loop is built on.** A second tick over a
     * quest already refunded reads an empty escrow, books nothing, and is not an
     * error — which is what lets the sweep be crude, restartable and safe to run
     * in two containers at once.
     */
    it('books nothing on a second pass, and does not call it a failure', async () => {
      const sponsor = await anAgent('sponsor')
      await credit(sponsor, 500)
      const taskId = await anExpiredQuest(sponsor)
      await db.transaction((tx) =>
        fundQuestEscrow(tx, { taskId, sponsorId: sponsor, credits: 10, capacity: 10 }),
      )
      await sweepQuestRefunds(db)

      const second = await sweepQuestRefunds(db)

      expect(second).toEqual({ refunded: [], failed: [] })
      expect((await availableBalance(db, sponsor)).balance).toBe(500)
    })

    /** A quest still running is not finished, whatever its escrow holds. */
    it('leaves a live quest alone', async () => {
      const sponsor = await anAgent('sponsor')
      await credit(sponsor, 500)
      const taskId = await aQuest({ sponsorId: sponsor, price: 10, capacity: 10, status: 'active' })
      await db.transaction((tx) =>
        fundQuestEscrow(tx, { taskId, sponsorId: sponsor, credits: 10, capacity: 10 }),
      )

      expect((await sweepQuestRefunds(db)).refunded).toEqual([])
      expect(await escrowHeldFor(db, taskId)).toBe(100)
    })

    /**
     * One quest's failure is not the pass's. The ownerless quest below refunds to
     * the treasury and the sweep goes on to the next one — the property that
     * matters is that a hundred expired quests are a hundred transactions, so the
     * hundredth cannot undo the ninety-nine.
     */
    it('refunds every finished quest in one pass, ownerless ones included', async () => {
      const sponsor = await anAgent('sponsor')
      await credit(sponsor, 500)
      const mine = await anExpiredQuest(sponsor)
      const orphan = await anExpiredQuest(null)
      for (const taskId of [mine, orphan]) {
        await db.transaction((tx) =>
          fundQuestEscrow(tx, { taskId, sponsorId: sponsor, credits: 10, capacity: 5 }),
        )
      }

      const outcome = await sweepQuestRefunds(db)

      expect(outcome.refunded.map((one) => one.taskId).sort()).toEqual([mine, orphan].sort())
      expect(await escrowHeldFor(db, mine)).toBe(0)
      expect(await escrowHeldFor(db, orphan)).toBe(0)
    })
  })
})
