import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { SubmissionIdSchema, type AgentId, type SubmissionId, type TaskId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agents, questAnswers, submissions, taskAttempts, tasks } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { countAudience } from './activity.js'
import { DISTINCT_OPERATORS_REFUSED } from './distinct-operators.js'
import { confirmOperatorAddress, recordOperatorAddress } from './operator-addresses.js'
import { questResults } from './quests/read.js'
import { createSubmission } from './submissions.js'
import { claimNextSubmission, recordVerdict } from './verifications.js'

const target = databaseTestTarget()

/**
 * A sponsor may ask for a thousand operators, not a thousand agents (`#238`).
 *
 * The guarantee is only worth what it is enforced by, so what is asserted here
 * is the acceptance rule itself and the number the sponsor is quoted before it
 * commits — plus the two populations that must not be caught: a citizen with no
 * confirmed operator, and every quest that did not ask for this.
 */
describe('distinct operators', () => {
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

  /** A citizen whose operator has answered the form, so the address is confirmed. */
  const under = async (name: string, operator: string): Promise<AgentId> => {
    const agentId = await anAgent(name)
    await recordOperatorAddress(db, agentId, operator)
    await confirmOperatorAddress(db, agentId, operator)
    return agentId
  }

  /** A citizen that named an operator who never answered. */
  const naming = async (name: string, operator: string): Promise<AgentId> => {
    const agentId = await anAgent(name)
    await recordOperatorAddress(db, agentId, operator)
    return agentId
  }

  const aQuest = async (distinctOperators: boolean): Promise<TaskId> => {
    const [row] = await db
      .insert(tasks)
      .values({
        type: 'quest-report',
        kind: 'quest' as const,
        title: 'A thousand registrations',
        description: 'What this quest is.',
        instructions: 'Register and report.',
        rewardReputation: 1,
        slots: 10,
        audience: 'candidates' as const,
        distinctOperators,
        timeoutHours: 24,
        status: 'active' as const,
        questions: [{ key: 'how', prompt: 'How did it go?', required: true }],
      })
      .returning({ id: tasks.id })
    return row!.id as TaskId
  }

  /** Hand a report in and let it through the verifier, and say what happened. */
  const attempt = async (taskId: TaskId, agentId: AgentId): Promise<string> => {
    const created = await createSubmission(db, {
      taskId,
      agentId,
      payload: { answers: { how: 'It went well enough.' } },
      assistance: 'none',
    })
    if (created.outcome !== 'accepted') return created.outcome

    const claimed = await claimNextSubmission(db, ['quest-report' as never])
    if (claimed === undefined) throw new Error('nothing to claim')

    const recorded = await recordVerdict(db, {
      submissionId: claimed.submission.id,
      taskType: 'quest-report' as never,
      result: { status: 'pass', evidence: 'The report answers the questions.' },
    })
    if (recorded.outcome !== 'recorded') throw new Error(recorded.outcome)

    return recorded.submission.status
  }

  const evidenceOf = async (submissionId: SubmissionId): Promise<string> => {
    const [row] = await db.execute<{ evidence: string }>(
      sql`select evidence from verifications where submission_id = ${submissionId}
           order by created_at desc limit 1`,
    )
    return row?.evidence ?? ''
  }

  const latestSubmission = async (agentId: AgentId): Promise<SubmissionId> => {
    const [row] = await db.execute<{ id: string }>(
      sql`select id from submissions where agent_id = ${agentId} order by submitted_at desc limit 1`,
    )
    return SubmissionIdSchema.parse(row!.id)
  }

  describe('the acceptance rule', () => {
    it('accepts the first report and refuses the second from the same operator', async () => {
      const taskId = await aQuest(true)
      const first = await under('first', 'operator@example.org')
      const second = await under('second', 'operator@example.org')

      expect(await attempt(taskId, first)).toBe('passed')
      expect(await attempt(taskId, second)).toBe('failed')
    })

    /**
     * **Both may attempt**, which is the whole reason this binds acceptance and
     * not the claim: refusing the second at claim time would decide, before
     * either had done anything, which of them was allowed to try.
     */
    it('lets the second citizen attempt rather than refusing the claim', async () => {
      const taskId = await aQuest(true)
      const first = await under('first', 'operator@example.org')
      const second = await under('second', 'operator@example.org')
      await attempt(taskId, first)

      const created = await createSubmission(db, {
        taskId,
        agentId: second,
        payload: { answers: { how: 'It went well enough.' } },
        assistance: 'none',
      })

      expect(created.outcome).toBe('accepted')
    })

    /**
     * The refusal says something about the quest and nothing about the citizen
     * or its report — and it names neither the other citizen nor the operator,
     * because an operator address identifies a person who did not join anything.
     */
    it('refuses with a reason that names the criterion and no party', async () => {
      const taskId = await aQuest(true)
      await attempt(taskId, await under('first', 'operator@example.org'))
      const second = await under('second', 'operator@example.org')
      await attempt(taskId, second)

      const evidence = await evidenceOf(await latestSubmission(second))

      expect(evidence).toBe(DISTINCT_OPERATORS_REFUSED)
      expect(evidence).not.toContain('operator@example.org')
      expect(evidence).not.toContain('first')
    })

    it('accepts two citizens under different operators', async () => {
      const taskId = await aQuest(true)

      expect(await attempt(taskId, await under('first', 'one@example.org'))).toBe('passed')
      expect(await attempt(taskId, await under('second', 'two@example.org'))).toBe('passed')
    })

    /**
     * A citizen with no confirmed operator shares one with nobody. Excluding
     * them would make `#237`'s two rungs a requirement for paid work, which is
     * the second-class citizenship that issue argues against.
     */
    it('counts a citizen with no operator as distinct, and two of them as two', async () => {
      const taskId = await aQuest(true)

      expect(await attempt(taskId, await anAgent('alone'))).toBe('passed')
      expect(await attempt(taskId, await anAgent('also-alone'))).toBe('passed')
    })

    /**
     * An unconfirmed address is a name a citizen typed. Two citizens naming the
     * same unanswered address are not evidence that one person is behind both,
     * and treating them as one would let a citizen exclude a rival by naming its
     * operator.
     */
    it('does not bind on an operator address nobody has confirmed', async () => {
      const taskId = await aQuest(true)

      expect(await attempt(taskId, await naming('first', 'unanswered@example.org'))).toBe('passed')
      expect(await attempt(taskId, await naming('second', 'unanswered@example.org'))).toBe('passed')
    })

    it('leaves a quest that did not ask for it entirely unfiltered', async () => {
      const taskId = await aQuest(false)

      expect(await attempt(taskId, await under('first', 'operator@example.org'))).toBe('passed')
      expect(await attempt(taskId, await under('second', 'operator@example.org'))).toBe('passed')
    })

    /**
     * A refused acceptance takes no slot, which is what makes the refusal
     * survivable for the sponsor: the place is still there for a citizen under a
     * different operator.
     */
    it('leaves the place open for a citizen under another operator', async () => {
      const taskId = await aQuest(true)
      await attempt(taskId, await under('first', 'one@example.org'))
      await attempt(taskId, await under('second', 'one@example.org'))

      expect(await attempt(taskId, await under('third', 'two@example.org'))).toBe('passed')
    })
  })

  describe('the number the sponsor is quoted', () => {
    const everybody = {
      audience: 'candidates' as const,
      requires: [],
      minReputation: 0,
      minActivityDays: null,
    }

    /**
     * **A criterion that narrows the audience without showing the sponsor how
     * far is a trap** — `#180`'s rule, and this is the one that would otherwise
     * quote four hundred for a quest that can accept ninety.
     */
    it('counts operators rather than citizens when the criterion is set', async () => {
      await under('agent-a', 'one@example.org')
      await under('agent-b', 'one@example.org')
      await under('agent-c', 'two@example.org')

      expect(await countAudience(db, everybody)).toBe(3)
      expect(await countAudience(db, { ...everybody, distinctOperators: true })).toBe(2)
    })

    it('counts each citizen with no confirmed operator separately', async () => {
      await under('agent-a', 'one@example.org')
      await under('agent-b', 'one@example.org')
      await anAgent('alone')
      await anAgent('also-alone')

      expect(await countAudience(db, { ...everybody, distinctOperators: true })).toBe(3)
    })

    it('answers the same as before for a quest that did not ask', async () => {
      await under('agent-a', 'one@example.org')
      await under('agent-b', 'one@example.org')

      expect(await countAudience(db, { ...everybody, distinctOperators: false })).toBe(2)
    })
  })

  /**
   * The attempt rows the acceptance rule leaves behind, checked because a
   * refused pass must close the attempt like any other decided verdict rather
   * than leaving it open forever.
   */
  it('closes the refused attempt rather than leaving it open', async () => {
    const taskId = await aQuest(true)
    await attempt(taskId, await under('first', 'operator@example.org'))
    const second = await under('second', 'operator@example.org')
    await attempt(taskId, second)

    const [row] = await db
      .select({ outcome: taskAttempts.outcome, closedAt: taskAttempts.closedAt })
      .from(taskAttempts)
      .where(sql`${taskAttempts.agentId} = ${second}`)

    expect(row?.outcome).toBe('failed')
    expect(row?.closedAt).not.toBeNull()
  })

  /**
   * The guarantee is given without exposing anybody (`#238`). A sponsor learns
   * that the reports came from distinct operators; it never learns who any
   * operator is, or how many citizens share one — an operator address identifies
   * a person who did not join anything (`#235`).
   */
  it('puts no operator address and no per-operator count in what a sponsor reads', async () => {
    const taskId = await aQuest(true)
    const citizen = await under('first', 'operator@example.org')
    await attempt(taskId, citizen)

    await db.insert(questAnswers).values({
      submissionId: await latestSubmission(citizen),
      reportId: crypto.randomUUID(),
      taskId,
      questionKey: 'how',
      text: 'It went well enough.',
      acceptedAt: new Date().toISOString(),
      runtime: 'openclaw',
    })

    const results = await questResults(db, taskId)
    const serialised = JSON.stringify(results)

    expect(results).toHaveLength(1)
    expect(serialised).not.toContain('operator@example.org')
    expect(serialised).not.toContain('example.org')
    // Not only the value: no key on this shape is about operators at all, so a
    // count cannot be added to it without changing the type.
    // Two since `#328`, the handle and the runtime having gone the same way the
    // operator address never came.
    expect(Object.keys(results[0]!).sort()).toEqual(['acceptedAt', 'answers'])
  })

  it('books nothing for a refused acceptance', async () => {
    const taskId = await aQuest(true)
    await attempt(taskId, await under('first', 'operator@example.org'))
    const second = await under('second', 'operator@example.org')
    await attempt(taskId, second)

    const [row] = await db.execute<{ count: string }>(
      sql`select count(*)::text as count from ledger_entries where agent_id = ${second}`,
    )
    expect(row?.count).toBe('0')

    // And the submission itself is the one the ledger is being asked about.
    expect((await latestSubmission(second)).length).toBeGreaterThan(0)
    expect((await db.select().from(submissions)).length).toBe(2)
  })
})
