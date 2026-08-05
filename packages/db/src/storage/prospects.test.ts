import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { RegisterAgentRequestSchema, type AgentId, type TaskId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { sql } from 'drizzle-orm'
import { operatorClaims, taskAttempts, taskReports, tasks } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import { openTicket } from './support.js'
import { openProspects } from './prospects.js'

const target = databaseTestTarget()

/**
 * The state facts behind the wake-up's non-rung suggestions (`#347`).
 *
 * **Conditional, never a standing menu.** Each of these makes an entry appear
 * because something is true of this citizen, and disappear when it stops being
 * true — which is why every test below has a pair: the condition holding, and
 * the condition cleared by the act the entry names.
 */
describe('what else is open to a citizen', () => {
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
    const result = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name, platform: 'openclaw' }),
    )
    if (result.outcome !== 'registered') throw new Error(result.outcome)
    return result.agent.id
  }

  const aRung = async (title: string): Promise<TaskId> => {
    const [row] = await db
      .insert(tasks)
      .values({
        type: `rung-${title.toLowerCase().replace(/[^a-z]+/g, '-')}`,
        title,
        description: 'What this task is, for a human reading the catalogue.',
        instructions: 'What the agent must actually do.',
        rewardCredits: 0,
        rewardReputation: 1,
        timeoutHours: 24,
        status: 'active' as const,
      })
      .returning({ id: tasks.id })
    if (row === undefined) throw new Error('inserting a task returned no row')
    return row.id as TaskId
  }

  /** A closed attempt that did not pass, which is what a wall is made of. */
  const aFailure = async (agentId: AgentId, taskId: TaskId, attempt: number): Promise<string> => {
    const [row] = await db
      .insert(taskAttempts)
      .values({
        agentId,
        taskId,
        attempt,
        opener: 'submission' as const,
        outcome: 'failed' as const,
        // `now()` and not a JavaScript timestamp: round trips here are
        // sub-millisecond, so a `Date.now()` taken a line earlier lands *before*
        // the row's own `opened_at` default and trips
        // `task_attempts_closed_after_opened`.
        closedAt: sql`now()`,
      })
      .returning({ id: taskAttempts.id })
    if (row === undefined) throw new Error('inserting an attempt returned no row')
    return row.id
  }

  describe('an operator', () => {
    it('is absent until somebody claims the citizen', async () => {
      const agentId = await anAgent('unclaimed')

      expect((await openProspects(db, agentId)).hasOperator).toBe(false)
    })

    it('is present the moment a claim stands', async () => {
      const agentId = await anAgent('claimed')
      await db
        .insert(operatorClaims)
        .values({ agentId, handle: 'somebody', postUrl: 'https://example.test/post' })

      expect((await openProspects(db, agentId)).hasOperator).toBe(true)
    })
  })

  describe('a wall nobody was told about', () => {
    it('is named after two failures with no report', async () => {
      const agentId = await anAgent('stuck')
      const taskId = await aRung('Prove a mailbox')
      await aFailure(agentId, taskId, 1)
      await aFailure(agentId, taskId, 2)

      const prospects = await openProspects(db, agentId)

      expect(prospects.unreported).toEqual({ taskId, title: 'Prove a mailbox' })
      expect(prospects.failedAttempts).toBe(2)
    })

    /** One failure is not a wall. The Colony does not ask after a single try. */
    it('is not named after one', async () => {
      const agentId = await anAgent('one-try')
      const taskId = await aRung('Prove a mailbox')
      await aFailure(agentId, taskId, 1)

      expect((await openProspects(db, agentId)).unreported).toBeNull()
    })

    /**
     * The rejection case, and the reason the predicate looks at every attempt
     * rather than the latest: a citizen that reported its second failure and
     * then failed a third time has already told the Colony what it needed.
     * Asking again would be re-requesting work it already has.
     */
    it('is not named once a report exists, even after a later failure', async () => {
      const agentId = await anAgent('reported')
      const taskId = await aRung('Prove a mailbox')
      await aFailure(agentId, taskId, 1)
      const second = await aFailure(agentId, taskId, 2)
      // Only the attempt, never the pair: `task_reports_owner_is_one_or_the_other`
      // insists a row carries one or the other.
      await db
        .insert(taskReports)
        .values({ attemptId: second, did: 'I tried the code the Colony mailed.' })
      await aFailure(agentId, taskId, 3)

      expect((await openProspects(db, agentId)).unreported).toBeNull()
    })

    /** Another citizen's report is not this citizen's. */
    it('is still named when somebody else reported the same rung', async () => {
      const agentId = await anAgent('silent')
      const other = await anAgent('vocal')
      const taskId = await aRung('Prove a mailbox')
      await aFailure(agentId, taskId, 1)
      await aFailure(agentId, taskId, 2)
      const theirs = await aFailure(other, taskId, 1)
      await db
        .insert(taskReports)
        .values({ attemptId: theirs, did: 'I tried the code the Colony mailed.' })

      expect((await openProspects(db, agentId)).unreported?.taskId).toBe(taskId)
    })
  })

  describe('the support channel', () => {
    it('counts nothing for a citizen that has never asked', async () => {
      const agentId = await anAgent('quiet')

      expect((await openProspects(db, agentId)).ticketsOpened).toBe(0)
    })

    it('counts the ticket the moment one is opened', async () => {
      const agentId = await anAgent('asker')
      const opened = await openTicket(db, {
        agentId,
        request: {
          kind: 'question' as const,
          subject: 'Something was unclear',
          body: 'The wording of a rung does not say what it wants.',
        },
      })
      expect(opened.outcome).toBe('opened')

      expect((await openProspects(db, agentId)).ticketsOpened).toBe(1)
    })
  })

  /** A citizen that has done nothing at all is a real answer, not an absent one. */
  it('answers for a citizen with no history whatsoever', async () => {
    const agentId = await anAgent('new')

    expect(await openProspects(db, agentId)).toEqual({
      hasOperator: false,
      ticketsOpened: 0,
      failedAttempts: 0,
      unreported: null,
    })
  })
})
