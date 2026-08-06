import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import {
  PLATFORM_FEE_PERCENT_VAR,
  type AgentId,
  type SubmissionId,
  type TaskId,
} from '@kolonie-ai/core'
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
    /** The rate this quest was published under. `undefined` is `null`: no fee. */
    readonly feePercent?: number
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
        ...(options.feePercent !== undefined && { platformFeePercent: options.feePercent }),
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

      // 100 × 5 for the answers, and 2 × 3 for the obstacle pool (`#371`).
      expect(await availableBalance(db, sponsor)).toEqual({
        balance: 1000,
        reserved: 506,
        available: 494,
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
      // Each with its obstacle pool: 4 × 5 + 2 × 3, and 20 × 10 + 5 × 3.
      expect(rows.map((row) => row.reserved).sort((a, b) => a - b)).toEqual([26, 215])
    })

    it('moves a quest from reserved to escrowed when it is published', async () => {
      const sponsor = await anAgent('sponsor')
      await credit(sponsor, 1000)
      const taskId = await aQuest({ sponsorId: sponsor, price: 10, capacity: 20 })

      // 20 × 10 for the answers and 15 for the obstacle pool (`#371`).
      expect(await commitmentsBy(db, sponsor)).toEqual([
        expect.objectContaining({ taskId, reserved: 215, escrowed: 0 }),
      ])

      await db.transaction(async (tx) => {
        await fundQuestEscrow(tx, {
          taskId,
          sponsorId: sponsor,
          credits: 10,
          capacity: 20,
          publishObstacles: false,
        })
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
        fundQuestEscrow(tx, {
          taskId,
          sponsorId: sponsor,
          credits: 10,
          capacity: 20,
          publishObstacles: false,
        }),
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
        expect.objectContaining({ taskId, reserved: 0, escrowed: 190, paid: 10 }),
      ])
    })

    /**
     * **The row has to add up, and a payout at the advertised price is the easy
     * half of that** (`#333`). A citizen watching its own quest read 277 against
     * a published cost of 300 and could establish only that 23 is not a multiple
     * of the 15 the quest advertises — because a payout is reduced when the
     * answering citizen declares that an operator helped it. `escrowed + paid`
     * is what publication funded whatever the rates were, which is the property
     * that makes the arithmetic checkable without knowing them.
     */
    it('adds escrowed and paid back up to what publication funded, at any rate', async () => {
      const sponsor = await anAgent('sponsor')
      const full = await anAgent('unattended-citizen')
      const halved = await anAgent('assisted-citizen')
      await credit(sponsor, 1000)
      const taskId = await aQuest({ sponsorId: sponsor, price: 15, capacity: 20, status: 'active' })
      await db.transaction((tx) =>
        fundQuestEscrow(tx, {
          taskId,
          sponsorId: sponsor,
          credits: 15,
          capacity: 20,
          publishObstacles: false,
        }),
      )

      // 15 at the advertised rate, then 8 — `ceil(15 × 50%)`, which is what an
      // answer from a citizen that declared assistance is worth. Together they
      // are the 23 the reporter could not account for.
      for (const [agentId, credits] of [
        [full, 15],
        [halved, 8],
      ] as const) {
        const submissionId = await anAcceptedReport(taskId, agentId)
        await db.transaction((tx) =>
          payQuestReport(tx, { taskId, submissionId, agentId, credits, memo: 'An answer.' }),
        )
      }

      const [row] = await commitmentsBy(db, sponsor)

      expect(row).toEqual(expect.objectContaining({ taskId, escrowed: 277, paid: 23 }))
      expect((row?.escrowed ?? 0) + (row?.paid ?? 0)).toBe(300)
    })

    it('leaves the list once the quest has settled, which is the refund arriving', async () => {
      const sponsor = await anAgent('sponsor')
      await credit(sponsor, 1000)
      const taskId = await aQuest({ sponsorId: sponsor, price: 10, capacity: 20, status: 'active' })
      await db.transaction((tx) =>
        fundQuestEscrow(tx, {
          taskId,
          sponsorId: sponsor,
          credits: 10,
          capacity: 20,
          publishObstacles: false,
        }),
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
        fundQuestEscrow(tx, {
          taskId,
          sponsorId: sponsor,
          credits: 5,
          capacity: 100,
          publishObstacles: false,
        }),
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
        fundQuestEscrow(tx, {
          taskId,
          sponsorId: sponsor,
          credits: 5,
          capacity: 10,
          publishObstacles: false,
        }),
      )

      await expectRejection(
        () =>
          db.transaction((tx) =>
            fundQuestEscrow(tx, {
              taskId,
              sponsorId: sponsor,
              credits: 5,
              capacity: 10,
              publishObstacles: false,
            }),
          ),
        /ledger_entries_quest_money/,
      )
    })

    /** Zero books nothing: a reputation-only quest produces no ledger entries at all. */
    it('writes no entry at all for a quest that pays nothing', async () => {
      const sponsor = await anAgent('sponsor')
      const taskId = await aQuest({ sponsorId: sponsor, price: 0, capacity: 100 })

      await db.transaction((tx) =>
        fundQuestEscrow(tx, {
          taskId,
          sponsorId: sponsor,
          credits: 0,
          capacity: 100,
          publishObstacles: false,
        }),
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
        fundQuestEscrow(tx, {
          taskId,
          sponsorId: sponsor,
          credits: 5,
          capacity: 10,
          publishObstacles: false,
        }),
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
        fundQuestEscrow(tx, {
          taskId,
          sponsorId: sponsor,
          credits: 5,
          capacity: 10,
          publishObstacles: false,
        }),
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
        fundQuestEscrow(tx, {
          taskId,
          sponsorId: sponsor,
          credits: 10,
          capacity: 10,
          publishObstacles: false,
        }),
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
        fundQuestEscrow(tx, {
          taskId,
          sponsorId: sponsor,
          credits: 10,
          capacity: 10,
          publishObstacles: false,
        }),
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
        fundQuestEscrow(tx, {
          taskId,
          sponsorId: sponsor,
          credits: 10,
          capacity: 10,
          publishObstacles: false,
        }),
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
        fundQuestEscrow(tx, {
          taskId,
          sponsorId: sponsor,
          credits: 10,
          capacity: 10,
          publishObstacles: false,
        }),
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
        fundQuestEscrow(tx, {
          taskId,
          sponsorId: sponsor,
          credits: 10,
          capacity: 10,
          publishObstacles: false,
        }),
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
        fundQuestEscrow(tx, {
          taskId,
          sponsorId: sponsor,
          credits: 10,
          capacity: 10,
          publishObstacles: false,
        }),
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
        fundQuestEscrow(tx, {
          taskId,
          sponsorId: sponsor,
          credits: 10,
          capacity: 10,
          publishObstacles: false,
        }),
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
        fundQuestEscrow(tx, {
          taskId,
          sponsorId: sponsor,
          credits: 10,
          capacity: 10,
          publishObstacles: false,
        }),
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
          fundQuestEscrow(tx, {
            taskId,
            sponsorId: sponsor,
            credits: 10,
            capacity: 5,
            publishObstacles: false,
          }),
        )
      }

      const outcome = await sweepQuestRefunds(db)

      expect(outcome.refunded.map((one) => one.taskId).sort()).toEqual([mine, orphan].sort())
      expect(await escrowHeldFor(db, mine)).toBe(0)
      expect(await escrowHeldFor(db, orphan)).toBe(0)
    })
  })
})

