import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import {
  now,
  RegisterAgentRequestSchema,
  submissionReference,
  SubmissionIdSchema,
  TaskIdSchema,
  TaskTypeSchema,
  type AgentId,
  type SubmissionId,
  type TaskId,
} from '@kolonie-ai/core'
import { createDatabase, type Database } from '../client.js'
import {
  agents,
  agentSkills,
  ledgerEntries,
  reputationEvents,
  submissions,
  tasks,
} from '../schema/index.js'
import { connectForTests, databaseTestTarget, expectRejection, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import { balanceOfAgent } from './balance.js'
import { bookTaskReward } from './rewards.js'
import { claimNextSubmission, recordVerdict } from './verifications.js'

const target = databaseTestTarget()

if (!target.available) {
  console.warn(`\n${target.reason}\n`)
}

const EXAMPLE_TASK = TaskTypeSchema.parse('example-task')

describe.skipIf(!target.available)('booking a passed submission', () => {
  let db: Database

  beforeAll(async () => {
    if (!target.available) return
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
  })

  let seeded = 0

  const anAgent = async (level = 0): Promise<AgentId> => {
    const result = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name: `canary-${++seeded}`, platform: 'openclaw' }),
    )
    if (result.outcome !== 'registered') throw new Error(result.outcome)
    if (level !== 0) await db.update(agents).set({ level }).where(eq(agents.id, result.agent.id))
    return result.agent.id
  }

  const aTask = async (
    options: { coins?: number; reputation?: number; level?: number; grants?: string[] } = {},
  ): Promise<TaskId> => {
    const [row] = await db
      .insert(tasks)
      .values({
        type: 'example-task',
        level: options.level ?? 0,
        grantsSkills: options.grants ?? [],
        title: 'Make an API call',
        description: 'What this task is, for a human reading the catalogue.',
        instructions: 'What the agent must actually do.',
        rewardCoins: options.coins ?? 10,
        rewardReputation: options.reputation ?? 5,
        timeoutHours: 24,
        status: 'active',
      })
      .returning({ id: tasks.id })

    if (row === undefined) throw new Error('insert into tasks returned no row')
    return TaskIdSchema.parse(row.id)
  }

  /** A submission sitting in `verifying`, as the runner leaves it after claiming. */
  const aClaimedSubmission = async (
    options: { taskId?: TaskId; agentId?: AgentId } = {},
  ): Promise<SubmissionId> => {
    const taskId = options.taskId ?? (await aTask())
    const agentId = options.agentId ?? (await anAgent())

    const [row] = await db
      .insert(submissions)
      .values({ taskId, agentId, payload: { echo: 'hello' }, status: 'pending' })
      .returning({ id: submissions.id })

    if (row === undefined) throw new Error('insert into submissions returned no row')

    const claimed = await claimNextSubmission(db, [EXAMPLE_TASK])
    if (claimed?.submission.id !== row.id) {
      throw new Error('the fixture claimed a submission other than the one it just created')
    }
    return SubmissionIdSchema.parse(row.id)
  }

  const pass = (submissionId: SubmissionId) =>
    recordVerdict(db, {
      submissionId,
      taskType: EXAMPLE_TASK,
      result: { status: 'pass', evidence: 'The payload was well formed.' },
    })

  const fail = (submissionId: SubmissionId) =>
    recordVerdict(db, {
      submissionId,
      taskType: EXAMPLE_TASK,
      result: { status: 'fail', evidence: 'The payload had no echo.' },
    })

  const entriesFor = (submissionId: SubmissionId) =>
    db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.reference, submissionReference(submissionId)))

  const levelOf = async (agentId: AgentId): Promise<number> => {
    const [row] = await db
      .select({ level: agents.level })
      .from(agents)
      .where(eq(agents.id, agentId))
    if (row === undefined) throw new Error('agent vanished')
    return row.level
  }

  /** What the whole ledger sums to. Must be zero, always, whatever happened. */
  const ledgerTotal = async (): Promise<number> => {
    const [row] = await db
      .select({ total: sql<string>`coalesce(sum(${ledgerEntries.amount}), 0)::text` })
      .from(ledgerEntries)
    return Number(row?.total ?? '0')
  }

  describe('a pass', () => {
    it('credits the agent and debits the mint, and the two sum to zero', async () => {
      const agentId = await anAgent()
      const taskId = await aTask({ coins: 10 })
      const submissionId = await aClaimedSubmission({ taskId, agentId })

      const written = await pass(submissionId)

      expect(written.outcome).toBe('recorded')
      if (written.outcome !== 'recorded') return
      expect(written.booking?.coins).toBe(10)

      const entries = await entriesFor(submissionId)
      expect(entries).toHaveLength(2)

      const agentEntry = entries.find((entry) => entry.accountKind === 'agent')
      const mintEntry = entries.find((entry) => entry.accountKind === 'system')

      expect(agentEntry?.amount).toBe(10)
      expect(agentEntry?.agentId).toBe(agentId)
      expect(mintEntry?.amount).toBe(-10)
      expect(mintEntry?.systemAccount).toBe('mint')

      // One booking, one transaction id — the deferred trigger checks the set.
      expect(agentEntry?.transactionId).toBe(mintEntry?.transactionId)
      expect(await ledgerTotal()).toBe(0)
    })

    it('writes reputation alongside the coins', async () => {
      const agentId = await anAgent()
      const taskId = await aTask({ reputation: 5 })
      const submissionId = await aClaimedSubmission({ taskId, agentId })

      await pass(submissionId)

      const events = await db
        .select()
        .from(reputationEvents)
        .where(eq(reputationEvents.agentId, agentId))

      expect(events).toHaveLength(1)
      expect(events[0]?.delta).toBe(5)
      expect(events[0]?.reason).toBe('task_passed')
      // The event names the submission that earned it, like every ledger entry.
      expect(events[0]?.submissionId).toBe(submissionId)
    })

    /**
     * The acceptance criterion is "no unexplained money". Every row a booking
     * writes has to name the submission it came from, or the audit trail has a
     * gap exactly where the payout is.
     */
    it('references the submission on every entry it writes', async () => {
      const submissionId = await aClaimedSubmission()

      await pass(submissionId)

      for (const entry of await entriesFor(submissionId)) {
        expect(entry.reference).toBe(submissionReference(submissionId))
        expect(entry.type).toBe('task_reward')
      }
    })

    it('advances the level, derived from the task that was passed', async () => {
      const agentId = await anAgent()
      const taskId = await aTask({ level: 0 })
      const submissionId = await aClaimedSubmission({ taskId, agentId })

      const written = await pass(submissionId)

      expect(await levelOf(agentId)).toBe(1)
      if (written.outcome === 'recorded') {
        expect(written.booking?.previousLevel).toBe(0)
        expect(written.booking?.level).toBe(1)
      }
    })

    it('does not demote an agent that re-passes a level it already cleared', async () => {
      const agentId = await anAgent(5)
      const taskId = await aTask({ level: 0 })
      const submissionId = await aClaimedSubmission({ taskId, agentId })

      await pass(submissionId)

      expect(await levelOf(agentId)).toBe(5)
    })

    it('is visible to the balance read the moment it commits', async () => {
      const agentId = await anAgent()
      const taskId = await aTask({ coins: 10, reputation: 5 })
      const submissionId = await aClaimedSubmission({ taskId, agentId })

      // No wait, no second poll: `GET /v1/agents/me` reads this function, and an
      // agent that is told its submission passed must be able to see the coin.
      await pass(submissionId)

      expect(await balanceOfAgent(db, agentId)).toEqual({ agentId, coins: 10, reputation: 5 })
    })

    /**
     * A task may teach without paying. `ledger_entries_amount_non_zero` refuses
     * an entry of 0, so the honest booking is no entry at all — the alternative
     * would be two rows recording that the Colony paid nothing.
     */
    it('books no ledger entry for a task that pays no coins', async () => {
      const agentId = await anAgent()
      const taskId = await aTask({ coins: 0, reputation: 3 })
      const submissionId = await aClaimedSubmission({ taskId, agentId })

      const written = await pass(submissionId)

      expect(await entriesFor(submissionId)).toHaveLength(0)
      if (written.outcome === 'recorded') expect(written.booking?.transactionId).toBeNull()
      // The reputation and the level advancement still happen.
      expect(await balanceOfAgent(db, agentId)).toEqual({ agentId, coins: 0, reputation: 3 })
      expect(await levelOf(agentId)).toBe(1)
    })
  })

  /**
   * D-030: a pass grants the task's skills in the same transaction that writes
   * the verdict and books the coins. Same rule the level advance followed —
   * derived from the task, never supplied by a caller — and a stronger reason
   * for it, because a skill decides what the agent may attempt next.
   */
  describe('the skills a pass grants', () => {
    const heldBy = async (agentId: AgentId) =>
      (
        await db
          .select({ skill: agentSkills.skill })
          .from(agentSkills)
          .where(eq(agentSkills.agentId, agentId))
          .orderBy(agentSkills.skill)
      ).map((row) => row.skill)

    it('writes them with the verdict, and reports what changed', async () => {
      const agentId = await anAgent()
      const taskId = await aTask({ grants: ['browser'] })
      const submissionId = await aClaimedSubmission({ taskId, agentId })

      const written = await pass(submissionId)

      expect(written.outcome).toBe('recorded')
      if (written.outcome !== 'recorded') throw new Error(written.outcome)
      expect(written.booking?.grantedSkills).toEqual(['browser'])
      expect(await heldBy(agentId)).toEqual(['browser'])
    })

    it('records which submission earned the skill', async () => {
      const agentId = await anAgent()
      const taskId = await aTask({ grants: ['browser'] })
      const submissionId = await aClaimedSubmission({ taskId, agentId })

      await pass(submissionId)

      const [row] = await db
        .select({ submissionId: agentSkills.submissionId })
        .from(agentSkills)
        .where(eq(agentSkills.agentId, agentId))

      expect(row?.submissionId).toBe(submissionId)
    })

    /**
     * The badge, asserted on the stored rows rather than on a response field:
     * `grants: []` is what makes a task pay without opening anything, and the
     * proof is that nothing was written.
     */
    it('grants nothing for a badge, while still paying it', async () => {
      const agentId = await anAgent()
      const taskId = await aTask({ grants: [], coins: 25 })

      const written = await pass(await aClaimedSubmission({ taskId, agentId }))

      if (written.outcome !== 'recorded') throw new Error(written.outcome)
      expect(written.booking?.coins).toBe(25)
      expect(await heldBy(agentId)).toEqual([])
    })

    it('is idempotent — re-passing an equivalent task grants nothing new', async () => {
      const agentId = await anAgent()
      const first = await aTask({ grants: ['browser'] })
      const second = await aTask({ grants: ['browser'] })

      await pass(await aClaimedSubmission({ taskId: first, agentId }))
      const again = await pass(await aClaimedSubmission({ taskId: second, agentId }))

      if (again.outcome !== 'recorded') throw new Error(again.outcome)
      // Nothing *new* was granted, and the skill is held exactly once. A skill
      // held twice is not a stronger skill.
      expect(again.booking?.grantedSkills).toEqual([])
      expect(await heldBy(agentId)).toEqual(['browser'])
    })

    it('never revokes a skill, whatever happens afterwards', async () => {
      const agentId = await anAgent()
      const granting = await aTask({ grants: ['browser'] })
      await pass(await aClaimedSubmission({ taskId: granting, agentId }))

      await fail(await aClaimedSubmission({ taskId: await aTask(), agentId }))

      expect(await heldBy(agentId)).toEqual(['browser'])
    })

    it('keeps one agent’s pass out of another agent’s record', async () => {
      const holder = await anAgent()
      const bystander = await anAgent()
      const taskId = await aTask({ grants: ['browser'] })

      await pass(await aClaimedSubmission({ taskId, agentId: holder }))

      expect(await heldBy(bystander)).toEqual([])
    })
  })

  describe('anything that is not a pass', () => {
    it('books nothing on a fail, and leaves the level alone', async () => {
      const agentId = await anAgent()
      const submissionId = await aClaimedSubmission({ agentId })

      const written = await fail(submissionId)

      expect(written.outcome).toBe('recorded')
      if (written.outcome === 'recorded') expect(written.booking).toBeUndefined()
      expect(await entriesFor(submissionId)).toHaveLength(0)
      expect(await balanceOfAgent(db, agentId)).toEqual({ agentId, coins: 0, reputation: 0 })
      expect(await levelOf(agentId)).toBe(0)
    })

    it('books nothing when a verifier answers pending', async () => {
      const agentId = await anAgent()
      const submissionId = await aClaimedSubmission({ agentId })

      await recordVerdict(db, {
        submissionId,
        taskType: EXAMPLE_TASK,
        result: { status: 'pending', evidence: 'The transaction has not confirmed yet.' },
      })

      expect(await entriesFor(submissionId)).toHaveLength(0)
      expect(await levelOf(agentId)).toBe(0)
    })
  })

  describe('booking exactly once', () => {
    it('drops a second verdict rather than paying twice', async () => {
      const agentId = await anAgent()
      const taskId = await aTask({ coins: 10, reputation: 5 })
      const submissionId = await aClaimedSubmission({ taskId, agentId })

      await pass(submissionId)
      const second = await pass(submissionId)

      // The submission is no longer `verifying`, so the second verdict is stale
      // and never reaches the booking at all.
      expect(second.outcome).toBe('stale')
      expect(await entriesFor(submissionId)).toHaveLength(2)
      expect(await balanceOfAgent(db, agentId)).toEqual({ agentId, coins: 10, reputation: 5 })
    })

    /**
     * Two runners, two connections, one submission. This is the case the whole
     * arrangement exists for, and it cannot be reached down a single connection:
     * the test pool holds one, so two transactions on it would queue rather than
     * race and the assertion would pass without proving anything.
     */
    it('books once when two runners decide the same submission at once', async () => {
      const agentId = await anAgent()
      const taskId = await aTask({ coins: 10, reputation: 5 })
      const submissionId = await aClaimedSubmission({ taskId, agentId })

      const other = createDatabase(target.available ? target.url : '', {
        max: 1,
        onnotice: () => {},
      })

      try {
        const verdict = {
          submissionId,
          taskType: EXAMPLE_TASK,
          result: { status: 'pass', evidence: 'The payload was well formed.' },
        } as const

        const [first, second] = await Promise.all([
          recordVerdict(db, verdict),
          recordVerdict(other, verdict),
        ])

        // Whichever got there first recorded; the other found the row already
        // decided, because `for update` made it wait rather than read stale.
        expect([first.outcome, second.outcome].sort()).toEqual(['recorded', 'stale'])
      } finally {
        await other.close()
      }

      expect(await entriesFor(submissionId)).toHaveLength(2)
      expect(await balanceOfAgent(db, agentId)).toEqual({ agentId, coins: 10, reputation: 5 })
      expect(await ledgerTotal()).toBe(0)
    })

    /**
     * The guard above is a code check, and a code check is not what the issue
     * asked for: it holds only for callers that go through `recordVerdict`. This
     * is the constraint underneath it, addressed directly — the thing that would
     * still refuse if a future caller booked without reading the status first.
     */
    it('is refused by the database, not only by the status check', async () => {
      const submissionId = await aClaimedSubmission()
      const bookedAt = now()

      await db.transaction((tx) => bookTaskReward(tx, { submissionId, bookedAt }))

      await expectRejection(
        () => db.transaction((tx) => bookTaskReward(tx, { submissionId, bookedAt })),
        /ledger_entries_task_reward_unique/,
      )
    })

    it('refuses a second reputation event for the same submission', async () => {
      const taskId = await aTask({ coins: 0, reputation: 5 })
      const submissionId = await aClaimedSubmission({ taskId })
      const bookedAt = now()

      await db.transaction((tx) => bookTaskReward(tx, { submissionId, bookedAt }))

      // Coins are zero here, so the ledger index cannot be what refuses this one.
      await expectRejection(
        () => db.transaction((tx) => bookTaskReward(tx, { submissionId, bookedAt })),
        /reputation_events_task_passed_unique/,
      )
    })
  })

  /**
   * The property that makes the whole arrangement auditable: whatever mixture of
   * passes, failures and timeouts the Colony has been through, every coin that
   * exists was debited from somewhere. If this ever fails, no other number in
   * the system can be trusted either.
   */
  it('leaves the ledger summing to zero after a run of mixed bookings', async () => {
    const paying = await aTask({ coins: 7, reputation: 2 })
    const generous = await aTask({ coins: 41, reputation: 3 })
    const unpaid = await aTask({ coins: 0, reputation: 1 })

    for (const taskId of [paying, generous, unpaid, paying, generous]) {
      await pass(await aClaimedSubmission({ taskId }))
    }
    for (const taskId of [paying, generous]) {
      await fail(await aClaimedSubmission({ taskId }))
    }

    expect(await ledgerTotal()).toBe(0)

    // And the other side of the same fact: everything the agents hold was minted.
    const [minted] = await db
      .select({ total: sql<string>`coalesce(sum(${ledgerEntries.amount}), 0)::text` })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.accountKind, 'system'))

    expect(Number(minted?.total ?? '0')).toBe(-(7 + 41 + 7 + 41))
  })
})
