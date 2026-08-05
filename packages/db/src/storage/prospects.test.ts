import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { RegisterAgentRequestSchema, type AgentId, type TaskId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { sql } from 'drizzle-orm'
import {
  autonomyContracts,
  autonomyFormInvitations,
  operatorClaims,
  permissionReports,
  taskAttempts,
  taskReports,
  tasks,
} from '../schema/index.js'
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

  /** A closed attempt that passed, which is what an unwritten route is made of. */
  const aPass = async (agentId: AgentId, taskId: TaskId, attempt = 1): Promise<string> => {
    const [row] = await db
      .insert(taskAttempts)
      .values({
        agentId,
        taskId,
        attempt,
        opener: 'submission' as const,
        outcome: 'passed' as const,
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
      passUnreported: null,
      // An arriving citizen has no contract to renew (`#392`), and its first one
      // is `kolonie.autonomy.ask`'s own business rather than this section's.
      renewal: null,
    })
  })

  /**
   * **The other half of the same silence** (`#365`).
   *
   * 48 of 159 submissions carried a report on 2026-08-05, and the submit tool's
   * claim that it is *"the only moment you will be asked"* was literally true.
   * This is what asks a second time.
   */
  describe('a task passed and never reported on', () => {
    it('names it, on one pass and with no second failure needed', async () => {
      const agentId = await anAgent('quiet-winner')
      const taskId = await aRung('Prove you control a domain')
      await aPass(agentId, taskId)

      const { passUnreported } = await openProspects(db, agentId)

      expect(passUnreported?.taskId).toBe(taskId)
    })

    /**
     * The rejection case the definition of done asks for: neither hint fires for
     * an attempt that already carries a report.
     */
    it('says nothing once the citizen has reported on that task', async () => {
      const agentId = await anAgent('spoke-up')
      const taskId = await aRung('Prove you control a domain')
      const attemptId = await aPass(agentId, taskId)
      await db.insert(taskReports).values({
        attemptId,
        did: 'Took the second provider on the list and it went through first time.',
      })

      expect((await openProspects(db, agentId)).passUnreported).toBeNull()
    })

    /** A pass on one task says nothing about silence on another. */
    it('names the task it actually passed, not a neighbour', async () => {
      const agentId = await anAgent('two-rungs')
      const passed = await aRung('Prove you control a domain')
      const other = await aRung('Receive mail at your own address')
      await aPass(agentId, passed)
      await aFailure(agentId, other, 1)

      expect((await openProspects(db, agentId)).passUnreported?.taskId).toBe(passed)
    })
  })

  /**
   * The autonomy contract, when it is worth asking about again (`#392`).
   *
   * **Two conditions and only two**, because anything broader is a nag. The
   * pairs below are this file's own rule: the condition holding, and the
   * condition cleared by the act the entry names — which here is asking, since
   * an invitation minted after the condition arose is the citizen having acted
   * on it.
   */
  describe('the autonomy contract, once it is worth asking about again', () => {
    const aContract = async (agentId: AgentId, reviewDueAt: string): Promise<void> => {
      await db.insert(autonomyContracts).values({
        agentId,
        level: 'free',
        challengesAllowed: true,
        defaultRule: 'ask',
        operatorRoute: 'ask me',
        reviewDueAt,
      })
    }

    const aBlock = async (agentId: AgentId, taskId: TaskId, filedAt: string): Promise<void> => {
      await db.insert(permissionReports).values({
        agentId,
        taskId,
        block: 'other',
        needed: 'permission to do the thing this rung is actually about',
        filedAt,
      })
    }

    const anInvitation = async (agentId: AgentId, createdAt: string): Promise<void> => {
      await db.insert(autonomyFormInvitations).values({
        agentId,
        operatorAddress: 'someone@example.org',
        token: `token-${createdAt}-${String(agentId)}`,
        createdAt,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      })
    }

    const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString()
    const ahead = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString()

    it('is offered when the contract is past its review date', async () => {
      const agentId = await anAgent('overdue')
      await aContract(agentId, ago(1))

      expect((await openProspects(db, agentId)).renewal).toEqual({ why: 'stale' })
    })

    it('is offered when the citizen recorded a block its contract does not cover', async () => {
      const agentId = await anAgent('blocked')
      await aContract(agentId, ahead(30))
      await aBlock(agentId, await aRung('A rung it could not get permission for'), ago(1))

      expect((await openProspects(db, agentId)).renewal).toEqual({ why: 'blocked' })
    })

    /**
     * **The bound.** A current contract and nothing recorded is the ordinary
     * state, and it is offered nothing — an entry that appeared every waking
     * regardless is the standing menu `#326` refuses.
     */
    it('is not offered to a citizen with a current contract and no recorded block', async () => {
      const agentId = await anAgent('settled')
      await aContract(agentId, ahead(30))

      expect((await openProspects(db, agentId)).renewal).toBeNull()
    })

    /**
     * Once per condition rather than once per waking, and it needs no record of
     * its own: an invitation minted after the condition arose *is* the record.
     */
    it('is not offered again once the citizen has asked about this staleness', async () => {
      const agentId = await anAgent('asked-already')
      await aContract(agentId, ago(10))
      await anInvitation(agentId, ago(1))

      expect((await openProspects(db, agentId)).renewal).toBeNull()
    })

    it('is offered again when the contract goes stale after the last asking', async () => {
      const agentId = await anAgent('stale-again')
      await anInvitation(agentId, ago(10))
      await aContract(agentId, ago(1))

      expect((await openProspects(db, agentId)).renewal).toEqual({ why: 'stale' })
    })

    it('is not offered again once the citizen has asked about this block', async () => {
      const agentId = await anAgent('asked-about-the-block')
      await aContract(agentId, ahead(30))
      await aBlock(agentId, await aRung('A second rung it could not get permission for'), ago(5))
      await anInvitation(agentId, ago(1))

      expect((await openProspects(db, agentId)).renewal).toBeNull()
    })

    /**
     * A citizen with no contract at all is offered nothing here, and that is not
     * an omission: its first contract is `kolonie.autonomy.ask`'s own business
     * and the arrival path already carries it.
     */
    it('is not offered to a citizen that has no contract yet', async () => {
      const agentId = await anAgent('no-contract')

      expect((await openProspects(db, agentId)).renewal).toBeNull()
    })

    /** Reading it consumes nothing, so two wake-ups in a row read the same. */
    it('reads the same twice', async () => {
      const agentId = await anAgent('twice')
      await aContract(agentId, ago(1))

      expect((await openProspects(db, agentId)).renewal).toEqual(
        (await openProspects(db, agentId)).renewal,
      )
    })
  })
})
