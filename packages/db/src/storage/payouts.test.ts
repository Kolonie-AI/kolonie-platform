import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PAYOUT_STUCK_AFTER_ATTEMPTS, type AgentId, type TaskId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { sql } from 'drizzle-orm'
import { agents, payoutObligations, submissions, tasks } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { earningsFor, outstandingDebt, stuckPayouts } from './payouts.js'

const target = databaseTestTarget()

/**
 * The two reads over `payout_obligations` that nothing had (`#535`, `#541`).
 *
 * The table has counted `attempts` and recorded `last_refusal` since `#505`, and
 * held the amount, the destination and the signature since it existed. Neither
 * the citizen being paid nor the maintainer paying could read any of it: the
 * citizen learned about its own payment by reading a chain, and an obligation on
 * its fortieth attempt looked exactly like one on its first.
 */
describe('reading what the Colony owes', () => {
  let db: Database
  let agentId: AgentId
  let taskId: TaskId
  let submissionCount = 0

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
    submissionCount = 0

    const [agent] = await db
      .insert(agents)
      .values({ name: 'paid-citizen', platform: 'openclaw' })
      .returning({ id: agents.id })
    if (agent === undefined) throw new Error('inserting an agent returned no row')
    agentId = agent.id as AgentId

    const [task] = await db
      .insert(tasks)
      .values({
        type: 'a-quest',
        title: 'Prove the settlement path end to end',
        description: 'What this quest is, for somebody deciding whether to answer it.',
        instructions: 'What the citizen is actually asked to do.',
        rewardReputation: 1,
        timeoutHours: 24,
        status: 'active',
        kind: 'quest',
        audience: 'citizens',
      })
      .returning({ id: tasks.id })
    if (task === undefined) throw new Error('inserting a task returned no row')
    taskId = task.id as TaskId
  })

  /** One accepted report's worth of debt, with whatever has happened to it since. */
  const anObligation = async (
    values: Partial<typeof payoutObligations.$inferInsert> = {},
  ): Promise<void> => {
    submissionCount += 1
    const [submission] = await db
      .insert(submissions)
      .values({ taskId, agentId, payload: {}, attempt: submissionCount })
      .returning({ id: submissions.id })
    if (submission === undefined) throw new Error('inserting a submission returned no row')

    await db.insert(payoutObligations).values({
      agentId,
      taskId,
      submissionId: submission.id,
      lamports: 1_500_000,
      ...values,
    })
  }

  describe('what a citizen has been paid', () => {
    it('names the amount, the destination and the transaction', async () => {
      await anObligation({
        paidAt: '2026-08-07T19:12:00.000Z',
        signature: '5xTr4nsAct10nS1gnatur3',
        address: 'CitizenOwnWa11etAddress',
      })

      const [earning] = await earningsFor(db, agentId)

      expect(earning).toMatchObject({
        lamports: 1_500_000,
        address: 'CitizenOwnWa11etAddress',
        signature: '5xTr4nsAct10nS1gnatur3',
        forfeited: false,
      })
      // The quest's title, so a row means something without a second call.
      expect(earning?.title).toBe('Prove the settlement path end to end')
    })

    it('carries the refusal that stopped the last attempt', async () => {
      await anObligation({ lastRefusal: 'accruing-below-chain-minimum', attempts: 4 })

      const [earning] = await earningsFor(db, agentId)

      expect(earning).toMatchObject({
        paidAt: null,
        lastRefusal: 'accruing-below-chain-minimum',
        attempts: 4,
      })
    })

    /**
     * **A citizen reads its own payments and nobody else's.** The table holds
     * every citizen's amounts and addresses, and this is the read a credential
     * reaches.
     */
    it('answers about one citizen and not the table', async () => {
      await anObligation()

      const [other] = await db
        .insert(agents)
        .values({ name: 'somebody-else', platform: 'openclaw' })
        .returning({ id: agents.id })

      expect(await earningsFor(db, other?.id as AgentId)).toEqual([])
    })

    it('is empty for a citizen nothing has been accepted from', async () => {
      expect(await earningsFor(db, agentId)).toEqual([])
    })
  })

  describe('what has been retried too often', () => {
    it('finds an obligation at the threshold and not one below it', async () => {
      await anObligation({ attempts: PAYOUT_STUCK_AFTER_ATTEMPTS, address: null })
      await anObligation({ attempts: PAYOUT_STUCK_AFTER_ATTEMPTS - 1, address: null })

      const stuck = await stuckPayouts(db, PAYOUT_STUCK_AFTER_ATTEMPTS)

      expect(stuck).toHaveLength(1)
      expect(stuck[0]?.attempts).toBe(PAYOUT_STUCK_AFTER_ATTEMPTS)
    })

    it('names the amount, the address and the last refusal', async () => {
      await anObligation({
        attempts: 40,
        address: 'CitizenOwnWa11etAddress',
        lastRefusal: 'unavailable',
        lastAttemptAt: '2026-08-08T01:00:00.000Z',
      })

      expect((await stuckPayouts(db, PAYOUT_STUCK_AFTER_ATTEMPTS))[0]).toMatchObject({
        lamports: 1_500_000,
        address: 'CitizenOwnWa11etAddress',
        attempts: 40,
        lastRefusal: 'unavailable',
      })
    })

    /**
     * **Outstanding only, and this is the rejection case.** A paid row's attempt
     * count is history — it took four goes and then it went out — and reporting
     * it would make the number grow for ever while nothing was wrong.
     */
    it('ignores an obligation that was eventually paid', async () => {
      await anObligation({
        attempts: 40,
        paidAt: '2026-08-07T19:12:00.000Z',
        signature: 'a-signature',
      })

      expect(await stuckPayouts(db, PAYOUT_STUCK_AFTER_ATTEMPTS)).toEqual([])
    })

    it('ignores one that was forfeited to the Treasury', async () => {
      await anObligation({ attempts: 40, forfeitedAt: '2026-08-07T19:12:00.000Z' })

      expect(await stuckPayouts(db, PAYOUT_STUCK_AFTER_ATTEMPTS)).toEqual([])
    })

    /** The worst one first, because it is the one worth reading if only one is. */
    it('puts the most-attempted first', async () => {
      await anObligation({ attempts: 7, address: null })
      await anObligation({ attempts: 41, address: null })
      await anObligation({ attempts: 19, address: null })

      expect(
        (await stuckPayouts(db, PAYOUT_STUCK_AFTER_ATTEMPTS)).map((row) => row.attempts),
      ).toEqual([41, 19, 7])
    })

    it('is empty when nothing has been attempted at all', async () => {
      await anObligation()

      expect(await stuckPayouts(db, PAYOUT_STUCK_AFTER_ATTEMPTS)).toEqual([])
    })
  })

  /**
   * `#720`. The float watcher answers *can the Colony pay* and was silent — and
   * right to be — while two obligations stood unpaid for two days. This answers
   * *has it paid*.
   */
  describe('what the Colony owes and has not discharged', () => {
    /** Written before the threshold, so it counts as a condition rather than a queue. */
    const anOldObligation = async (
      values: Partial<typeof payoutObligations.$inferInsert> = {},
    ): Promise<void> => {
      await anObligation(values)
      await db
        .update(payoutObligations)
        .set({ createdAt: sql`now() - interval '3 days'` })
        .where(
          sql`${payoutObligations.paidAt} is null and ${payoutObligations.createdAt} > now() - interval '1 day'`,
        )
    }

    it('is silent when nothing is outstanding', async () => {
      expect(await outstandingDebt(db, 24)).toMatchObject({ count: 0, lamports: 0, refusals: [] })
    })

    /**
     * The whole reason for the threshold: an obligation written a minute ago has
     * not failed to be paid, it has not been tried.
     */
    it('says nothing about a debt younger than the threshold', async () => {
      await anObligation({ lastRefusal: 'no-verified-address' })

      expect((await outstandingDebt(db, 24)).count).toBe(0)
    })

    it('counts and totals what has stood past it, grouped by refusal', async () => {
      await anOldObligation({ lamports: 750_000, lastRefusal: 'no-verified-address' })
      await anOldObligation({ lamports: 375_000, lastRefusal: 'accruing-below-chain-minimum' })

      const debt = await outstandingDebt(db, 24)

      expect(debt.count).toBe(2)
      expect(debt.lamports).toBe(1_125_000)
      // Most owed first: which refusal carries the money is what decides who
      // reads the issue.
      expect(debt.refusals).toEqual([
        { refusal: 'no-verified-address', count: 1, lamports: 750_000 },
        { refusal: 'accruing-below-chain-minimum', count: 1, lamports: 375_000 },
      ])
      expect(debt.oldestSince).not.toBeNull()
    })

    /** A forfeited amount went to the Treasury under `erasure.md` and is nobody's debt. */
    it('excludes what was paid and what was forfeited', async () => {
      await anOldObligation({ paidAt: new Date().toISOString(), signature: 'a-signature' })
      await anOldObligation({ forfeitedAt: new Date().toISOString() })

      expect((await outstandingDebt(db, 24)).count).toBe(0)
    })

    /**
     * A null refusal is a real key rather than missing information: an old
     * obligation nothing has ever attempted is a reconciler that is not running,
     * which no refusal would name and which would otherwise vanish into the total.
     */
    it('keeps a never-attempted obligation as its own row', async () => {
      await anOldObligation()

      expect((await outstandingDebt(db, 24)).refusals).toEqual([
        { refusal: null, count: 1, lamports: 1_500_000 },
      ])
    })
  })
})
