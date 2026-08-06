import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import {
  QUEST_AUDIT_OFF,
  isAudited,
  noStagesRun,
  type AgentId,
  type QuestDraft,
  type SubmissionId,
  type TaskId,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import {
  agents,
  authorityEvents,
  ledgerEntries,
  questAnswers,
  questModerations,
  submissions,
  taskAttempts,
  tasks,
  verifications,
} from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { availableBalance, escrowHeldFor } from './escrow.js'
import { createSubmission } from './submissions.js'
import { expireOverdueSubmissions } from './verifications.js'
import { eraseAgent } from './erasure.js'
import { listTasks } from './tasks.js'
import {
  createQuestDraft,
  heldRedLineReports,
  holdReportOnRedLine,
  isHeldOnRedLine,
  resolveHeldRedLine,
  withheldReportCount,
  listOwnQuests,
  ownQuestAnswer,
  pendingAnswerModerations,
  questAuditQueue,
  questDisagreementRate,
  recordAuditDecision,
  questAnswerCounts,
  questDefinition,
  questResults,
  scrubbedAnswers,
  writeScrubbedAnswers,
  ownerlessQuestDrafts,
  pendingQuestModerations,
  publishQuest,
  questReviewQueue,
  questTextDigest,
  readOwnQuest,
  recordQuestModeration,
  refuseQuest,
  submitQuestForReview,
  withdrawQuestFromReview,
  updateQuestDraft,
} from './quests/index.js'

const target = databaseTestTarget()

/**
 * A quest written from outside, moderated, and published by a steward (`#176`).
 *
 * The properties asserted here are the ones the issue calls load-bearing:
 * publication and escrow are one transaction, a steward never decides its own
 * quest, an unmoderated quest never reaches the queue, and nothing in `draft`,
 * `pending_review` or `rejected` is ever offered to a citizen.
 */
describe('the quest write path', () => {
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

  const now = (): string => new Date().toISOString()

  /**
   * The audit, switched on (`#221`).
   *
   * Every test that publishes a **paying** quest needs it, because the guard
   * refuses one while the sample is not being read. The zero-reward tests use
   * `QUEST_AUDIT_OFF` deliberately: the pilot pays nothing, and the guard must
   * be invisible to it.
   */
  const AUDIT_ON = { ...QUEST_AUDIT_OFF, enabled: true }

  /**
   * A passed report on a judged quest, which is what the audit samples.
   *
   * Written directly rather than driven through the runner: what is being tested
   * is the selection and the record, and a fixture that had to reach a model to
   * produce one would be testing the model.
   */
  const aPassedQuestSubmission = async (
    name: string,
    options: {
      readonly proofVerifier?: string
      readonly drawn?: boolean
      /** Who sponsored the quest, when a test cares who that is (`#318`). */
      readonly authorId?: AgentId
    } = {},
  ) => {
    const citizen = await anAgent(`citizen-${name}`)
    const [quest] = await db
      .insert(tasks)
      .values({
        type: 'quest-report',
        kind: 'quest' as const,
        title: `Quest for ${name}`,
        description: 'A description.',
        instructions: 'Answer the question.',
        rewardCredits: 0,
        rewardReputation: 1,
        slots: 10,
        timeoutHours: 24,
        status: 'active' as const,
        createdBy: options.authorId ?? (await anAgent(`author-${name}`)),
        questions: [
          {
            key: 'what-happened',
            prompt: 'What happened?',
            criteria: 'Say something specific.',
            required: true,
            minLength: 0,
            maxLength: 500,
          },
        ],
        ...(options.proofVerifier !== undefined && { proofVerifier: options.proofVerifier }),
      })
      .returning({ id: tasks.id })

    const [attempt] = await db
      .insert(taskAttempts)
      .values({ agentId: citizen, taskId: quest!.id, attempt: 1, opener: 'submission' as const })
      .returning({ id: taskAttempts.id })

    const [submission] = await db
      .insert(submissions)
      .values({
        taskId: quest!.id,
        agentId: citizen,
        attemptId: attempt!.id,
        attempt: 1,
        payload: { answers: { 'what-happened': 'It took two tries.' } },
        status: 'passed' as const,
        verifiedAt: sql`now()`,
      })
      .returning({ id: submissions.id })

    await db.insert(verifications).values({
      submissionId: submission!.id,
      taskType: 'quest-report',
      status: 'pass' as const,
      evidence: 'Both questions are answered.',
    })

    await db.insert(questAnswers).values({
      submissionId: submission!.id,
      reportId: crypto.randomUUID(),
      taskId: quest!.id,
      questionKey: 'what-happened',
      text: 'It took two tries.',
      acceptedAt: new Date().toISOString(),
      runtime: 'openclaw',
    })

    return submission!.id as SubmissionId
  }

  const countIn = async (table: 'submissions' | 'task_attempts'): Promise<number> => {
    const rows = await db.execute<{ count: string }>(
      sql`select count(*)::text as count from ${sql.identifier(table)}`,
    )
    return Number(rows[0]!.count)
  }

  const anAgent = async (name: string, roles: readonly ('steward' | 'builder')[] = []) => {
    const [row] = await db
      .insert(agents)
      .values({ name, platform: 'openclaw', status: 'citizen', roles: [...roles] })
      .returning({ id: agents.id })
    return row!.id as AgentId
  }

  /** The only way money reaches a balance today: a steward crediting it by hand. */
  const credit = async (agentId: AgentId, amount: number): Promise<void> => {
    const transactionId = crypto.randomUUID()
    await db.insert(ledgerEntries).values([
      {
        transactionId,
        accountKind: 'system' as const,
        systemAccount: 'treasury' as const,
        amount: -amount,
        type: 'adjustment' as const,
        reference: `bootstrap:${agentId}`,
      },
      {
        transactionId,
        accountKind: 'agent' as const,
        agentId,
        amount,
        type: 'adjustment' as const,
        reference: `bootstrap:${agentId}`,
      },
    ])
  }

  const aDraft = (overrides: Partial<QuestDraft> = {}): QuestDraft => ({
    questions: [
      {
        key: 'what-happened',
        prompt: 'What happened when you registered?',
        required: true,
        minLength: 20,
        maxLength: 500,
      },
    ],
    proofVerifier: null,
    title: 'A thousand registrations',
    description: 'We hand out mailbox addresses and want to know whether agents can take one.',
    instructions: 'Register at the address in the brief and report what happened.',
    reward: { credits: 0, reputation: 5 },
    slots: 10,
    expiresAt: new Date(Date.now() + 7 * 24 * 3_600_000).toISOString(),
    audience: 'citizens',
    requires: [],
    minReputation: 0,
    // No activity window, which is what a sponsor that says nothing gets (#227).
    minActivityDays: null,
    // And no operator criterion, for the same reason (#238).
    distinctOperators: false,
    // And obstacles published, which is what #367 argued for and #370 kept as
    // the default a sponsor has to opt out of deliberately.
    publishObstacles: true,
    timeoutHours: 24,
    assistanceAllowed: true,
    ...overrides,
  })

  /** Clear the moderation stage, the way the runner does. */
  const moderate = async (
    taskId: TaskId,
    decision: 'approved' | 'rejected' = 'approved',
  ): Promise<void> => {
    const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1)
    const result = await recordQuestModeration(db, {
      taskId,
      decision,
      ...(decision === 'rejected' && { reason: 'It asks the citizen to defeat a captcha.' }),
      model: 'test-model',
      stages: noStagesRun(),
      judged: {
        title: row!.title,
        description: row!.description,
        instructions: row!.instructions,
      },
    })
    expect(result.outcome).toBe('written')
  }

  describe('writing', () => {
    it('sets created_by from the credential and never from the caller', async () => {
      const sponsor = await anAgent('sponsor')
      const { task } = await createQuestDraft(db, { authorId: sponsor, draft: aDraft() })

      expect(task.createdBy).toBe(sponsor)
      expect(task.kind).toBe('quest')
      expect(task.status).toBe('draft')
      expect(task.type).toBe('quest-report')
    })

    it('grants no skill, because only the Colony mints one', async () => {
      const sponsor = await anAgent('sponsor')
      const { task } = await createQuestDraft(db, { authorId: sponsor, draft: aDraft() })

      expect(task.grants).toEqual([])

      // The constraint, not the write path, is what makes this true for every
      // write path that will ever exist — including one written after this file.
      const refused = await db
        .update(tasks)
        .set({ grantsSkills: ['mailbox'] })
        .where(eq(tasks.id, task.id))
        .then(() => null)
        .catch((error: unknown) => error)

      expect(String((refused as { cause?: unknown })?.cause ?? refused)).toContain(
        'tasks_only_colony_grants_skills',
      )
    })

    it('refuses to edit a quest that is not the caller’s', async () => {
      const sponsor = await anAgent('sponsor')
      const stranger = await anAgent('stranger')
      const { task } = await createQuestDraft(db, { authorId: sponsor, draft: aDraft() })

      const result = await updateQuestDraft(db, {
        authorId: stranger,
        taskId: task.id,
        patch: { title: 'Mine now' },
        at: now(),
      })

      expect(result.outcome).toBe('not-yours')
    })

    it('moves text_revised_at when the text changes, and leaves it when it does not', async () => {
      const sponsor = await anAgent('sponsor')
      const { task } = await createQuestDraft(db, { authorId: sponsor, draft: aDraft() })
      const before = await textRevisedAt(db, task.id)

      await updateQuestDraft(db, {
        authorId: sponsor,
        taskId: task.id,
        patch: { slots: 20 },
        at: new Date(Date.now() + 1000).toISOString(),
      })
      expect(await textRevisedAt(db, task.id)).toBe(before)

      await updateQuestDraft(db, {
        authorId: sponsor,
        taskId: task.id,
        patch: { instructions: 'Register, then tell us how long it took.' },
        at: new Date(Date.now() + 2000).toISOString(),
      })
      expect(await textRevisedAt(db, task.id)).not.toBe(before)
    })
  })

  describe('submitting for review', () => {
    it('accepts one quest and names the first when a second arrives', async () => {
      const sponsor = await anAgent('sponsor')
      const first = await createQuestDraft(db, { authorId: sponsor, draft: aDraft() })
      const second = await createQuestDraft(db, { authorId: sponsor, draft: aDraft() })

      expect(
        (await submitQuestForReview(db, { authorId: sponsor, taskId: first.task.id, at: now() }))
          .outcome,
      ).toBe('submitted')

      const result = await submitQuestForReview(db, {
        authorId: sponsor,
        taskId: second.task.id,
        at: now(),
      })

      expect(result).toEqual({ outcome: 'queue-occupied', by: first.task.id })
    })

    it('refuses a quest the sponsor cannot pay for, and leaves it a draft', async () => {
      const sponsor = await anAgent('sponsor')
      await credit(sponsor, 100)
      const { task } = await createQuestDraft(db, {
        authorId: sponsor,
        draft: aDraft({ reward: { credits: 50, reputation: 0 }, slots: 10 }),
      })

      const result = await submitQuestForReview(db, {
        authorId: sponsor,
        taskId: task.id,
        at: now(),
      })

      // 10 × 50 for the answers and 75 for the obstacle pool, against 100 held (`#371`).
      expect(result).toEqual({ outcome: 'insufficient-funds', shortfall: 475 })
      expect((await readOwnQuest(db, sponsor, task.id))?.task.status).toBe('draft')
    })

    it('counts what is already reserved, so the same credit is not committed twice', async () => {
      const sponsor = await anAgent('sponsor')
      // 10 × 10 for the answers and 15 for the obstacle pool, twice over (`#371`).
      await credit(sponsor, 130)
      const first = await createQuestDraft(db, {
        authorId: sponsor,
        draft: aDraft({ reward: { credits: 10, reputation: 0 }, slots: 10 }),
      })
      const second = await createQuestDraft(db, {
        authorId: sponsor,
        draft: aDraft({ reward: { credits: 10, reputation: 0 }, slots: 10 }),
      })

      expect(
        (await submitQuestForReview(db, { authorId: sponsor, taskId: first.task.id, at: now() }))
          .outcome,
      ).toBe('submitted')

      // Refused for the queue cap before the money is even asked about — and
      // once the first is decided, the reservation is what refuses the second.
      await moderate(first.task.id)
      const steward = await anAgent('steward', ['steward'])
      await publishQuest(db, {
        stewardId: steward,
        taskId: first.task.id,
        at: now(),
        audit: AUDIT_ON,
      })

      const result = await submitQuestForReview(db, {
        authorId: sponsor,
        taskId: second.task.id,
        at: now(),
      })

      expect(result).toEqual({ outcome: 'insufficient-funds', shortfall: 100 })
    })

    it('is not editable once it is awaiting review', async () => {
      const sponsor = await anAgent('sponsor')
      const { task } = await createQuestDraft(db, { authorId: sponsor, draft: aDraft() })
      await submitQuestForReview(db, { authorId: sponsor, taskId: task.id, at: now() })

      const result = await updateQuestDraft(db, {
        authorId: sponsor,
        taskId: task.id,
        patch: { title: 'A different question' },
        at: now(),
      })

      expect(result).toEqual({ outcome: 'not-editable', status: 'pending_review' })
    })
  })

  /**
   * The undo for a submission (`#323`), which the write path was missing —
   * `submitQuestForReview`'s own `queue-occupied` refusal has named the move
   * since `#176`.
   */
  describe('withdrawing from review', () => {
    it('puts the quest back in draft, editable again', async () => {
      const sponsor = await anAgent('sponsor')
      const { task } = await createQuestDraft(db, { authorId: sponsor, draft: aDraft() })
      await submitQuestForReview(db, { authorId: sponsor, taskId: task.id, at: now() })

      const result = await withdrawQuestFromReview(db, {
        authorId: sponsor,
        taskId: task.id,
        at: now(),
      })

      expect(result.outcome).toBe('withdrawn')
      expect((await readOwnQuest(db, sponsor, task.id))?.task.status).toBe('draft')
      expect(
        (
          await updateQuestDraft(db, {
            authorId: sponsor,
            taskId: task.id,
            patch: { title: 'A better question' },
            at: now(),
          })
        ).outcome,
      ).toBe('written')
    })

    /**
     * By arithmetic and not by a second write: `availableBalance` sums the
     * quests in `pending_review`, so a quest that leaves the queue stops being
     * reserved without anything being unbooked.
     */
    it('releases the reservation and the queue slot', async () => {
      const sponsor = await anAgent('sponsor')
      // Enough for the answers and the obstacle pool both (`#371`).
      await credit(sponsor, 200)
      const first = await createQuestDraft(db, {
        authorId: sponsor,
        draft: aDraft({ reward: { credits: 10, reputation: 0 }, slots: 10 }),
      })
      const second = await createQuestDraft(db, { authorId: sponsor, draft: aDraft() })
      await submitQuestForReview(db, { authorId: sponsor, taskId: first.task.id, at: now() })

      expect((await availableBalance(db, sponsor)).reserved).toBe(115)

      await withdrawQuestFromReview(db, { authorId: sponsor, taskId: first.task.id, at: now() })

      expect((await availableBalance(db, sponsor)).reserved).toBe(0)
      expect(
        (await submitQuestForReview(db, { authorId: sponsor, taskId: second.task.id, at: now() }))
          .outcome,
      ).toBe('submitted')
    })

    it('refuses a draft, which is where withdrawing would have put it', async () => {
      const sponsor = await anAgent('sponsor')
      const { task } = await createQuestDraft(db, { authorId: sponsor, draft: aDraft() })

      expect(
        await withdrawQuestFromReview(db, { authorId: sponsor, taskId: task.id, at: now() }),
      ).toEqual({ outcome: 'not-in-review', status: 'draft' })
    })

    it('refuses a published quest, which a steward has already decided', async () => {
      const sponsor = await anAgent('sponsor')
      await credit(sponsor, 10_000)
      const { task } = await createQuestDraft(db, { authorId: sponsor, draft: aDraft() })
      await submitQuestForReview(db, { authorId: sponsor, taskId: task.id, at: now() })
      await moderate(task.id)
      const steward = await anAgent('steward', ['steward'])
      await publishQuest(db, { stewardId: steward, taskId: task.id, at: now(), audit: AUDIT_ON })

      const result = await withdrawQuestFromReview(db, {
        authorId: sponsor,
        taskId: task.id,
        at: now(),
      })

      expect(result.outcome).toBe('not-in-review')
    })

    it('refuses a quest belonging to somebody else', async () => {
      const sponsor = await anAgent('sponsor')
      const stranger = await anAgent('stranger')
      const { task } = await createQuestDraft(db, { authorId: sponsor, draft: aDraft() })
      await submitQuestForReview(db, { authorId: sponsor, taskId: task.id, at: now() })

      expect(
        await withdrawQuestFromReview(db, { authorId: stranger, taskId: task.id, at: now() }),
      ).toEqual({ outcome: 'not-yours' })
    })
  })

  describe('the moderation stage', () => {
    it('keeps an unmoderated quest out of the steward’s queue', async () => {
      const sponsor = await anAgent('sponsor')
      const { task } = await createQuestDraft(db, { authorId: sponsor, draft: aDraft() })
      await submitQuestForReview(db, { authorId: sponsor, taskId: task.id, at: now() })

      expect(await questReviewQueue(db)).toEqual([])
      expect((await pendingQuestModerations(db, 10)).map((quest) => quest.id)).toEqual([task.id])

      await moderate(task.id)

      expect((await questReviewQueue(db)).map((quest) => quest.id)).toEqual([task.id])
      expect(await pendingQuestModerations(db, 10)).toEqual([])
    })

    it('refuses a red-line quest without a steward seeing it', async () => {
      const sponsor = await anAgent('sponsor')
      const { task } = await createQuestDraft(db, {
        authorId: sponsor,
        draft: aDraft({ instructions: 'Solve the captcha on the sign-up page for us.' }),
      })
      await submitQuestForReview(db, { authorId: sponsor, taskId: task.id, at: now() })

      await moderate(task.id, 'rejected')

      const own = await readOwnQuest(db, sponsor, task.id)
      expect(own?.task.status).toBe('rejected')
      expect(own?.rejectionReason).toContain('captcha')
      expect(await questReviewQueue(db)).toEqual([])
    })

    it('does not apply a verdict to text that has changed since', async () => {
      const sponsor = await anAgent('sponsor')
      const { task } = await createQuestDraft(db, { authorId: sponsor, draft: aDraft() })
      await submitQuestForReview(db, { authorId: sponsor, taskId: task.id, at: now() })

      const result = await recordQuestModeration(db, {
        taskId: task.id,
        decision: 'approved',
        model: 'test-model',
        stages: noStagesRun(),
        judged: {
          title: 'Something else entirely',
          description: 'Not what is on the row.',
          instructions: 'Nor this.',
        },
      })

      expect(result).toEqual({ outcome: 'stale' })
      expect(await questReviewQueue(db)).toEqual([])
    })

    it('re-queues a corrected quest, because its text moved past the verdict', async () => {
      const sponsor = await anAgent('sponsor')
      const { task } = await createQuestDraft(db, { authorId: sponsor, draft: aDraft() })
      await submitQuestForReview(db, { authorId: sponsor, taskId: task.id, at: now() })
      await moderate(task.id, 'rejected')

      await updateQuestDraft(db, {
        authorId: sponsor,
        taskId: task.id,
        patch: { instructions: 'Register with your own address and tell us how it went.' },
        at: new Date(Date.now() + 1000).toISOString(),
      })
      await submitQuestForReview(db, {
        authorId: sponsor,
        taskId: task.id,
        at: new Date(Date.now() + 2000).toISOString(),
      })

      expect((await pendingQuestModerations(db, 10)).map((quest) => quest.id)).toEqual([task.id])
      expect(await questReviewQueue(db)).toEqual([])
      // The refusal it is answering is cleared, and the old verdict stays as the record.
      expect((await readOwnQuest(db, sponsor, task.id))?.rejectionReason).toBeNull()
      expect(await db.select().from(questModerations)).toHaveLength(1)
    })

    it('records the digest of what it judged', async () => {
      const sponsor = await anAgent('sponsor')
      const draft = aDraft()
      const { task } = await createQuestDraft(db, { authorId: sponsor, draft })
      await submitQuestForReview(db, { authorId: sponsor, taskId: task.id, at: now() })
      await moderate(task.id)

      const [verdict] = await db.select().from(questModerations)
      expect(verdict!.contentSha256).toBe(
        questTextDigest({
          title: draft.title,
          description: draft.description,
          instructions: draft.instructions,
        }),
      )
    })
  })

  describe('the steward’s decision', () => {
    it('publishes and escrows in one transaction', async () => {
      const sponsor = await anAgent('sponsor')
      const steward = await anAgent('steward', ['steward'])
      await credit(sponsor, 500)
      const { task } = await createQuestDraft(db, {
        authorId: sponsor,
        draft: aDraft({ reward: { credits: 10, reputation: 0 }, slots: 10 }),
      })
      await submitQuestForReview(db, { authorId: sponsor, taskId: task.id, at: now() })
      await moderate(task.id)

      const result = await publishQuest(db, {
        stewardId: steward,
        taskId: task.id,
        at: now(),
        audit: AUDIT_ON,
      })

      // 10 × 10 for the answers, plus 15 for the first three published obstacle
      // reports — one booking, refunded together (`#371`).
      expect(result).toEqual({ outcome: 'published', escrowed: 115 })
      expect((await readOwnQuest(db, sponsor, task.id))?.task.status).toBe('active')
      expect(await escrowHeldFor(db, task.id)).toBe(115)
    })

    it('leaves the quest awaiting review when the escrow booking fails', async () => {
      const sponsor = await anAgent('sponsor')
      const steward = await anAgent('steward', ['steward'])
      await credit(sponsor, 500)
      const { task } = await createQuestDraft(db, {
        authorId: sponsor,
        draft: aDraft({ reward: { credits: 10, reputation: 0 }, slots: 10 }),
      })
      await submitQuestForReview(db, { authorId: sponsor, taskId: task.id, at: now() })
      await moderate(task.id)

      /**
       * The booking is forced to fail by pre-writing the funding entries this
       * publication would write: `ledger_entries_quest_money_agent_unique`
       * refuses the second, which is the same refusal two stewards publishing in
       * the same millisecond would produce.
       */
      const transactionId = crypto.randomUUID()
      await db.insert(ledgerEntries).values([
        {
          transactionId,
          accountKind: 'agent' as const,
          agentId: sponsor,
          amount: -100,
          type: 'task_funding' as const,
          reference: `quest:${task.id}:funding`,
        },
        {
          transactionId,
          accountKind: 'system' as const,
          systemAccount: 'escrow' as const,
          amount: 100,
          type: 'task_funding' as const,
          reference: `quest:${task.id}:funding`,
        },
      ])

      await expect(
        publishQuest(db, { stewardId: steward, taskId: task.id, at: now(), audit: AUDIT_ON }),
      ).rejects.toThrow()

      expect((await readOwnQuest(db, sponsor, task.id))?.task.status).toBe('pending_review')
    })

    it('refuses a steward publishing its own quest', async () => {
      const steward = await anAgent('steward', ['steward'])
      const { task } = await createQuestDraft(db, { authorId: steward, draft: aDraft() })
      await submitQuestForReview(db, { authorId: steward, taskId: task.id, at: now() })
      await moderate(task.id)

      expect(
        await publishQuest(db, {
          stewardId: steward,
          taskId: task.id,
          at: now(),
          audit: QUEST_AUDIT_OFF,
        }),
      ).toEqual({
        outcome: 'own-quest',
      })
      expect(
        await refuseQuest(db, {
          stewardId: steward,
          taskId: task.id,
          reason: 'Not specific enough.',
          at: now(),
        }),
      ).toEqual({ outcome: 'own-quest' })
    })

    it('refuses to publish a quest the moderator has not cleared', async () => {
      const sponsor = await anAgent('sponsor')
      const steward = await anAgent('steward', ['steward'])
      const { task } = await createQuestDraft(db, { authorId: sponsor, draft: aDraft() })
      await submitQuestForReview(db, { authorId: sponsor, taskId: task.id, at: now() })

      expect(
        await publishQuest(db, {
          stewardId: steward,
          taskId: task.id,
          at: now(),
          audit: QUEST_AUDIT_OFF,
        }),
      ).toEqual({
        outcome: 'awaiting-moderation',
      })
    })

    it('stores the refusal, frees the reservation, and records who refused', async () => {
      const sponsor = await anAgent('sponsor')
      const steward = await anAgent('steward', ['steward'])
      // The answers and the obstacle pool both, so the submission is not
      // refused for money before this test reaches the refusal (`#371`).
      await credit(sponsor, 200)
      const { task } = await createQuestDraft(db, {
        authorId: sponsor,
        draft: aDraft({ reward: { credits: 10, reputation: 0 }, slots: 10 }),
      })
      await submitQuestForReview(db, { authorId: sponsor, taskId: task.id, at: now() })
      await moderate(task.id)

      const result = await refuseQuest(db, {
        stewardId: steward,
        taskId: task.id,
        reason: 'Say which page the citizen should register on.',
        at: now(),
      })

      expect(result).toEqual({ outcome: 'refused' })
      const own = await readOwnQuest(db, sponsor, task.id)
      expect(own?.task.status).toBe('rejected')
      expect(own?.rejectionReason).toBe('Say which page the citizen should register on.')
      // Nothing was booked, so nothing is unbooked.
      expect(await escrowHeldFor(db, task.id)).toBe(0)

      const [event] = await db
        .select()
        .from(authorityEvents)
        .where(eq(authorityEvents.action, 'quest-refused'))
      expect(event?.actorId).toBe(steward)
      expect(event?.subjectTaskId).toBe(task.id)

      // The reservation stopped counting, so the sponsor may commit again.
      const next = await createQuestDraft(db, {
        authorId: sponsor,
        draft: aDraft({ reward: { credits: 10, reputation: 0 }, slots: 10 }),
      })
      expect(
        (await submitQuestForReview(db, { authorId: sponsor, taskId: next.task.id, at: now() }))
          .outcome,
      ).toBe('submitted')
    })

    it('records the publication against the steward that took it', async () => {
      const sponsor = await anAgent('sponsor')
      const steward = await anAgent('steward', ['steward'])
      const { task } = await createQuestDraft(db, { authorId: sponsor, draft: aDraft() })
      await submitQuestForReview(db, { authorId: sponsor, taskId: task.id, at: now() })
      await moderate(task.id)
      await publishQuest(db, {
        stewardId: steward,
        taskId: task.id,
        at: now(),
        audit: QUEST_AUDIT_OFF,
      })

      const [event] = await db
        .select()
        .from(authorityEvents)
        .where(eq(authorityEvents.action, 'quest-published'))
      expect(event?.actorId).toBe(steward)
      expect(event?.subjectTaskId).toBe(task.id)
      expect(event?.subjectAgentId).toBe(sponsor)
    })

    it('refuses to decide a quest that is not awaiting review', async () => {
      const sponsor = await anAgent('sponsor')
      const steward = await anAgent('steward', ['steward'])
      const { task } = await createQuestDraft(db, { authorId: sponsor, draft: aDraft() })

      expect(
        await publishQuest(db, {
          stewardId: steward,
          taskId: task.id,
          at: now(),
          audit: QUEST_AUDIT_OFF,
        }),
      ).toEqual({
        outcome: 'not-in-review',
        status: 'draft',
      })
    })
  })

  describe('what a citizen sees', () => {
    it.each(['draft', 'pending_review', 'rejected'] as const)(
      'never offers a quest in %s',
      async (status) => {
        const sponsor = await anAgent('sponsor')
        const citizen = await anAgent(`citizen-${status}`)
        const { task } = await createQuestDraft(db, { authorId: sponsor, draft: aDraft() })

        await db
          .update(tasks)
          .set({
            status,
            ...(status === 'rejected' && { rejectionReason: 'Not this one.' }),
          })
          .where(eq(tasks.id, task.id))

        for (const availableOnly of [true, false]) {
          const result = await listTasks(db, { agentId: citizen, availableOnly, limit: 50 })
          expect(result.outcome).toBe('listed')
          if (result.outcome !== 'listed') return
          expect(result.page.items.map((item) => item.id)).not.toContain(task.id)
        }
      },
    )

    it('offers it once it is published', async () => {
      const sponsor = await anAgent('sponsor')
      const steward = await anAgent('steward', ['steward'])
      const citizen = await anAgent('citizen')
      const { task } = await createQuestDraft(db, { authorId: sponsor, draft: aDraft() })
      await submitQuestForReview(db, { authorId: sponsor, taskId: task.id, at: now() })
      await moderate(task.id)
      await publishQuest(db, {
        stewardId: steward,
        taskId: task.id,
        at: now(),
        audit: QUEST_AUDIT_OFF,
      })

      const result = await listTasks(db, { agentId: citizen, availableOnly: true, limit: 50 })
      expect(result.outcome).toBe('listed')
      if (result.outcome !== 'listed') return
      expect(result.page.items.map((item) => item.id)).toContain(task.id)
    })
  })

  describe('reading its own', () => {
    it('lists every status and hides other accounts’ quests', async () => {
      const sponsor = await anAgent('sponsor')
      const stranger = await anAgent('stranger')
      const mine = await createQuestDraft(db, { authorId: sponsor, draft: aDraft() })
      await createQuestDraft(db, { authorId: stranger, draft: aDraft() })

      const listed = await listOwnQuests(db, sponsor)
      expect(listed.map((quest) => quest.task.id)).toEqual([mine.task.id])
      expect(await readOwnQuest(db, stranger, mine.task.id)).toBeUndefined()
    })

    it('says whether a quest is still waiting on the moderator', async () => {
      const sponsor = await anAgent('sponsor')
      const { task } = await createQuestDraft(db, { authorId: sponsor, draft: aDraft() })
      await submitQuestForReview(db, { authorId: sponsor, taskId: task.id, at: now() })

      expect((await readOwnQuest(db, sponsor, task.id))?.awaitingModeration).toBe(true)
      await moderate(task.id)
      expect((await readOwnQuest(db, sponsor, task.id))?.awaitingModeration).toBe(false)
    })
  })

  /**
   * The report a quest asks for, and the three stages that judge it (`#177`).
   *
   * What is asserted here is what the storage layer alone can be wrong about: a
   * malformed report writing rows, the scrub being readable before it has run,
   * and a proof stage granting nothing.
   */
  describe('the report', () => {
    const withQuestions = () =>
      aDraft({
        questions: [
          {
            key: 'what-happened',
            prompt: 'What happened when you registered?',
            required: true,
            minLength: 20,
            maxLength: 500,
          },
          {
            key: 'address',
            prompt: 'Which address did you use?',
            required: true,
            minLength: 5,
            maxLength: 200,
            format: 'email' as const,
          },
        ],
      })

    /** A published quest a citizen can actually submit against. */
    const aPublishedQuest = async (draft = withQuestions()) => {
      const sponsor = await anAgent(`sponsor-${crypto.randomUUID().slice(0, 8)}`)
      const steward = await anAgent(`steward-${crypto.randomUUID().slice(0, 8)}`, ['steward'])
      const { task } = await createQuestDraft(db, { authorId: sponsor, draft })
      await submitQuestForReview(db, { authorId: sponsor, taskId: task.id, at: now() })
      await moderate(task.id)
      await publishQuest(db, {
        stewardId: steward,
        taskId: task.id,
        at: now(),
        audit: QUEST_AUDIT_OFF,
      })
      return task.id
    }

    it('refuses a malformed report without writing a submission or an attempt', async () => {
      const taskId = await aPublishedQuest()
      const citizen = await anAgent('citizen-malformed')

      const result = await createSubmission(db, {
        taskId,
        agentId: citizen,
        payload: { answers: { 'what-happened': 'too short', address: 'not-an-address' } },
      })

      expect(result.outcome).toBe('answers-invalid')
      if (result.outcome !== 'answers-invalid') return
      expect(result.problems.map((problem) => problem.key)).toEqual(['what-happened', 'address'])

      // Not an attempt, not a slot: nothing was written at all.
      expect(await countIn('submissions')).toBe(0)
      expect(await countIn('task_attempts')).toBe(0)
    })

    it('accepts one that answers the questions', async () => {
      const taskId = await aPublishedQuest()
      const citizen = await anAgent('citizen-accepted')

      const result = await createSubmission(db, {
        taskId,
        agentId: citizen,
        payload: {
          answers: {
            'what-happened': 'The signup took two tries; the first form lost my input.',
            address: 'agent@example.org',
          },
        },
      })

      expect(result.outcome).toBe('accepted')
    })

    it('answers undefined for a report the scrub has not reached, and the rows once it has', async () => {
      const taskId = await aPublishedQuest()
      const citizen = await anAgent('citizen-scrub')
      const created = await createSubmission(db, {
        taskId,
        agentId: citizen,
        payload: {
          answers: {
            'what-happened': 'The signup took two tries; the first form lost my input.',
            address: 'agent@example.org',
          },
        },
      })
      if (created.outcome !== 'accepted') throw new Error('fixture failed to submit')
      const submissionId = created.submission.id

      expect(await scrubbedAnswers(db, submissionId)).toBeUndefined()
      expect((await pendingAnswerModerations(db, 10)).map((report) => report.submissionId)).toEqual(
        [submissionId],
      )

      await writeScrubbedAnswers(db, {
        submissionId,
        taskId,
        answers: [
          { questionKey: 'address', text: '[removed]' },
          { questionKey: 'what-happened', text: 'The signup took two tries.' },
        ],
      })

      expect(await scrubbedAnswers(db, submissionId)).toEqual([
        { questionKey: 'address', text: '[removed]' },
        { questionKey: 'what-happened', text: 'The signup took two tries.' },
      ])
      // Written once: a second pass over the same submission writes nothing.
      expect(
        (
          await writeScrubbedAnswers(db, {
            submissionId,
            taskId,
            answers: [{ questionKey: 'address', text: 'something else' }],
          })
        ).written,
      ).toBe(0)
      expect(await pendingAnswerModerations(db, 10)).toEqual([])
    })

    it('reads the quest the way the verifier needs it', async () => {
      const taskId = await aPublishedQuest(
        aDraft({
          proofVerifier: 'email-inbox',
          questions: [
            {
              key: 'what-happened',
              prompt: 'What happened?',
              criteria: 'Say something specific about the signup.',
              required: true,
              minLength: 20,
              maxLength: 500,
            },
          ],
        }),
      )

      const definition = await questDefinition(db, taskId)

      expect(definition?.proofVerifier).toBe('email-inbox')
      expect(definition?.questions[0]?.criteria).toBe('Say something specific about the signup.')
    })

    it('is not a quest definition when the task is an Academy rung', async () => {
      const [row] = await db
        .insert(tasks)
        .values({
          type: 'email-inbox',
          title: 'Prove a mailbox',
          description: 'A description.',
          instructions: 'Receive a mail.',
          rewardCredits: 0,
          rewardReputation: 5,
          timeoutHours: 24,
          status: 'active',
        })
        .returning({ id: tasks.id })

      expect(await questDefinition(db, row!.id as TaskId)).toBeUndefined()
    })

    /**
     * **A machine may flag it; a person decides it** (`#446`).
     *
     * The stage used to fail the submission itself. That verdict closed the
     * attempt, accused the citizen and quoted its own sentence back as the
     * offence — and one of the Colony's three quest failures on 2026-08-06 was
     * the Colony's own misclassification (submission `a8a82ae7`, refused for
     * describing a task on a quest whose deliverable is a task description).
     *
     * What is *not* relaxed is what the sponsor sees. Every case below asserts
     * that `quest_answers` is still empty, because *held* has to be as tight as
     * *failed* was or this traded a citizen's protection for a sponsor's.
     */
    describe('a red line raised against an answer', () => {
      const aSubmittedReport = async (taskId: TaskId, handle: string) => {
        const citizen = await anAgent(handle)
        const created = await createSubmission(db, {
          taskId,
          agentId: citizen,
          payload: {
            answers: {
              'what-happened': 'Think about a public API you have used and check its shape.',
              address: 'agent@example.org',
            },
          },
        })
        if (created.outcome !== 'accepted') throw new Error('fixture failed to submit')
        return { submissionId: created.submission.id, citizen }
      }

      const statusOf = async (submissionId: SubmissionId) => {
        const [row] = await db
          .select({ status: submissions.status })
          .from(submissions)
          .where(eq(submissions.id, submissionId))
          .limit(1)
        return row?.status
      }

      it('holds the report open rather than failing it, and shows the sponsor nothing', async () => {
        const taskId = await aPublishedQuest()
        const { submissionId } = await aSubmittedReport(taskId, 'citizen-held')

        expect(
          await holdReportOnRedLine(db, {
            submissionId,
            reason: 'It instructs the reader to run code.',
            model: 'test-model',
          }),
        ).toEqual({ outcome: 'held' })

        // The attempt is still the citizen's, which is the whole change.
        expect(await statusOf(submissionId)).toBe('pending')
        expect(await isHeldOnRedLine(db, submissionId)).toBe(true)
        // And the sponsor is no better off than under the old refusal.
        expect(await scrubbedAnswers(db, submissionId)).toBeUndefined()
      })

      it('takes the held report out of the scrub queue, so the runner stops paying for it', async () => {
        const taskId = await aPublishedQuest()
        const { submissionId } = await aSubmittedReport(taskId, 'citizen-requeued')

        expect((await pendingAnswerModerations(db, 10)).map((r) => r.submissionId)).toEqual([
          submissionId,
        ])

        await holdReportOnRedLine(db, { submissionId, reason: 'crossed', model: 'test-model' })

        expect(await pendingAnswerModerations(db, 10)).toEqual([])
      })

      it('gives a released report back to the scrub with the red line already cleared', async () => {
        const taskId = await aPublishedQuest()
        const steward = await anAgent('steward-releasing', ['steward'])
        const { submissionId } = await aSubmittedReport(taskId, 'citizen-released')
        await holdReportOnRedLine(db, { submissionId, reason: 'crossed', model: 'test-model' })

        expect(
          await resolveHeldRedLine(db, {
            submissionId,
            stewardId: steward,
            crossed: false,
            reason: 'It describes a task rather than instructing the sponsor.',
          }),
        ).toEqual({ outcome: 'released' })

        const queued = await pendingAnswerModerations(db, 10)
        expect(queued.map((r) => r.submissionId)).toEqual([submissionId])
        // Without this the same classifier holds it again and the steward's
        // ruling means nothing.
        expect(queued[0]?.redLineCleared).toBe(true)
        expect(await isHeldOnRedLine(db, submissionId)).toBe(false)
        expect(await statusOf(submissionId)).toBe('pending')
      })

      /** The rejection case: a genuine crossing is still refused, by a person. */
      it('fails the report when a steward upholds the crossing, and writes no answers', async () => {
        const taskId = await aPublishedQuest()
        const steward = await anAgent('steward-upholding', ['steward'])
        const { submissionId } = await aSubmittedReport(taskId, 'citizen-upheld')
        await holdReportOnRedLine(db, { submissionId, reason: 'crossed', model: 'test-model' })

        expect(
          await resolveHeldRedLine(db, {
            submissionId,
            stewardId: steward,
            crossed: true,
            reason: 'It tells the sponsor to pipe a script into a shell.',
          }),
        ).toEqual({ outcome: 'upheld' })

        expect(await statusOf(submissionId)).toBe('failed')
        expect(await scrubbedAnswers(db, submissionId)).toBeUndefined()
        expect(await pendingAnswerModerations(db, 10)).toEqual([])
      })

      it('refuses a second ruling on the same case', async () => {
        const taskId = await aPublishedQuest()
        const steward = await anAgent('steward-twice', ['steward'])
        const { submissionId } = await aSubmittedReport(taskId, 'citizen-twice')
        await holdReportOnRedLine(db, { submissionId, reason: 'crossed', model: 'test-model' })

        await resolveHeldRedLine(db, {
          submissionId,
          stewardId: steward,
          crossed: false,
          reason: 'It does not cross.',
        })

        expect(
          await resolveHeldRedLine(db, {
            submissionId,
            stewardId: steward,
            crossed: true,
            reason: 'Changed my mind.',
          }),
        ).toEqual({ outcome: 'not-held' })
      })

      /** `#318`'s rule, one surface along and mattering more here. */
      it('refuses a steward ruling on a report written for its own quest', async () => {
        const sponsor = await anAgent('sponsor-and-steward', ['steward'])
        const { task } = await createQuestDraft(db, { authorId: sponsor, draft: withQuestions() })
        await submitQuestForReview(db, { authorId: sponsor, taskId: task.id, at: now() })
        await moderate(task.id)
        const otherSteward = await anAgent('steward-publishing', ['steward'])
        await publishQuest(db, {
          stewardId: otherSteward,
          taskId: task.id,
          at: now(),
          audit: QUEST_AUDIT_OFF,
        })
        const { submissionId } = await aSubmittedReport(task.id, 'citizen-own-quest')
        await holdReportOnRedLine(db, { submissionId, reason: 'crossed', model: 'test-model' })

        expect(
          await resolveHeldRedLine(db, {
            submissionId,
            stewardId: sponsor,
            crossed: true,
            reason: 'I do not like what it says about my quest.',
          }),
        ).toEqual({ outcome: 'own-quest' })

        // Still held, so another steward can still take it.
        expect(await isHeldOnRedLine(db, submissionId)).toBe(true)
      })

      it('counts what the sponsor is not being shown, and never carries the text', async () => {
        const taskId = await aPublishedQuest()
        const steward = await anAgent('steward-counting', ['steward'])
        expect(await withheldReportCount(db, taskId)).toBe(0)

        const first = await aSubmittedReport(taskId, 'citizen-count-one')
        await holdReportOnRedLine(db, {
          submissionId: first.submissionId,
          reason: 'crossed',
          model: 'test-model',
        })
        expect(await withheldReportCount(db, taskId)).toBe(1)

        // Upheld stays counted: the report exists and the sponsor will never
        // read it, which is exactly what the number says.
        await resolveHeldRedLine(db, {
          submissionId: first.submissionId,
          stewardId: steward,
          crossed: true,
          reason: 'It really does cross.',
        })
        expect(await withheldReportCount(db, taskId)).toBe(1)

        // Released stops counting: it goes back to the judge and, if accepted,
        // into the results like any other.
        const second = await aSubmittedReport(taskId, 'citizen-count-two')
        await holdReportOnRedLine(db, {
          submissionId: second.submissionId,
          reason: 'crossed',
          model: 'test-model',
        })
        expect(await withheldReportCount(db, taskId)).toBe(2)
        await resolveHeldRedLine(db, {
          submissionId: second.submissionId,
          stewardId: steward,
          crossed: false,
          reason: 'It does not cross.',
        })
        expect(await withheldReportCount(db, taskId)).toBe(1)
      })

      it('shows a steward the report, what was asked, and what the classifier said', async () => {
        const taskId = await aPublishedQuest()
        const { submissionId } = await aSubmittedReport(taskId, 'citizen-queue')
        await holdReportOnRedLine(db, {
          submissionId,
          reason: 'It instructs the reader to run code.',
          model: 'test-model',
        })

        const [held, ...rest] = await heldRedLineReports(db, 10)

        expect(rest).toEqual([])
        expect(held?.submissionId).toBe(submissionId)
        expect(held?.flaggedFor).toBe('It instructs the reader to run code.')
        expect(held?.model).toBe('test-model')
        // Unscrubbed, and this is the one reader that is right: a steward
        // ruling on a redacted copy would be ruling on the redaction.
        expect(held?.answers.map((answer) => answer.questionKey)).toEqual([
          'address',
          'what-happened',
        ])
        expect(held?.questInstructions).toBeTruthy()
      })

      /**
       * **The clock must not close what the model was stopped from closing.**
       * `timeoutHours` bounds a wait on the world; a hold is a wait on us, and
       * expiring the citizen for it is the Colony recording its own delay as the
       * citizen's loss — the standing rule `#170` exists to state.
       */
      it('does not expire a held report when its deadline passes', async () => {
        const taskId = await aPublishedQuest()
        const { submissionId } = await aSubmittedReport(taskId, 'citizen-deadline')
        await holdReportOnRedLine(db, { submissionId, reason: 'crossed', model: 'test-model' })

        const wellPastIt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365).toISOString()
        expect(await expireOverdueSubmissions(db, { now: wellPastIt })).toEqual([])
        expect(await statusOf(submissionId)).toBe('pending')

        // And the moment a steward releases it, the ordinary clock applies
        // again — the exemption is the hold, not the submission.
        const steward = await anAgent('steward-deadline', ['steward'])
        await resolveHeldRedLine(db, {
          submissionId,
          stewardId: steward,
          crossed: false,
          reason: 'It does not cross.',
        })
        expect(
          (await expireOverdueSubmissions(db, { now: wellPastIt })).map((r) => r.submissionId),
        ).toContain(submissionId)
      })
    })
  })

  /**
   * What the sponsor reads (`#178`).
   *
   * The 2026-07-30 incident is why this exists, so the regression is here: the
   * text a citizen handed in never reaches a sponsor, only the scrubbed row
   * does — and there is no path from one to the other.
   */
  describe('the results', () => {
    const questions = [
      {
        key: 'what-happened',
        prompt: 'What happened when you registered?',
        required: true,
        minLength: 20,
        maxLength: 500,
      },
      {
        key: 'worked',
        prompt: 'Did it work?',
        required: true,
        minLength: 0,
        maxLength: 10,
        options: ['yes', 'no'],
      },
    ]

    const aQuestWithReports = async () => {
      const sponsor = await anAgent(`sponsor-${crypto.randomUUID().slice(0, 8)}`)
      const steward = await anAgent(`steward-${crypto.randomUUID().slice(0, 8)}`, ['steward'])
      const { task } = await createQuestDraft(db, {
        authorId: sponsor,
        draft: aDraft({ questions }),
      })
      await submitQuestForReview(db, { authorId: sponsor, taskId: task.id, at: now() })
      await moderate(task.id)
      await publishQuest(db, {
        stewardId: steward,
        taskId: task.id,
        at: now(),
        audit: QUEST_AUDIT_OFF,
      })
      return { sponsor, taskId: task.id }
    }

    /** A citizen submits, the scrub writes, and a verdict accepts. */
    const aReport = async (input: {
      readonly taskId: TaskId
      readonly name: string
      readonly answers: Readonly<Record<string, string>>
      readonly accept?: boolean
    }) => {
      const citizen = await anAgent(input.name)
      const created = await createSubmission(db, {
        taskId: input.taskId,
        agentId: citizen,
        payload: { answers: input.answers },
      })
      if (created.outcome !== 'accepted') throw new Error(`fixture failed: ${created.outcome}`)

      await writeScrubbedAnswers(db, {
        submissionId: created.submission.id,
        taskId: input.taskId,
        answers: Object.entries(input.answers).map(([questionKey, text]) => ({
          questionKey,
          text,
        })),
      })

      if (input.accept !== false) {
        await db
          .update(questAnswers)
          .set({ acceptedAt: new Date().toISOString(), runtime: 'openclaw' })
          .where(eq(questAnswers.submissionId, created.submission.id))
      }

      return { citizen, submissionId: created.submission.id }
    }

    it('carries the scrubbed answers and nothing that names their author', async () => {
      const { taskId } = await aQuestWithReports()
      await aReport({
        taskId,
        name: 'ariadne',
        answers: { 'what-happened': 'The signup took two tries in total.', worked: 'yes' },
      })

      const [result] = await questResults(db, taskId)

      // Two fields, asserted exhaustively rather than by naming the two that
      // left: this is the shape `#328` fixed, and a third arriving here is the
      // change that has to be argued for.
      expect(Object.keys(result ?? {}).sort()).toEqual(['acceptedAt', 'answers'])
      expect(JSON.stringify(result)).not.toContain('ariadne')
      expect(JSON.stringify(result)).not.toContain('openclaw')
      expect(result?.answers).toEqual({
        'what-happened': 'The signup took two tries in total.',
        worked: 'yes',
      })
    })

    it('shows nothing that has not been accepted', async () => {
      const { taskId } = await aQuestWithReports()
      await aReport({
        taskId,
        name: 'unjudged',
        answers: { 'what-happened': 'Still waiting for a verdict here.', worked: 'no' },
        accept: false,
      })

      expect(await questResults(db, taskId)).toEqual([])
    })

    it('counts the closed question and leaves the free-text one alone', async () => {
      const { taskId } = await aQuestWithReports()
      await aReport({
        taskId,
        name: 'first',
        answers: { 'what-happened': 'It worked on the first try here.', worked: 'yes' },
      })
      await aReport({
        taskId,
        name: 'second',
        answers: { 'what-happened': 'The form lost my input entirely.', worked: 'no' },
      })

      expect(await questAnswerCounts(db, taskId)).toEqual({ worked: { yes: 1, no: 1 } })
    })

    it('keeps an erased citizen’s answers, having never carried its handle', async () => {
      const { taskId } = await aQuestWithReports()
      const { citizen } = await aReport({
        taskId,
        name: 'departing',
        answers: { 'what-happened': 'I registered and then left the Colony.', worked: 'yes' },
      })

      const erased = await eraseAgent(db, { agentId: citizen, banSalt: 'a'.repeat(32) })
      expect(erased.outcome).toBe('erased')

      const [result] = await questResults(db, taskId)

      // The row still means something with the author removed, which is
      // `erasure.md` §2's own test applied one level down.
      expect(result?.answers['what-happened']).toBe('I registered and then left the Colony.')
      // There is no name to drop since `#328`, which is the erasure rule
      // arriving at the same place from the other direction.
      expect(Object.keys(result ?? {}).sort()).toEqual(['acceptedAt', 'answers'])
    })

    it('does not merge two erased citizens into one report', async () => {
      const { taskId } = await aQuestWithReports()
      const first = await aReport({
        taskId,
        name: 'first-departing',
        answers: { 'what-happened': 'The first of two reports here.', worked: 'yes' },
      })
      const second = await aReport({
        taskId,
        name: 'second-departing',
        answers: { 'what-happened': 'The second of two reports here.', worked: 'no' },
      })

      await eraseAgent(db, { agentId: first.citizen, banSalt: 'a'.repeat(32) })
      await eraseAgent(db, { agentId: second.citizen, banSalt: 'a'.repeat(32) })

      expect(await questResults(db, taskId)).toHaveLength(2)
      expect(await questAnswerCounts(db, taskId)).toEqual({ worked: { yes: 1, no: 1 } })
    })

    it('shows a citizen its own answer, exactly as the sponsor sees it', async () => {
      const { taskId } = await aQuestWithReports()
      const { citizen } = await aReport({
        taskId,
        name: 'reader',
        answers: { 'what-happened': 'I want to see what was published.', worked: 'yes' },
      })

      const mine = await ownQuestAnswer(db, { taskId, agentId: citizen })
      const [theirs] = await questResults(db, taskId)

      expect(mine).toEqual(theirs)
    })

    /**
     * The correlation is on the submission since `#328`, and this is why it had
     * to move rather than merely being able to.
     *
     * It matched on the handle before, which was the only key the sponsor-facing
     * shape carried — so a citizen among several would find *an* answer with the
     * same name, and among erased citizens every one of them matched `null`. The
     * assertion is on the text, because two reports on the same quest differ in
     * nothing else.
     */
    it('gives each of several citizens its own answer and not a neighbour’s', async () => {
      const { taskId } = await aQuestWithReports()
      const first = await aReport({
        taskId,
        name: 'first-reader',
        answers: { 'what-happened': 'The first citizen wrote this one.', worked: 'yes' },
      })
      const second = await aReport({
        taskId,
        name: 'second-reader',
        answers: { 'what-happened': 'The second citizen wrote this one.', worked: 'no' },
      })

      const mine = await ownQuestAnswer(db, { taskId, agentId: first.citizen })
      const theirs = await ownQuestAnswer(db, { taskId, agentId: second.citizen })

      expect(mine?.answers['what-happened']).toBe('The first citizen wrote this one.')
      expect(theirs?.answers['what-happened']).toBe('The second citizen wrote this one.')
    })
  })

  /**
   * The audit that has to exist before a quest pays a coin (`#221`).
   *
   * The load-bearing test is the first one: a precondition that lives in a
   * document is one nobody reads at the moment it matters, and this one fails
   * the request.
   */
  describe('before the first coin', () => {
    const aPaidQuest = async (credits = 10) => {
      const sponsor = await anAgent(`sponsor-${crypto.randomUUID().slice(0, 8)}`)
      const steward = await anAgent(`steward-${crypto.randomUUID().slice(0, 8)}`, ['steward'])
      await credit(sponsor, 10_000)
      const { task } = await createQuestDraft(db, {
        authorId: sponsor,
        draft: aDraft({ reward: { credits, reputation: 1 }, slots: 10 }),
      })
      await submitQuestForReview(db, { authorId: sponsor, taskId: task.id, at: now() })
      await moderate(task.id)
      return { sponsor, steward, taskId: task.id }
    }

    it('refuses to publish a paying quest while sampling is off', async () => {
      const { sponsor, steward, taskId } = await aPaidQuest()

      const result = await publishQuest(db, {
        stewardId: steward,
        taskId,
        at: now(),
        audit: QUEST_AUDIT_OFF,
      })

      expect(result.outcome).toBe('audit-missing')
      if (result.outcome !== 'audit-missing') return
      expect(result.reason).toContain('sampling audit')
      // Refused means the quest is still awaiting review, not half published.
      expect((await readOwnQuest(db, sponsor, taskId))?.task.status).toBe('pending_review')
      expect(await escrowHeldFor(db, taskId)).toBe(0)
    })

    it('leaves a zero-reward quest entirely alone', async () => {
      const { steward, taskId } = await aPaidQuest(0)

      const result = await publishQuest(db, {
        stewardId: steward,
        taskId,
        at: now(),
        audit: QUEST_AUDIT_OFF,
      })

      expect(result.outcome).toBe('published')
    })

    /** Audit `count` verdicts, of which `disagreements` overrule the judge. */
    const audited = async (
      steward: AgentId,
      count: number,
      disagreements: number,
    ): Promise<void> => {
      for (let index = 0; index < count; index++) {
        const submissionId = await aPassedQuestSubmission(`audited-${index}`)
        await recordAuditDecision(db, {
          submissionId,
          stewardId: steward,
          agrees: index >= disagreements,
          reason: 'The report does not answer the question that was asked.',
        })
      }
    }

    it('refuses to publish once the judge is being overruled too often', async () => {
      const { steward, taskId } = await aPaidQuest()

      // Ten audits, eight of them disagreements: 80%, against a 20% threshold —
      // and a sample at the floor `#317` put under the brake.
      await audited(steward, 10, 8)

      const rate = await questDisagreementRate(db, { windowDays: 30 })
      expect(rate.rate).toBeCloseTo(0.8)
      expect(rate.audited).toBe(10)

      const result = await publishQuest(db, {
        stewardId: steward,
        taskId,
        at: now(),
        audit: AUDIT_ON,
      })

      expect(result.outcome).toBe('audit-missing')
      if (result.outcome !== 'audit-missing') return
      // The current rate is in the message, so a steward knows why and by how much.
      expect(result.reason).toContain('80%')
      // And the count, so a steward can tell a brake from a small sample.
      expect(result.reason).toContain('10 verdicts')
    })

    /**
     * `#317`: the brake needs a sample before it may stop anything.
     *
     * One disagreement out of three is 33 % and used to refuse every paid quest
     * until that single verdict aged out of a thirty-day window — which bit
     * hardest on the smallest quests, the ones audited at a rate of 1.0 because
     * a tenth of five reports draws nothing.
     */
    it('publishes anyway when one disagreement out of three is the whole sample', async () => {
      const { steward, taskId } = await aPaidQuest()

      await audited(steward, 3, 1)

      const rate = await questDisagreementRate(db, { windowDays: 30 })
      expect(rate.rate).toBeCloseTo(1 / 3)

      const result = await publishQuest(db, {
        stewardId: steward,
        taskId,
        at: now(),
        audit: AUDIT_ON,
      })

      expect(result.outcome).toBe('published')
    })

    /**
     * The precondition is untouched by the floor: a deployment with the audit
     * switched off refuses every paid quest at any count, including zero. That
     * refusal is `governance/quests.md`'s, and it is not a rate.
     */
    it('still refuses a paid quest with the audit off and no sample at all', async () => {
      const { steward, taskId } = await aPaidQuest()

      const result = await publishQuest(db, {
        stewardId: steward,
        taskId,
        at: now(),
        audit: QUEST_AUDIT_OFF,
      })

      expect(result.outcome).toBe('audit-missing')
      if (result.outcome !== 'audit-missing') return
      expect(result.reason).toContain('sampling audit')
    })

    it('draws the same submissions in SQL as core draws in TypeScript', async () => {
      const ids: string[] = []
      for (let index = 0; index < 200; index++) ids.push(crypto.randomUUID())

      const rows = await db.execute<{ id: string; drawn: boolean }>(
        sql`select id, (('x' || substr(md5(id::text), 1, 8))::bit(32)::bigint::numeric / 4294967295.0) < 0.1 as drawn
              from unnest(array[${sql.join(
                ids.map((id) => sql`${id}::uuid`),
                sql`, `,
              )}]) as id`,
      )

      expect(rows).toHaveLength(200)
      for (const row of rows) {
        expect(row.drawn).toBe(isAudited(row.id, 0.1))
      }
    })

    it('records a decision once, and a second steward gets told', async () => {
      const steward = await anAgent('audit-steward', ['steward'])
      const other = await anAgent('other-steward', ['steward'])
      const submissionId = await aPassedQuestSubmission('audited')

      expect(
        await recordAuditDecision(db, {
          submissionId,
          stewardId: steward,
          agrees: true,
          reason: 'I would have passed this one too.',
        }),
      ).toEqual({ outcome: 'recorded' })

      expect(
        await recordAuditDecision(db, {
          submissionId,
          stewardId: other,
          agrees: false,
          reason: 'I would not have passed this one.',
        }),
      ).toEqual({ outcome: 'already-audited' })
    })

    it('changes no balance when a steward disagrees', async () => {
      const steward = await anAgent('paying-steward', ['steward'])
      const submissionId = await aPassedQuestSubmission('paid-and-audited')

      const before = await db.execute<{ total: string }>(
        sql`select coalesce(sum(amount), 0)::text as total from ledger_entries`,
      )

      await recordAuditDecision(db, {
        submissionId,
        stewardId: steward,
        agrees: false,
        reason: 'The judge accepted an answer about a different service.',
      })

      const after = await db.execute<{ total: string }>(
        sql`select coalesce(sum(amount), 0)::text as total from ledger_entries`,
      )

      // A disagreement is counted, never applied. Reversing would mean clawing
      // back from a citizen that did what it was asked.
      expect(after[0]?.total).toBe(before[0]?.total)
      const [submission] = await db
        .select({ status: submissions.status })
        .from(submissions)
        .where(eq(submissions.id, submissionId))
      expect(submission?.status).toBe('passed')
    })

    it('shows a steward the questions, the answers and the verdict — and no citizen', async () => {
      const submissionId = await aPassedQuestSubmission('in-the-queue', { drawn: true })

      const queue = await questAuditQueue(db, { rate: 1 })
      const candidate = queue.find((entry) => entry.submissionId === submissionId)

      expect(candidate).toBeDefined()
      expect(JSON.stringify(candidate)).not.toContain('agentId')
      expect(candidate?.answers).not.toEqual([])
      expect(candidate?.verdict).toContain('answered')
    })

    it('never draws a hard quest, whatever the rate', async () => {
      await aPassedQuestSubmission('hard-quest', { proofVerifier: 'email-inbox' })

      expect(await questAuditQueue(db, { rate: 1 })).toEqual([])
    })

    /**
     * `#318`: a steward that also sponsors does not read the verdicts on its own
     * quest.
     *
     * The payout is untouched — an audit counts and never reverses one (D-061) —
     * so what a self-audit corrupts is the number that decides whether the
     * Colony keeps selling work, and its sponsor is the one party with an
     * interest in that answer.
     */
    describe('a steward that is also a sponsor', () => {
      it('is not drawn a verdict on the quest it sponsored', async () => {
        const steward = await anAgent('sponsoring-steward', ['steward'])
        const own = await aPassedQuestSubmission('own-quest', {
          drawn: true,
          authorId: steward,
        })
        const other = await aPassedQuestSubmission('someone-elses', { drawn: true })

        const queue = await questAuditQueue(db, { rate: 1 }, 50, steward)

        expect(queue.map((entry) => entry.submissionId)).toContain(other)
        expect(queue.map((entry) => entry.submissionId)).not.toContain(own)
      })

      /**
       * Hiding is not refusing. A submission id is guessable, the queue is a
       * suggestion, and `#173` put its ban at the write for the same reason.
       */
      it('is refused when it posts that submission id anyway, and writes no row', async () => {
        const steward = await anAgent('determined-steward', ['steward'])
        const submissionId = await aPassedQuestSubmission('posted-anyway', { authorId: steward })

        expect(
          await recordAuditDecision(db, {
            submissionId,
            stewardId: steward,
            agrees: true,
            reason: 'I read my own quest’s verdict and I agree with it.',
          }),
        ).toEqual({ outcome: 'own-quest' })

        expect((await questDisagreementRate(db, { windowDays: 30 })).audited).toBe(0)
      })

      it('audits anybody else’s quest exactly as before', async () => {
        const steward = await anAgent('ordinary-steward', ['steward'])
        const submissionId = await aPassedQuestSubmission('not-mine')

        expect(
          await recordAuditDecision(db, {
            submissionId,
            stewardId: steward,
            agrees: false,
            reason: 'The report answers a question that was not asked.',
          }),
        ).toEqual({ outcome: 'recorded' })
      })

      /**
       * An ownerless quest — its sponsor erased itself, leaving `created_by`
       * null — stays auditable. `null <> id` is null in SQL, so a plain
       * inequality would have dropped every such quest out of every queue.
       */
      it('still draws a quest whose sponsor has erased itself', async () => {
        const steward = await anAgent('steward-of-orphans', ['steward'])
        const orphaned = await aPassedQuestSubmission('orphaned', { drawn: true })
        await db
          .update(tasks)
          .set({ createdBy: null })
          .where(eq(tasks.id, (await taskOf(db, orphaned))!))

        const queue = await questAuditQueue(db, { rate: 1 }, 50, steward)

        expect(queue.map((entry) => entry.submissionId)).toContain(orphaned)
      })
    })
  })

  it('never writes a quest the Colony itself authored', async () => {
    const sponsor = await anAgent('sponsor')
    await createQuestDraft(db, { authorId: sponsor, draft: aDraft() })

    expect(await ownerlessQuestDrafts(db)).toBe(0)
  })
})

const textRevisedAt = async (db: Database, taskId: TaskId): Promise<string> => {
  const [row] = await db
    .select({ at: sql<string>`${tasks.textRevisedAt}::text` })
    .from(tasks)
    .where(eq(tasks.id, taskId))
  return row!.at
}

/** The quest a submission was made against. */
const taskOf = async (db: Database, submissionId: SubmissionId): Promise<TaskId | undefined> => {
  const [row] = await db
    .select({ taskId: submissions.taskId })
    .from(submissions)
    .where(eq(submissions.id, submissionId))
  return row?.taskId as TaskId | undefined
}
