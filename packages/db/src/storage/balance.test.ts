import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { AgentBalanceSchema, RegisterAgentRequestSchema, type AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { ledgerEntries, reputationEvents } from '../schema/index.js'
import { connectForTests, databaseTestTarget, expectRejection, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import { balanceOfAgent } from './balance.js'

const target = databaseTestTarget()

describe('balanceOfAgent', () => {
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

  const anAgent = async (name = 'canary'): Promise<AgentId> => {
    const result = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name, platform: 'openclaw' }),
    )
    if (result.outcome !== 'registered') throw new Error(result.outcome)
    return result.agent.id
  }

  /**
   * Pay an agent from the mint, double-entry, in one database transaction — the
   * only way `ledger_entries` accepts a booking at all (D-003). This is what #8
   * will do for real; here it exists to give the sum something to sum.
   */
  const pay = async (agentId: AgentId, amount: number) => {
    const transactionId = randomUUID()
    await db.transaction(async (tx) => {
      await tx.insert(ledgerEntries).values({
        transactionId,
        accountKind: 'system',
        systemAccount: 'mint',
        amount: -amount,
        type: 'task_reward',
      })
      await tx.insert(ledgerEntries).values({
        transactionId,
        accountKind: 'agent',
        agentId,
        amount,
        type: 'task_reward',
      })
    })
  }

  const award = async (agentId: AgentId, delta: number) => {
    await db.insert(reputationEvents).values({ agentId, delta, reason: 'task_passed' })
  }

  it('reports zero for an agent that has earned nothing', async () => {
    const agentId = await anAgent()

    // The common case, not an edge one: every agent is here for its first
    // minutes in the Colony, and `sum()` over no rows is NULL.
    expect(await balanceOfAgent(db, agentId)).toEqual({ agentId, credits: 0, reputation: 0 })
  })

  it('answers the shape core documents', async () => {
    const agentId = await anAgent()
    await pay(agentId, 50)

    const balance = await balanceOfAgent(db, agentId)

    expect(() => AgentBalanceSchema.strict().parse(balance)).not.toThrow()
  })

  it('sums credits across bookings', async () => {
    const agentId = await anAgent()
    await pay(agentId, 50)
    await pay(agentId, 25)

    expect((await balanceOfAgent(db, agentId)).credits).toBe(75)
  })

  it('sums reputation across events', async () => {
    const agentId = await anAgent()
    await award(agentId, 5)
    await award(agentId, 3)

    expect((await balanceOfAgent(db, agentId)).reputation).toBe(8)
  })

  it('does not multiply one log by the other', async () => {
    const agentId = await anAgent()
    await pay(agentId, 50)
    await pay(agentId, 50)
    await pay(agentId, 50)
    await award(agentId, 1)
    await award(agentId, 1)

    // A join across the two logs would report 300 credits and 6 reputation here —
    // both plausible numbers, which is exactly why this is asserted.
    expect(await balanceOfAgent(db, agentId)).toEqual({ agentId, credits: 150, reputation: 2 })
  })

  it('subtracts a debit', async () => {
    const agentId = await anAgent()
    await pay(agentId, 100)

    const transactionId = randomUUID()
    await db.transaction(async (tx) => {
      await tx.insert(ledgerEntries).values({
        transactionId,
        accountKind: 'agent',
        agentId,
        amount: -30,
        type: 'feature_purchase',
      })
      await tx.insert(ledgerEntries).values({
        transactionId,
        accountKind: 'system',
        systemAccount: 'treasury',
        amount: 30,
        type: 'feature_purchase',
      })
    })

    expect((await balanceOfAgent(db, agentId)).credits).toBe(70)
  })

  it('counts only the agent asked about', async () => {
    const mine = await anAgent('canary-one')
    const theirs = await anAgent('canary-two')
    await pay(theirs, 500)
    await award(theirs, 40)

    expect(await balanceOfAgent(db, mine)).toEqual({ agentId: mine, credits: 0, reputation: 0 })
  })

  it('ignores the system side of the same booking', async () => {
    const agentId = await anAgent()
    await pay(agentId, 50)

    // The mint's -50 shares the transaction and must not reach an agent's
    // balance; if it did, every reward would net to nothing.
    expect((await balanceOfAgent(db, agentId)).credits).toBe(50)
  })

  it('refuses a reputation event that takes reputation away for a reward reason', async () => {
    const agentId = await anAgent()

    // The invariant core documents on ReputationEventSchema, enforced by the
    // database rather than by whoever remembers to check.
    await expectRejection(
      () => db.insert(reputationEvents).values({ agentId, delta: -5, reason: 'task_passed' }),
      /reputation_events_negative_reasons/,
    )
  })

  it('books a red line violation against the agent', async () => {
    const agentId = await anAgent()
    await award(agentId, 10)
    await db
      .insert(reputationEvents)
      .values({ agentId, delta: -4, reason: 'red_line_violation', memo: 'test' })

    expect((await balanceOfAgent(db, agentId)).reputation).toBe(6)
  })
})
