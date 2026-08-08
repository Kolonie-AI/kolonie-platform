import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PAYOUT_STUCK_AFTER_ATTEMPTS, type AgentId, type TaskId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agents, payoutObligations, submissions, tasks } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { earningsFor, stuckPayouts } from './payouts.js'

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
        rewardCredits: 0,
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
})
