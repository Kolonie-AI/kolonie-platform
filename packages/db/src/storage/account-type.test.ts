import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  RegisterAgentRequestSchema,
  TaskIdSchema,
  type AgentId,
  type TaskId,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agents, tasks } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import { setAccountType, STATISTICS_EXCLUDING_TEST_ACCOUNTS } from './account-type.js'
import {
  closeAttempt,
  gateFor,
  medianAttemptsToPass,
  openAttempt,
  taskTrouble,
} from './attempts.js'

const target = databaseTestTarget()

const STORAGE = dirname(fileURLToPath(import.meta.url))

/**
 * The contract test, and it needs no database.
 *
 * **`#131` said three call sites and there were ten.** Each had been added
 * correctly; what was missing was anything that says *these numbers exclude test
 * accounts*, so a statistic could be added without its author ever learning they
 * were joining a convention.
 *
 * This fails in both directions — a filter added without being named here, and a
 * name here whose filter has gone — which is the property that makes the list
 * worth keeping. It cannot notice a *new* statistic that forgot to filter at all;
 * nothing short of forcing every aggregate through one helper could, and that was
 * refused as a refactor of four files to enforce what a name and a test enforce
 * for free.
 */
describe('the statistics that exclude test accounts', () => {
  it('are the ones this module names, and there are no others', async () => {
    const files = ['attempts.ts', 'briefing.ts', 'submissions.ts', 'guidance.ts']

    let found = 0
    for (const file of files) {
      const source = await readFile(join(STORAGE, file), 'utf8')
      found += source.split(`eq(agents.type, 'citizen')`).length - 1
    }

    expect(found).toBe(STATISTICS_EXCLUDING_TEST_ACCOUNTS.length)
  })
})

describe('marking an account as a test account', () => {
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
    const result = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name: `probe-${++seeded}`, platform: 'openclaw' }),
    )
    if (result.outcome !== 'registered') throw new Error(result.outcome)
    return result.agent.id
  }

  const aTask = async (): Promise<TaskId> => {
    const [row] = await db
      .insert(tasks)
      .values({
        type: `academy-task-${++seeded}`,
        title: 'A rung',
        description: 'What this task is, for a human reading the catalogue.',
        instructions: 'What the agent must actually do.',
        rewardCredits: 0,
        rewardReputation: 1,
        timeoutHours: 24,
        status: 'active',
      })
      .returning({ id: tasks.id })
    if (row === undefined) throw new Error('insert into tasks returned no row')
    return TaskIdSchema.parse(row.id)
  }

  const typeOf = async (agentId: AgentId): Promise<string> => {
    const [row] = await db
      .select({ type: agents.type })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1)
    if (row === undefined) throw new Error('no agent row')
    return row.type
  }

  const now = (): string => new Date().toISOString()

  const attempt = async (agentId: AgentId, taskId: TaskId, outcome: 'passed' | 'failed') => {
    const opened = await openAttempt(db, { agentId, taskId, opener: 'challenge' })
    await closeAttempt(db, opened.id, outcome)
    return opened
  }

  it('registers every agent as a citizen, which is the defect #131 named', async () => {
    expect(await typeOf(await anAgent())).toBe('citizen')
  })

  it('marks one, which nothing but psql could do before', async () => {
    const agentId = await anAgent()

    const { changed } = await setAccountType(db, { agentId, accountType: 'test', at: now() })

    expect(changed).toBe(true)
    expect(await typeOf(agentId)).toBe('test')
  })

  /**
   * The property `kolonie-infra#48` relied on when it decided marking an existing
   * probe is safe: *the worst outcome of a mistake is an account missing from a
   * statistic, and setting it back fixes that.*
   */
  it('puts one back, so a mistake costs nothing permanent', async () => {
    const agentId = await anAgent()
    await setAccountType(db, { agentId, accountType: 'test', at: now() })

    const { changed } = await setAccountType(db, { agentId, accountType: 'citizen', at: now() })

    expect(changed).toBe(true)
    expect(await typeOf(agentId)).toBe('citizen')
  })

  it('reports that nothing changed rather than pretending it did', async () => {
    const agentId = await anAgent()

    const first = await setAccountType(db, { agentId, accountType: 'test', at: now() })
    const again = await setAccountType(db, { agentId, accountType: 'test', at: now() })

    expect(first.changed).toBe(true)
    expect(again.changed).toBe(false)
  })

  /**
   * The five statistics that had no exclusion test of their own. The other five
   * are covered where they live — `attemptTallies` and `unaidedPassRates` and
   * `capabilityOutcomes` in `attempts.test.ts`, `fieldAnswerRates` in
   * `guidance.test.ts`, `unattendedPasses` in `submissions.test.ts`.
   */
  describe('keeps a marked account out of the numbers', () => {
    it('out of the median attempts to pass', async () => {
      const taskId = await aTask()

      const citizen = await anAgent()
      await attempt(citizen, taskId, 'passed')

      const probe = await anAgent()
      await setAccountType(db, { agentId: probe, accountType: 'test', at: now() })
      for (let i = 0; i < 5; i++) await attempt(probe, taskId, 'passed')

      const [median] = await medianAttemptsToPass(db)

      // One pass by one citizen. The probe's five would drag it upwards.
      expect(median?.median).toBe(1)
    })

    it("out of a task's trouble figure", async () => {
      const taskId = await aTask()

      const citizen = await anAgent()
      await attempt(citizen, taskId, 'passed')

      const probe = await anAgent()
      await setAccountType(db, { agentId: probe, accountType: 'test', at: now() })
      await attempt(probe, taskId, 'failed')
      await attempt(probe, taskId, 'failed')

      const trouble = await taskTrouble(db, taskId)

      expect(trouble.closed).toBe(1)
      expect(trouble.failed).toBe(0)
    })

    /**
     * The one that gates rather than reports, and therefore the one worth being
     * most careful about: a task everybody passes must not start demanding a
     * report because a probe failed it twice.
     */
    it('out of the failure rate that decides whether a citizen is asked to report', async () => {
      const taskId = await aTask()

      // Nine citizen passes, and the one failure below makes ten closed attempts
      // at a tenth failed — comfortably under `GATE_FAILURE_RATE`, which is 0.2
      // and compares with `>=`.
      for (let i = 0; i < 9; i++) await attempt(await anAgent(), taskId, 'passed')

      const probe = await anAgent()
      await setAccountType(db, { agentId: probe, accountType: 'test', at: now() })
      for (let i = 0; i < 6; i++) await attempt(probe, taskId, 'failed')

      // A citizen that has just failed it once. Its own attempt is read
      // unfiltered; what the probe did must not reach the population rate. Were
      // the probe counted, the rate would be seven failures in sixteen — 0.44,
      // and the gate would close.
      const unlucky = await anAgent()
      await attempt(unlucky, taskId, 'failed')

      expect((await gateFor(db, unlucky, taskId)).outcome).toBe('open')
    })
  })
})
