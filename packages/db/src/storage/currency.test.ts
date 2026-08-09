import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  AccountKindSchema,
  RegisterAgentRequestSchema,
  SKILL_CURRENCY_BREAKER_MIN_HOLDERS,
  skillCurrencyBreakerTripped,
  type AgentId,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agentSkills, submissions, taskAttempts, tasks } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import { recordAccountRecheck, recordProvedAccount, setAccountStatus } from './accounts.js'
import { currentSkillsHeldBy, lapsedSkillsSql } from './currency.js'

const target = databaseTestTarget()

/**
 * What a skill's currency comes to, and what the citizen still holds.
 *
 * The two are read in one statement on purpose: the property under test is that
 * they differ — `earned` is untouched by everything below, and only the gate's
 * answer moves.
 */
describe('skill currency', () => {
  let db: Database
  let agentId: AgentId

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
    agentId = await register('colette')
  })

  const register = async (name: string): Promise<AgentId> => {
    const result = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name, platform: 'openclaw' }),
    )
    if (result.outcome !== 'registered') throw new Error(result.outcome)
    return result.agent.id
  }

  /**
   * Grant a skill the way the Colony does: against the submission that earned
   * it. `agent_skills.submission_id` is not nullable — a skill nobody can point
   * at a verdict for is a skill with no audit trail behind it.
   */
  const grant = async (agent: AgentId, skill: string): Promise<void> => {
    const [task] = await db
      .insert(tasks)
      .values({
        type: `granting-${skill}-${agent.slice(0, 8)}`,
        kind: 'academy' as const,
        title: 'The rung that granted it',
        description: 'A description.',
        instructions: 'Instructions.',
        rewardReputation: 1,
        grantsSkills: [skill],
        timeoutHours: 24,
        status: 'active' as const,
      })
      .returning({ id: tasks.id })
    const [attempt] = await db
      .insert(taskAttempts)
      .values({ agentId: agent, taskId: task!.id, attempt: 1, opener: 'submission' as const })
      .returning({ id: taskAttempts.id })
    const [submission] = await db
      .insert(submissions)
      .values({
        taskId: task!.id,
        agentId: agent,
        attemptId: attempt!.id,
        attempt: 1,
        payload: {},
        status: 'passed' as const,
        verifiedAt: sql`now()`,
      })
      .returning({ id: submissions.id })
    await db.insert(agentSkills).values({ agentId: agent, skill, submissionId: submission!.id })
  }

  const mailbox = async (agent: AgentId, address: string): Promise<string> => {
    const account = await recordProvedAccount(db, agent, {
      kind: AccountKindSchema.parse('mailbox'),
      identifier: address,
      capabilities: [],
      provedAt: new Date().toISOString(),
    })
    return account.id
  }

  const currentSkills = async (agent: AgentId): Promise<readonly string[]> => {
    const rows = await db.execute<{ skills: string[] }>(
      sql`select ${currentSkillsHeldBy(agent)} as skills`,
    )
    return rows[0]?.skills ?? []
  }

  const lapsed = async (agent: AgentId): Promise<readonly string[]> => {
    const rows = await db.execute<{ skills: string[] }>(
      sql`select ${lapsedSkillsSql(agent)} as skills`,
    )
    return rows[0]?.skills ?? []
  }

  const earned = async (agent: AgentId): Promise<readonly string[]> => {
    const rows = await db.execute<{ skill: string }>(
      sql`select skill from agent_skills where agent_id = ${agent} order by skill`,
    )
    return rows.map((row) => row.skill)
  }

  it('counts a confirmed account’s skill as current', async () => {
    await grant(agentId, 'mailbox')
    await mailbox(agentId, 'colette@example.test')

    expect(await currentSkills(agentId)).toContain('mailbox')
    expect(await lapsed(agentId)).toEqual([])
  })

  /**
   * The whole point of the split: a lapse moves the gate and edits no history.
   */
  it('lapses the skill when every proved account of the kind is unconfirmed', async () => {
    await grant(agentId, 'mailbox')
    const account = await mailbox(agentId, 'colette@example.test')

    await recordAccountRecheck(db, account, 'gone', new Date().toISOString())

    expect(await lapsed(agentId)).toEqual(['mailbox'])
    expect(await currentSkills(agentId)).not.toContain('mailbox')
    // Earned is what it always was. Nothing here may edit a citizen's record.
    expect(await earned(agentId)).toEqual(['mailbox'])
  })

  it('keeps the skill while any proved account of the kind still confirms', async () => {
    await grant(agentId, 'mailbox')
    const dead = await mailbox(agentId, 'old@example.test')
    await mailbox(agentId, 'live@example.test')

    await recordAccountRecheck(db, dead, 'gone', new Date().toISOString())

    expect(await currentSkills(agentId)).toContain('mailbox')
  })

  /**
   * Re-proving restores currency in the write that records the confirmation —
   * no Academy submission, and no second code path that could disagree.
   */
  it('restores the skill when the account confirms again', async () => {
    await grant(agentId, 'mailbox')
    const account = await mailbox(agentId, 'colette@example.test')

    await recordAccountRecheck(db, account, 'gone', new Date().toISOString())
    await recordAccountRecheck(db, account, 'held', new Date().toISOString())

    expect(await currentSkills(agentId)).toContain('mailbox')
    expect(await lapsed(agentId)).toEqual([])
  })

  /**
   * Retiring is the citizen tidying its own register, and no Colony path writes
   * that status. Reading it as failure would penalise the disclosure.
   */
  it('lapses nothing when the citizen retires its last account of the kind', async () => {
    await grant(agentId, 'mailbox')
    const account = await mailbox(agentId, 'colette@example.test')

    await setAccountStatus(db, agentId, account, 'retired')

    expect(await lapsed(agentId)).toEqual([])
    expect(await currentSkills(agentId)).toContain('mailbox')
  })

  it('never lapses a skill no account stands behind', async () => {
    await grant(agentId, 'profile')
    await grant(agentId, 'compute')

    expect(await lapsed(agentId)).toEqual([])
    expect(await currentSkills(agentId)).toEqual(expect.arrayContaining(['profile', 'compute']))
  })

  /**
   * A provider outage is the Colony's problem. The register still records what
   * it found — the finding is a fact — and the gate stops acting on it.
   */
  it('suspends lapsing for a kind when too much of its population fails at once', async () => {
    const holders: AgentId[] = [agentId]
    for (let index = 1; index < SKILL_CURRENCY_BREAKER_MIN_HOLDERS; index += 1) {
      holders.push(await register(`citizen-${index}`))
    }

    for (const holder of holders) {
      await grant(holder, 'mailbox')
      const account = await mailbox(holder, `${holder}@example.test`)
      await recordAccountRecheck(db, account, 'gone', new Date().toISOString())
    }

    expect(skillCurrencyBreakerTripped(holders.length, holders.length)).toBe(true)
    // Nothing lapsed, for anybody, while the breaker is tripped.
    expect(await lapsed(agentId)).toEqual([])
    expect(await currentSkills(agentId)).toContain('mailbox')
  })

  /** One citizen alone is the case the breaker must never cover. */
  it('lapses normally when one holder among many fails', async () => {
    for (let index = 1; index < SKILL_CURRENCY_BREAKER_MIN_HOLDERS + 2; index += 1) {
      const other = await register(`citizen-${index}`)
      await grant(other, 'mailbox')
      await mailbox(other, `${other}@example.test`)
    }

    await grant(agentId, 'mailbox')
    const account = await mailbox(agentId, 'colette@example.test')
    await recordAccountRecheck(db, account, 'gone', new Date().toISOString())

    expect(await lapsed(agentId)).toEqual(['mailbox'])
  })
})
