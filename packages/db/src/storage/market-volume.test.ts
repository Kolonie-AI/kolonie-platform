import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import type { AgentId, HumanId, TaskId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agents, tasks } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { colonyNumbers } from './colony-numbers.js'
import { findOrCreateHuman } from './humans.js'
import { issueCodeForHuman, redeemCodeAsAgent } from './human-links.js'
import { createSubmission } from './submissions.js'
import { claimNextSubmission, recordVerdict } from './verifications.js'

const target = databaseTestTarget()

/**
 * Only cross-swarm work counts as market volume (D-107, `#513`).
 *
 * The rule answers two problems at once and the tests are grouped by them:
 * money moving in a circle must buy no figure, and a swarm that trades only
 * internally must be visible in the one number that means anything. What is
 * asserted beside both is the negative half — that the classification decides
 * nothing about the money or the standing.
 */
describe('what counts as market volume', () => {
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

  const aPerson = async (subject: string): Promise<HumanId> => {
    const { human } = await findOrCreateHuman(db, {
      provider: 'github',
      subject,
      email: `${subject}@example.org`,
    })
    return human.id
  }

  const operating = async (humanId: HumanId, agentId: AgentId): Promise<void> => {
    const { code } = await issueCodeForHuman(db, humanId)
    const result = await redeemCodeAsAgent(db, code, agentId)
    if (result.outcome !== 'linked') throw new Error(result.outcome)
  }

  const aQuestFrom = async (sponsor: AgentId | null): Promise<TaskId> => {
    const [row] = await db
      .insert(tasks)
      .values({
        type: 'quest-report',
        kind: 'quest' as const,
        title: 'A thousand registrations',
        description: 'What this quest is.',
        instructions: 'Register and report.',
        rewardCredits: 0,
        rewardReputation: 1,
        slots: 10,
        audience: 'candidates' as const,
        timeoutHours: 24,
        status: 'active' as const,
        createdBy: sponsor,
        questions: [{ key: 'how', prompt: 'How did it go?', required: true }],
      })
      .returning({ id: tasks.id })
    return row!.id as TaskId
  }

  /**
   * An Academy rung: no sponsor, and not a quest.
   *
   * No `questions`, because `tasks_questions_belong_to_quests` refuses them —
   * which is itself the clearest statement of why a rung is in neither figure.
   */
  const aRung = async (): Promise<TaskId> => {
    const [row] = await db
      .insert(tasks)
      .values({
        type: 'quest-report',
        kind: 'academy' as const,
        title: 'A rung the Academy carries',
        description: 'What this task is.',
        instructions: 'What the agent must do.',
        rewardCredits: 0,
        rewardReputation: 1,
        timeoutHours: 24,
        status: 'active' as const,
      })
      .returning({ id: tasks.id })
    return row!.id as TaskId
  }

  const answer = async (
    taskId: TaskId,
    agentId: AgentId,
    status: 'pass' | 'fail' = 'pass',
    payload: Record<string, unknown> = { answers: { how: 'It went well enough.' } },
  ): Promise<void> => {
    const created = await createSubmission(db, {
      taskId,
      agentId,
      payload,
      assistance: 'none',
    })
    if (created.outcome !== 'accepted') throw new Error(created.outcome)

    const claimed = await claimNextSubmission(db, ['quest-report' as never])
    if (claimed === undefined) throw new Error('nothing to claim')

    const recorded = await recordVerdict(db, {
      submissionId: claimed.submission.id,
      taskType: 'quest-report' as never,
      result:
        status === 'pass'
          ? { status: 'pass', evidence: 'The report answers the questions.' }
          : { status: 'fail', evidence: 'It does not answer the questions.' },
    })
    if (recorded.outcome !== 'recorded') throw new Error(recorded.outcome)
  }

  const classificationOf = async (agentId: AgentId): Promise<boolean | null> => {
    const [row] = await db.execute<{ intra_swarm: boolean | null }>(
      sql`select intra_swarm from submissions where agent_id = ${agentId}
           order by submitted_at desc limit 1`,
    )
    return row?.intra_swarm ?? null
  }

  describe('the classification, stamped at acceptance', () => {
    it('calls a report from another person’s agent market', async () => {
      const mine = await aPerson('mine')
      const theirs = await aPerson('theirs')
      const sponsor = await anAgent('sponsor')
      const answerer = await anAgent('answerer')
      await operating(mine, sponsor)
      await operating(theirs, answerer)

      await answer(await aQuestFrom(sponsor), answerer)

      expect(await classificationOf(answerer)).toBe(false)
    })

    it('calls a report from a sibling internal', async () => {
      const person = await aPerson('one-operator')
      const sponsor = await anAgent('sponsor')
      const answerer = await anAgent('answerer')
      await operating(person, sponsor)
      await operating(person, answerer)

      await answer(await aQuestFrom(sponsor), answerer)

      expect(await classificationOf(answerer)).toBe(true)
    })

    /**
     * The cautious direction (`#510`): unknown is a swarm of one, so two agents
     * that both declared nothing are not thereby siblings. The alternative would
     * silently file strangers' work as internal.
     */
    it('treats two agents nobody operates as two swarms', async () => {
      const sponsor = await anAgent('sponsor')
      const answerer = await anAgent('answerer')

      await answer(await aQuestFrom(sponsor), answerer)

      expect(await classificationOf(answerer)).toBe(false)
    })

    it('leaves an Academy rung unclassified, because it is neither', async () => {
      const climber = await anAgent('climber')

      await answer(await aRung(), climber, 'pass', {})

      expect(await classificationOf(climber)).toBeNull()
    })

    it('classifies nothing that was not accepted', async () => {
      const sponsor = await anAgent('sponsor')
      const answerer = await anAgent('answerer')

      await answer(await aQuestFrom(sponsor), answerer, 'fail')

      expect(await classificationOf(answerer)).toBeNull()
    })

    /**
     * A quest whose author has been erased cannot be classified honestly, and
     * `null` says exactly that rather than guessing at *not internal*.
     */
    it('leaves a quest with no author unclassified', async () => {
      const answerer = await anAgent('answerer')

      await answer(await aQuestFrom(null), answerer)

      expect(await classificationOf(answerer)).toBeNull()
    })
  })

  describe('the figures', () => {
    it('counts the two separately', async () => {
      const person = await aPerson('one-operator')
      const stranger = await aPerson('stranger')
      const sponsor = await anAgent('sponsor')
      const sibling = await anAgent('sibling')
      const outsider = await anAgent('outsider')
      await operating(person, sponsor)
      await operating(person, sibling)
      await operating(stranger, outsider)
      const quest = await aQuestFrom(sponsor)

      await answer(quest, sibling)
      await answer(quest, outsider)

      const numbers = await colonyNumbers(db)

      expect(numbers.acceptedQuestReports).toEqual({ market: 1, intraSwarm: 1 })
    })

    /**
     * **No total, anywhere.** One number covering both would be the flattery
     * `accountsByPath` already refuses, and the object is the place it would be
     * added first.
     */
    it('offers no combined figure to add them into', async () => {
      const numbers = await colonyNumbers(db)

      expect(Object.keys(numbers.acceptedQuestReports).sort()).toEqual(['intraSwarm', 'market'])
    })

    it('counts no Academy rung in either figure', async () => {
      const climber = await anAgent('climber')
      await answer(await aRung(), climber, 'pass', {})

      expect(await colonyNumbers(db)).toMatchObject({
        acceptedQuestReports: { market: 0, intraSwarm: 0 },
      })
    })
  })

  /**
   * **Not a payment rule and not a reputation rule** (D-107). Intra-swarm work
   * is paid exactly as any other and earns the same standing, so the column is
   * read by nothing that books money or grants anything — asserted at the level
   * where it could stop being true, on `accounts.test.ts`' pattern.
   */
  it('is read by nothing that pays, grants or ranks', () => {
    const forbidden = [
      'rewards.ts',
      'balance.ts',
      'skills.ts',
      'citizenship.ts',
      'escrow.ts',
      'payouts.ts',
    ]

    for (const file of forbidden) {
      const source = readFileSync(fileURLToPath(new URL(`./${file}`, import.meta.url)), 'utf8')

      expect(source.includes('intraSwarm'), `${file} must not read the classification`).toBe(false)
      expect(source.includes('intra_swarm'), `${file} must not read the classification`).toBe(false)
    }
  })
})
