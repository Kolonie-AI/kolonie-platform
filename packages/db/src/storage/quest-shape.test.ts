import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import type { AgentId, TaskId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agents, agentSkills, submissions, taskAttempts, tasks } from '../schema/index.js'
import { connectForTests, databaseTestTarget, expectRejection, truncateAll } from '../testing.js'
import { createSubmission } from './submissions.js'
import { listTasks } from './tasks.js'
import { seedAcademyTasks } from '../academy-tasks.js'

const target = databaseTestTarget()

/**
 * A quest is for a population: capacity, an expiry, an audience floor, and one
 * accepted submission per citizen (`#175`).
 *
 * The Academy's own shape is asserted here too, in the places where it and a
 * quest differ — an Academy rung is for everybody, once each, forever, and every
 * one of the rules below has to leave that untouched.
 */
describe('a task for a thousand citizens', () => {
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

  const anAgent = async (
    name: string,
    status: 'candidate' | 'citizen' = 'citizen',
  ): Promise<AgentId> => {
    const [row] = await db
      .insert(agents)
      .values({ name, platform: 'openclaw', status })
      .returning({ id: agents.id })
    if (row === undefined) throw new Error('inserting an agent returned no row')
    return row.id as AgentId
  }

  interface QuestSeed {
    readonly slots?: number | null
    readonly expiresAt?: string | null
    readonly audience?: 'citizens' | 'candidates'
    readonly requires?: string[]
    readonly rewardCredits?: number
  }

  const aQuest = async (seed: QuestSeed = {}): Promise<TaskId> => {
    const [row] = await db
      .insert(tasks)
      .values({
        type: 'quest-report',
        kind: 'quest' as const,
        title: 'A thousand registrations',
        description: 'What this quest is, for a human reading the catalogue.',
        instructions: 'Register an account and tell us what happened.',
        rewardCredits: seed.rewardCredits ?? 1,
        rewardReputation: 1,
        requiresSkills: seed.requires ?? [],
        slots: seed.slots === undefined ? 2 : seed.slots,
        expiresAt: seed.expiresAt ?? null,
        audience: seed.audience ?? 'citizens',
        timeoutHours: 24,
        status: 'active' as const,
      })
      .returning({ id: tasks.id })
    if (row === undefined) throw new Error('inserting a quest returned no row')
    return row.id as TaskId
  }

  const submit = (taskId: TaskId, agentId: AgentId) =>
    createSubmission(db, { taskId, agentId, payload: { note: 'done' }, assistance: 'none' })

  /**
   * Grant a skill the way the Colony does: against the submission that earned
   * it. `agent_skills.submission_id` is not nullable — a skill nobody can point
   * at a verdict for is a skill with no audit trail behind it.
   */
  const grantSkill = async (agentId: AgentId, skill: string): Promise<void> => {
    const [row] = await db
      .insert(tasks)
      .values({
        type: 'granting-rung',
        kind: 'academy' as const,
        title: 'The rung that granted it',
        description: 'A description.',
        instructions: 'Instructions.',
        rewardCredits: 0,
        rewardReputation: 1,
        grantsSkills: [skill],
        timeoutHours: 24,
        status: 'active' as const,
      })
      .returning({ id: tasks.id })
    const [attempt] = await db
      .insert(taskAttempts)
      .values({ agentId, taskId: row!.id, attempt: 1, opener: 'submission' as const })
      .returning({ id: taskAttempts.id })
    const [submission] = await db
      .insert(submissions)
      .values({
        taskId: row!.id,
        agentId,
        attemptId: attempt!.id,
        attempt: 1,
        payload: {},
        status: 'passed' as const,
        verifiedAt: sql`now()`,
      })
      .returning({ id: submissions.id })
    await db.insert(agentSkills).values({ agentId, skill, submissionId: submission!.id })
  }

  /** Take a slot the way an accepted report does: a submission that passed. */
  const passed = async (taskId: TaskId, agentId: AgentId, attempt = 1) => {
    const [row] = await db
      .insert(taskAttempts)
      .values({ agentId, taskId, attempt, opener: 'submission' as const })
      .returning({ id: taskAttempts.id })
    await db.insert(submissions).values({
      taskId,
      agentId,
      attemptId: row!.id,
      attempt,
      payload: {},
      status: 'passed' as const,
      verifiedAt: sql`now()`,
    })
  }

  describe('capacity', () => {
    it('accepts a submission while a slot is free', async () => {
      const taskId = await aQuest({ slots: 1 })
      const agentId = await anAgent('first')

      expect((await submit(taskId, agentId)).outcome).toBe('accepted')
    })

    it('refuses when every slot is taken, and says so as capacity', async () => {
      const taskId = await aQuest({ slots: 1 })
      await passed(taskId, await anAgent('winner'))
      const late = await anAgent('late')

      const result = await submit(taskId, late)

      expect(result.outcome).toBe('task-full')
      if (result.outcome !== 'task-full') return
      expect(result.slots).toBe(1)
    })

    /**
     * The acceptance criterion this exists for, stated as its own test because
     * collapsing the two is the failure `#175` names as the one that loses
     * citizens permanently: a citizen refused for capacity has been told
     * something about the quest, not about itself.
     */
    it('does not call a full quest a qualification failure', async () => {
      const taskId = await aQuest({ slots: 1, requires: [] })
      await passed(taskId, await anAgent('winner'))
      const late = await anAgent('late')

      const result = await submit(taskId, late)

      expect(result.outcome).not.toBe('missing-skills')
      expect(result.outcome).not.toBe('reputation-too-low')
      expect(result.outcome).toBe('task-full')
    })

    it('has no capacity at all when slots is null, which is every Academy rung', async () => {
      const taskId = await aQuest({ slots: null })
      await passed(taskId, await anAgent('one'))
      await passed(taskId, await anAgent('two'))

      expect((await submit(taskId, await anAgent('three'))).outcome).toBe('accepted')
    })

    /**
     * The reservation, and the whole reason it exists. An open claim holds a
     * slot so that a thousand citizens do not each do real work for a quest with
     * ten places.
     */
    it('reserves a slot for an open claim', async () => {
      const taskId = await aQuest({ slots: 1 })
      const holder = await anAgent('holder')
      await db.insert(taskAttempts).values({
        agentId: holder,
        taskId,
        attempt: 1,
        opener: 'challenge' as const,
        expiresAt: sql`now() + interval '1 hour'`,
      })

      expect((await submit(taskId, await anAgent('other'))).outcome).toBe('task-full')
    })

    /**
     * And the other half: the reservation lapses with the claim rather than on a
     * timer of its own, so a slot returns to the pool without anything having to
     * run first.
     */
    it('returns the slot to the pool when the claim lapses', async () => {
      const taskId = await aQuest({ slots: 1 })
      const holder = await anAgent('holder')
      await db.insert(taskAttempts).values({
        agentId: holder,
        taskId,
        attempt: 1,
        opener: 'challenge' as const,
        expiresAt: sql`now() - interval '1 minute'`,
      })

      expect((await submit(taskId, await anAgent('other'))).outcome).toBe('accepted')
    })
  })

  describe('expiry', () => {
    it('refuses a submission after the expiry, whoever is asking', async () => {
      const taskId = await aQuest({ expiresAt: new Date(Date.now() - 60_000).toISOString() })

      const result = await submit(taskId, await anAgent('punctual'))

      expect(result.outcome).toBe('task-expired')
    })

    it('accepts one before it', async () => {
      const taskId = await aQuest({ expiresAt: new Date(Date.now() + 3_600_000).toISOString() })

      expect((await submit(taskId, await anAgent('punctual'))).outcome).toBe('accepted')
    })

    it('does not list an expired quest among what can be started now', async () => {
      const agentId = await anAgent('reader')
      await aQuest({ expiresAt: new Date(Date.now() - 60_000).toISOString() })

      const result = await listTasks(db, { agentId, availableOnly: true, limit: 10 })

      expect(result.outcome).toBe('listed')
      if (result.outcome !== 'listed') return
      expect(result.page.items).toHaveLength(0)
    })
  })

  describe('the audience floor', () => {
    it('refuses a candidate a citizens-only quest even holding every named skill', async () => {
      const taskId = await aQuest({ audience: 'citizens', requires: ['mailbox'] })
      const candidate = await anAgent('newcomer', 'candidate')
      await grantSkill(candidate, 'mailbox')

      const result = await submit(taskId, candidate)

      expect(result.outcome).toBe('audience-refused')
    })

    it('accepts the same candidate holding the same skills on a candidate quest', async () => {
      const taskId = await aQuest({ audience: 'candidates', requires: ['mailbox'] })
      const candidate = await anAgent('newcomer', 'candidate')
      await grantSkill(candidate, 'mailbox')

      expect((await submit(taskId, candidate)).outcome).toBe('accepted')
    })

    it('admits a citizen to a candidate quest — lowering the floor lowers it', async () => {
      const taskId = await aQuest({ audience: 'candidates' })

      expect((await submit(taskId, await anAgent('established'))).outcome).toBe('accepted')
    })

    /**
     * The floor and the reward are separate axes, and the test is for the
     * permission rather than the prohibition: coupling them would be the Colony
     * overruling a sponsor that `governance/quests.md` says decides this.
     */
    it('lets a paying quest be open to candidates', async () => {
      const taskId = await aQuest({ audience: 'candidates', rewardCredits: 100 })
      const candidate = await anAgent('newcomer', 'candidate')

      expect((await submit(taskId, candidate)).outcome).toBe('accepted')
    })

    it('lets a citizens-only quest pay nothing', async () => {
      const taskId = await aQuest({ audience: 'citizens', rewardCredits: 0 })

      expect((await submit(taskId, await anAgent('established'))).outcome).toBe('accepted')
    })

    /**
     * The Academy is how an agent stops being a candidate, so a rung that
     * required citizenship would be a closed loop with no way in.
     */
    it('refuses an Academy task that is not open to candidates', async () => {
      await expectRejection(
        () =>
          db.insert(tasks).values({
            type: 'some-rung',
            kind: 'academy' as const,
            title: 'A rung',
            description: 'What this rung is.',
            instructions: 'Do the thing.',
            rewardCredits: 0,
            rewardReputation: 3,
            audience: 'citizens' as const,
            timeoutHours: 24,
            status: 'active' as const,
          }),
        /tasks_academy_is_open/,
      )
    })
  })

  describe('one accepted submission per citizen per quest', () => {
    it('refuses a second accepted submission on the same quest, in the database', async () => {
      const taskId = await aQuest({ slots: null })
      const agentId = await anAgent('twice')
      await passed(taskId, agentId, 1)

      await expectRejection(() => passed(taskId, agentId, 2), /one_pass_per_quest/)
    })

    /**
     * The permission, not only the prohibition. The rule binds the quest and not
     * the sponsor: a sponsor with three questions is asking three questions.
     */
    it('lets a citizen take a second quest from the same sponsor', async () => {
      const questA = await aQuest({ slots: null })
      const questB = await aQuest({ slots: null })
      const agentId = await anAgent('busy')
      await passed(questA, agentId, 1)

      await expect(passed(questB, agentId, 1)).resolves.not.toThrow()
    })

    /** The Academy's re-run after a tester's reset (#47) is untouched by it. */
    it('leaves a second Academy pass alone', async () => {
      const [row] = await db
        .insert(tasks)
        .values({
          type: 'some-rung',
          kind: 'academy' as const,
          title: 'A rung',
          description: 'What this rung is.',
          instructions: 'Do the thing.',
          rewardCredits: 0,
          rewardReputation: 3,
          timeoutHours: 24,
          status: 'active' as const,
        })
        .returning({ id: tasks.id })
      const taskId = row!.id as TaskId
      const agentId = await anAgent('retested')
      await passed(taskId, agentId, 1)

      await expect(passed(taskId, agentId, 2)).resolves.not.toThrow()
    })
  })

  describe('a published quest is frozen', () => {
    const frozen: Readonly<Record<string, unknown>> = {
      title: 'A different question entirely',
      instructions: 'Do something else.',
      description: 'Another description.',
      slots: 99,
      rewardCredits: 500,
      minReputation: 5,
      audience: 'candidates',
      timeoutHours: 48,
      assistanceAllowed: false,
      type: 'something-else',
    }

    it.each(Object.entries(frozen))('refuses a change to %s', async (column, value) => {
      const taskId = await aQuest()

      await expectRejection(
        () =>
          db
            .update(tasks)
            .set({ [column]: value })
            .where(eq(tasks.id, taskId)),
        /published_quest_frozen/,
      )
    })

    it('still lets the quest be retired, which is how it ends', async () => {
      const taskId = await aQuest()

      await expect(
        db.update(tasks).set({ status: 'retired' }).where(eq(tasks.id, taskId)),
      ).resolves.not.toThrow()
    })

    it('leaves a draft quest editable', async () => {
      const [row] = await db
        .insert(tasks)
        .values({
          type: 'quest-report',
          kind: 'quest' as const,
          title: 'Still being written',
          description: 'A description.',
          instructions: 'Instructions.',
          rewardCredits: 1,
          rewardReputation: 0,
          timeoutHours: 24,
          status: 'draft' as const,
        })
        .returning({ id: tasks.id })

      await expect(
        db.update(tasks).set({ title: 'Rewritten' }).where(eq(tasks.id, row!.id)),
      ).resolves.not.toThrow()
    })
  })

  describe('the seed boundary', () => {
    /**
     * The most expensive failure available in the whole quest programme and the
     * cheapest to prevent: the seed matches rows on fixed ids and rewrites them
     * on every deploy, so a quest row it decided to own would be overwritten
     * mid-flight by an unrelated merge.
     */
    it('leaves a quest row untouched when the seed runs over it', async () => {
      const taskId = await aQuest()
      const before = await db.select().from(tasks).where(eq(tasks.id, taskId))

      await seedAcademyTasks(db)

      const after = await db.select().from(tasks).where(eq(tasks.id, taskId))
      expect(after).toEqual(before)
    })

    it('still writes the Academy', async () => {
      await seedAcademyTasks(db)

      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(tasks)
        .where(eq(tasks.kind, 'academy'))
      expect(row?.count ?? 0).toBeGreaterThan(0)
    })
  })

  describe('the review states', () => {
    it('is invisible to a submission while it waits for review', async () => {
      const [row] = await db
        .insert(tasks)
        .values({
          type: 'quest-report',
          kind: 'quest' as const,
          title: 'Waiting',
          description: 'A description.',
          instructions: 'Instructions.',
          rewardCredits: 1,
          rewardReputation: 0,
          timeoutHours: 24,
          status: 'pending_review' as const,
        })
        .returning({ id: tasks.id })

      const result = await submit(row!.id as TaskId, await anAgent('eager'))

      expect(result.outcome).toBe('unknown-task')
    })

    it('requires a reason on a refusal and refuses one anywhere else', async () => {
      await expectRejection(
        () =>
          db.insert(tasks).values({
            type: 'quest-report',
            kind: 'quest' as const,
            title: 'Refused',
            description: 'A description.',
            instructions: 'Instructions.',
            rewardCredits: 1,
            rewardReputation: 0,
            timeoutHours: 24,
            status: 'rejected' as const,
          }),
        /tasks_rejection_reason_iff_rejected/,
      )

      await expectRejection(
        () =>
          db.insert(tasks).values({
            type: 'quest-report',
            kind: 'quest' as const,
            title: 'Not refused',
            description: 'A description.',
            instructions: 'Instructions.',
            rewardCredits: 1,
            rewardReputation: 0,
            timeoutHours: 24,
            status: 'draft' as const,
            rejectionReason: 'a reason for a decision nobody took',
          }),
        /tasks_rejection_reason_iff_rejected/,
      )
    })
  })
})
