import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  questFundingReference,
  questPayoutReference,
  submissionReference,
  taskOfReference,
  type AgentId,
  type SubmissionId,
  type TaskId,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agents, ledgerEntries } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { creditBalanceFor, creditMovementCountFor, creditMovementsFor } from './credits.js'

const target = databaseTestTarget()

/**
 * The statement a citizen could not read (`#333`).
 *
 * A citizen reported two numbers about its own money that would not reconcile,
 * and could establish neither reading, because *"there is no credit ledger
 * anywhere in the tool list"*. Every test here is about the property that makes
 * this an audit rather than a feed: the movements sum to the balance, and
 * nothing is hidden from the account that owns them.
 */
describe('a citizen’s own credit movements', () => {
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

  /** An agent with nothing booked against it yet. */
  const anAgent = async (name: string): Promise<AgentId> => {
    const [row] = await db
      .insert(agents)
      .values({ name, platform: 'claude' })
      .returning({ id: agents.id })
    return row!.id as AgentId
  }

  /**
   * One booking, written the way the ledger's own writers write it: two rows,
   * one transaction id, summing to zero — because `ledger_entries_balanced` is
   * deferred and refuses anything else at commit.
   */
  const book = async (input: {
    readonly agentId: AgentId
    readonly amount: number
    readonly type: 'task_reward' | 'task_funding' | 'task_payout'
    readonly memo: string
    readonly reference: string | null
    readonly other: 'mint' | 'escrow'
  }) => {
    const transactionId = crypto.randomUUID()
    await db.insert(ledgerEntries).values([
      {
        transactionId,
        accountKind: 'agent',
        agentId: input.agentId,
        amount: input.amount,
        type: input.type,
        memo: input.memo,
        reference: input.reference,
      },
      {
        transactionId,
        accountKind: 'system',
        systemAccount: input.other,
        amount: -input.amount,
        type: input.type,
        memo: input.memo,
        reference: input.reference,
      },
    ])
  }

  const aTaskId = '674fb6f5-fbb6-4002-b81c-111ac6c38911' as TaskId
  const aSubmissionId = '9d1a1a5e-0000-4000-8000-00000000abcd' as SubmissionId

  it('says nothing has moved on an account nothing has moved on', async () => {
    const agentId = await anAgent('never-paid')

    expect(await creditMovementsFor(db, agentId)).toEqual([])
    expect(await creditMovementCountFor(db, agentId)).toBe(0)
    expect(await creditBalanceFor(db, agentId)).toBe(0)
  })

  /**
   * **The property the whole surface exists for.** A balance is a number the
   * citizen has to believe; this is the set of events it is the sum of, and if
   * the two ever disagree the statement is worthless.
   */
  it('sums to the balance it is served with', async () => {
    const agentId = await anAgent('earning')
    await book({
      agentId,
      amount: 2000,
      type: 'task_reward',
      memo: 'Academy — mailbox (unattended)',
      reference: submissionReference(aSubmissionId),
      other: 'mint',
    })
    await book({
      agentId,
      amount: -300,
      type: 'task_funding',
      memo: 'Quest escrow — 20 × 15',
      reference: questFundingReference(aTaskId),
      other: 'escrow',
    })

    const movements = await creditMovementsFor(db, agentId)

    expect(movements.reduce((sum, movement) => sum + movement.amount, 0)).toBe(
      await creditBalanceFor(db, agentId),
    )
    expect(await creditBalanceFor(db, agentId)).toBe(1700)
  })

  /**
   * The reporter's second reading, settled. Escrow **left** the balance at
   * publication, so it is a movement here and is not held inside the number —
   * which is why `available` does not subtract it a second time.
   */
  it('shows a published quest’s escrow as money that left, not as a hold', async () => {
    const agentId = await anAgent('sponsor')
    await book({
      agentId,
      amount: 2000,
      type: 'task_reward',
      memo: 'Academy — mailbox (unattended)',
      reference: submissionReference(aSubmissionId),
      other: 'mint',
    })
    await book({
      agentId,
      amount: -300,
      type: 'task_funding',
      memo: 'Quest escrow — 20 × 15',
      reference: questFundingReference(aTaskId),
      other: 'escrow',
    })

    const [newest] = await creditMovementsFor(db, agentId)

    expect(newest?.amount).toBe(-300)
    expect(newest?.type).toBe('task_funding')
    expect(newest?.taskId).toBe(aTaskId)
  })

  /**
   * **Only the citizen's own side.** A booking has two rows and the other one is
   * the mint's or the escrow account's — and in the quest case the escrow
   * account holds other sponsors' money in the very same rows.
   */
  it('never serves the other leg of a booking', async () => {
    const agentId = await anAgent('one-side-only')
    await book({
      agentId,
      amount: 15,
      type: 'task_payout',
      memo: 'Quest — quest-report (unattended)',
      reference: questPayoutReference(aTaskId, aSubmissionId),
      other: 'escrow',
    })

    const movements = await creditMovementsFor(db, agentId)

    expect(movements).toHaveLength(1)
    expect(movements[0]?.amount).toBe(15)
  })

  it('never serves one citizen another citizen’s movements', async () => {
    const mine = await anAgent('mine')
    const theirs = await anAgent('theirs')
    await book({
      agentId: theirs,
      amount: 15,
      type: 'task_payout',
      memo: 'Quest — quest-report (unattended)',
      reference: questPayoutReference(aTaskId, aSubmissionId),
      other: 'escrow',
    })

    expect(await creditMovementsFor(db, mine)).toEqual([])
    expect(await creditMovementCountFor(db, mine)).toBe(0)
  })

  /**
   * A capped list has to say so, or *this is everything* and *this is the most
   * recent two of five* are the same answer — which is a shorter, plausible,
   * wrong statement.
   */
  it('reports the whole count even when the list is capped', async () => {
    const agentId = await anAgent('busy')
    for (let i = 0; i < 5; i++) {
      await book({
        agentId,
        amount: 10 + i,
        type: 'task_reward',
        memo: `Academy — task ${i} (unattended)`,
        reference: null,
        other: 'mint',
      })
    }

    expect(await creditMovementsFor(db, agentId, { limit: 2 })).toHaveLength(2)
    expect(await creditMovementCountFor(db, agentId)).toBe(5)
  })

  it('narrows to what is new when asked, and to everything when not', async () => {
    const agentId = await anAgent('scheduled')
    await book({
      agentId,
      amount: 100,
      type: 'task_reward',
      memo: 'Academy — an old one (unattended)',
      reference: null,
      other: 'mint',
    })

    const cutoff = new Date(Date.now() + 1000).toISOString()

    expect(await creditMovementsFor(db, agentId, { since: cutoff })).toEqual([])
    expect(await creditMovementsFor(db, agentId)).toHaveLength(1)
  })

  /**
   * The reference vocabulary is two, and only one of them names a task. A
   * submission reference names the *submission*, so guessing a task out of it by
   * position would be a wrong answer where a null is the honest one.
   */
  describe('the task a reference names', () => {
    it('reads the task out of every quest reference', () => {
      expect(taskOfReference(questFundingReference(aTaskId))).toBe(aTaskId)
      expect(taskOfReference(questPayoutReference(aTaskId, aSubmissionId))).toBe(aTaskId)
    })

    it('answers null for a submission, which names no task', () => {
      expect(taskOfReference(submissionReference(aSubmissionId))).toBeNull()
    })

    it('answers null for no reference and for one it cannot parse', () => {
      expect(taskOfReference(null)).toBeNull()
      expect(taskOfReference('quest:not-a-uuid:funding')).toBeNull()
      expect(taskOfReference('credit:0000')).toBeNull()
    })
  })
})