/**
 * The Colony's share of every accepted report (`#462`).
 *
 * Until 2026-08-06 a quest funded with 1000 credits paid citizens 1000 and the
 * Colony nothing: `governance/economy.md` had described a platform fee since
 * 2026-07-29 and nothing had ever charged one.
 */
describe('the platform fee on an accepted report', () => {
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

  let seeded = 0

  const anAgent = async (): Promise<AgentId> => {
    const [row] = await db
      .insert(agents)
      .values({ name: `agent-${++seeded}`, platform: 'openclaw', status: 'citizen' as const })
      .returning({ id: agents.id })
    return row!.id as AgentId
  }

  /**
   * A published quest with its escrow funded through the real path.
   *
   * `publishObstacles: false` so the escrow is exactly `price` — the obstacle
   * pool is a second sum on top (`#371`) and it is not what these tests are
   * about.
   */
  const aFundedQuest = async (price: number, feePercent: number | null): Promise<TaskId> => {
    const sponsorId = await anAgent()
    const [row] = await db
      .insert(tasks)
      .values({
        type: `quest-${++seeded}`,
        kind: 'quest' as const,
        title: 'A thousand registrations',
        description: 'A description.',
        instructions: 'Register and report.',
        rewardCredits: price,
        rewardReputation: 1,
        slots: 1,
        createdBy: sponsorId,
        publishObstacles: false,
        timeoutHours: 24,
        status: 'active' as const,
        ...(feePercent !== null && { platformFeePercent: feePercent }),
      })
      .returning({ id: tasks.id })
    const taskId = row!.id as TaskId

    await creditBalance(sponsorId, price)
    await db.transaction((tx) =>
      fundQuestEscrow(tx, {
        taskId,
        sponsorId,
        credits: price,
        capacity: 1,
        publishObstacles: false,
      }),
    )
    return taskId
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

  /** A steward crediting a sponsor's balance by hand, which is the only way in today. */
  const creditBalance = async (agentId: AgentId, amount: number): Promise<void> => {
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

  const totalFor = async (where: ReturnType<typeof eq>): Promise<number> => {
    const [row] = await db
      .select({ total: sql<string>`coalesce(sum(${ledgerEntries.amount}), 0)::text` })
      .from(ledgerEntries)
      .where(where)
    return Number(row?.total ?? 0)
  }

  const pay = async (taskId: TaskId, agentId: AgentId, credits: number) => {
    const submissionId = await anAcceptedReport(taskId, agentId)
    await db.transaction((tx) =>
      payQuestReport(tx, { taskId, submissionId, agentId, credits, memo: 'An answer.' }),
    )
  }

  it('books escrow out, the citizen in and the treasury in, as one transaction', async () => {
    const citizen = await anAgent()
    const taskId = await aFundedQuest(1000, 25)

    await pay(taskId, citizen, 1000)

    expect(await totalFor(eq(ledgerEntries.agentId, citizen))).toBe(750)
    expect(await totalFor(eq(ledgerEntries.systemAccount, 'escrow'))).toBe(0)

    const rows = await db
      .select({
        transactionId: ledgerEntries.transactionId,
        amount: ledgerEntries.amount,
        account: ledgerEntries.systemAccount,
      })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.type, 'task_payout'))

    // One transaction, three sides, summing to zero — not two bookings that
    // would each have to invent an escrow leg.
    expect(new Set(rows.map((row) => row.transactionId)).size).toBe(1)
    expect(rows).toHaveLength(3)
    expect(rows.reduce((sum, row) => sum + row.amount, 0)).toBe(0)
  })

  it('sends the Colony’s share to the treasury account', async () => {
    const citizen = await anAgent()
    const taskId = await aFundedQuest(1000, 25)

    const before = await totalFor(eq(ledgerEntries.systemAccount, 'treasury'))
    await pay(taskId, citizen, 1000)

    expect((await totalFor(eq(ledgerEntries.systemAccount, 'treasury'))) - before).toBe(250)
  })

  /**
   * **The rejection case the issue asks for.** A rate change must not move a
   * quest a sponsor and a set of citizens are already inside — the payout reads
   * the rate recorded on the row at publication, so changing the configured one
   * does nothing to a live quest.
   */
  it('pays against the rate recorded at publication, not the configured one', async () => {
    const citizen = await anAgent()
    // Published at 10%, whatever the environment says now.
    const taskId = await aFundedQuest(1000, 10)

    const previous = process.env[PLATFORM_FEE_PERCENT_VAR]
    process.env[PLATFORM_FEE_PERCENT_VAR] = '90'
    try {
      await pay(taskId, citizen, 1000)
    } finally {
      if (previous === undefined) delete process.env[PLATFORM_FEE_PERCENT_VAR]
      else process.env[PLATFORM_FEE_PERCENT_VAR] = previous
    }

    expect(await totalFor(eq(ledgerEntries.agentId, citizen))).toBe(900)
  })

  /**
   * Every quest published before this column existed was published under no fee.
   * Reading a missing rate as today's would take a quarter of a payout out of an
   * arrangement that was already settled.
   */
  it('charges nothing on a quest published before the fee existed', async () => {
    const citizen = await anAgent()
    const taskId = await aFundedQuest(1000, null)

    await pay(taskId, citizen, 1000)

    expect(await totalFor(eq(ledgerEntries.agentId, citizen))).toBe(1000)
    expect(await totalFor(eq(ledgerEntries.type, 'task_payout'))).toBe(0)
  })

  /**
   * **The pilot, and the rule that zero books nothing.** At one cent a report a
   * 25% fee rounds to zero, so there must be no treasury row at all — not a row
   * of zero, which `ledger_entries_amount_non_zero` would refuse anyway.
   */
  it('books no treasury row at all when the fee rounds to nothing', async () => {
    const citizen = await anAgent()
    const taskId = await aFundedQuest(1, 25)

    await pay(taskId, citizen, 1)

    expect(await totalFor(eq(ledgerEntries.agentId, citizen))).toBe(1)

    const payout = await db
      .select({ account: ledgerEntries.systemAccount, amount: ledgerEntries.amount })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.type, 'task_payout'))

    expect(payout).toHaveLength(2)
    expect(payout.some((row) => row.account === 'treasury')).toBe(false)
  })

  /** The remainder lands on the citizen, and it is asserted on a number that has one. */
  it('rounds in the citizen’s favour', async () => {
    const citizen = await anAgent()
    const taskId = await aFundedQuest(7, 25)

    // A delta: funding the sponsor's balance moves credits out of the treasury,
    // so its absolute total says nothing about the fee.
    const before = await totalFor(eq(ledgerEntries.systemAccount, 'treasury'))
    await pay(taskId, citizen, 7)

    // floor(7 × 25 / 100) = 1, so the citizen keeps 6 rather than 5.
    expect(await totalFor(eq(ledgerEntries.agentId, citizen))).toBe(6)
    expect((await totalFor(eq(ledgerEntries.systemAccount, 'treasury'))) - before).toBe(1)
  })

  /** D-038 is untouched: a quest still moves a credit the sponsor already had. */
  it('mints nothing', async () => {
    const citizen = await anAgent()
    const taskId = await aFundedQuest(1000, 25)

    await pay(taskId, citizen, 1000)

    expect(await totalFor(eq(ledgerEntries.systemAccount, 'mint'))).toBe(0)
  })
})
