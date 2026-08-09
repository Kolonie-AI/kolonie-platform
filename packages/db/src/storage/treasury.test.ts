import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { AgentId, TaskId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agents, payoutObligations, submissions, tasks } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import {
  earnedFeeLamports,
  outstandingObligationLamports,
  recordTreasurySweep,
  sweptToTreasuryLamports,
  treasuryTransfersMade,
} from './treasury.js'

const target = databaseTestTarget()

/**
 * What the Colony has earned and what it has moved — `#507`.
 *
 * **The arithmetic is what is under test, not the transfer.** Nothing here
 * sends anything; the sweep's own decisions are in `apps/api/src/treasury.test.ts`
 * against a fake chain. What this asserts is the one number the whole feature
 * rests on: how much of the payout wallet is the Colony's fee rather than a
 * citizen's money.
 */
describe('the fee the Colony has earned', () => {
  let db: Database
  let agentId: AgentId
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
  })

  /** A quest priced in SOL, at whatever the report is worth. */
  const aQuest = async (rewardLamports: number): Promise<TaskId> => {
    const [task] = await db
      .insert(tasks)
      .values({
        type: 'a-quest',
        title: 'Prove the settlement path end to end',
        description: 'What this quest is, for somebody deciding whether to answer it.',
        instructions: 'What the citizen is actually asked to do.',
        rewardReputation: 1,
        rewardLamports,
        timeoutHours: 24,
        status: 'active',
        kind: 'quest',
        audience: 'citizens',
      })
      .returning({ id: tasks.id })
    if (task === undefined) throw new Error('inserting a task returned no row')
    return task.id as TaskId
  }

  /** One accepted report: the citizen's share, and whatever happened to it since. */
  const anObligation = async (
    taskId: TaskId,
    lamports: number,
    values: Partial<typeof payoutObligations.$inferInsert> = {},
  ): Promise<void> => {
    submissionCount += 1
    const [submission] = await db
      .insert(submissions)
      .values({ taskId, agentId, payload: {}, attempt: submissionCount })
      .returning({ id: submissions.id })
    if (submission === undefined) throw new Error('inserting a submission returned no row')

    await db
      .insert(payoutObligations)
      .values({ agentId, taskId, submissionId: submission.id, lamports, ...values })
  }

  it('is nothing before anybody has been owed anything', async () => {
    expect(await earnedFeeLamports(db)).toBe(0)
  })

  /**
   * **The difference between the price and the citizen's share**, and not a
   * second implementation of `questPayoutSplit`. A quest priced at 1,000,000
   * with a 25% fee owes the citizen 750,000; the remaining 250,000 is the
   * Colony's and is in no table.
   */
  it('is the price of the report minus what the citizen was owed', async () => {
    const taskId = await aQuest(1_000_000)
    await anObligation(taskId, 750_000)

    expect(await earnedFeeLamports(db)).toBe(250_000)
  })

  it('adds up across reports and across quests', async () => {
    const first = await aQuest(1_000_000)
    const second = await aQuest(400_000)
    await anObligation(first, 750_000)
    await anObligation(first, 750_000)
    await anObligation(second, 300_000)

    expect(await earnedFeeLamports(db)).toBe(250_000 + 250_000 + 100_000)
  })

  /**
   * **A quest with no fee earns nothing**, which is the pilot's one-cent case:
   * `Math.floor` on the fee means the citizen receives the whole amount and
   * there is no Colony leg at all.
   */
  it('is nothing where the citizen was owed the whole price', async () => {
    const taskId = await aQuest(1_000_000)
    await anObligation(taskId, 1_000_000)

    expect(await earnedFeeLamports(db)).toBe(0)
  })

  /**
   * **A forfeited obligation is earned too.** A citizen erasing itself owed
   * less than the chain can deliver has its amount written off to the Treasury,
   * so the Colony keeps money it was going to pay out. Leaving it out would mean
   * lamports in the wallet that no arithmetic could ever account for.
   */
  it('counts an amount forfeited to the Treasury', async () => {
    const taskId = await aQuest(1_000_000)
    await anObligation(taskId, 750_000, { forfeitedAt: '2026-08-08T10:00:00.000Z' })

    // 250,000 of fee, plus the 750,000 nobody is left to receive.
    expect(await earnedFeeLamports(db)).toBe(1_000_000)
  })

  /**
   * **Paying the citizen does not change what the Colony earned.** The fee was
   * earned when the report was accepted; whether the citizen's half has left the
   * wallet yet is a different question, and it is the one
   * {@link outstandingObligationLamports} answers.
   */
  it('does not move when the citizen is paid', async () => {
    const taskId = await aQuest(1_000_000)
    await anObligation(taskId, 750_000, {
      paidAt: '2026-08-08T10:00:00.000Z',
      signature: 'a-signature',
    })

    expect(await earnedFeeLamports(db)).toBe(250_000)
    expect(await outstandingObligationLamports(db)).toBe(0)
  })

  it('reports what is still owed, ignoring what is paid or forfeited', async () => {
    const taskId = await aQuest(1_000_000)
    await anObligation(taskId, 750_000)
    await anObligation(taskId, 750_000, {
      paidAt: '2026-08-08T10:00:00.000Z',
      signature: 'another-signature',
    })
    await anObligation(taskId, 750_000, { forfeitedAt: '2026-08-08T10:00:00.000Z' })

    expect(await outstandingObligationLamports(db)).toBe(750_000)
  })
})

describe('the record of what has been moved', () => {
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

  const TREASURY = 'TreasuryAddressAsARealDeploymentWouldHoldIt'

  it('is nothing before the first sweep', async () => {
    expect(await sweptToTreasuryLamports(db)).toBe(0)
    expect(await treasuryTransfersMade(db)).toEqual([])
  })

  it('records the amount, the signature and the destination', async () => {
    expect(
      await recordTreasurySweep(db, {
        lamports: 250_000,
        signature: 'a-signature',
        address: TREASURY,
      }),
    ).toBe(true)

    expect(await sweptToTreasuryLamports(db)).toBe(250_000)
    expect(await treasuryTransfersMade(db)).toMatchObject([
      { lamports: 250_000, signature: 'a-signature', address: TREASURY },
    ])
  })

  /**
   * **A timer firing twice over one signature records one row**, which is the
   * whole of the idempotency and the reason the unique index exists.
   */
  it('records one row for one signature', async () => {
    const transfer = { lamports: 250_000, signature: 'a-signature', address: TREASURY }

    expect(await recordTreasurySweep(db, transfer)).toBe(true)
    expect(await recordTreasurySweep(db, transfer)).toBe(false)
    expect(await sweptToTreasuryLamports(db)).toBe(250_000)
  })

  it('adds up across sweeps', async () => {
    await recordTreasurySweep(db, { lamports: 250_000, signature: 'one', address: TREASURY })
    await recordTreasurySweep(db, { lamports: 100_000, signature: 'two', address: TREASURY })

    expect(await sweptToTreasuryLamports(db)).toBe(350_000)
  })
})
