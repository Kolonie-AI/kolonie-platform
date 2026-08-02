import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { noStagesRun, type AgentId, type QuestDraft, type TaskId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agents, authorityEvents, ledgerEntries, questModerations, tasks } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { escrowHeldFor } from './escrow.js'
import { createSubmission } from './submissions.js'
import { listTasks } from './tasks.js'
import {
  createQuestDraft,
  listOwnQuests,
  pendingAnswerModerations,
  questDefinition,
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
  updateQuestDraft,
} from './quests.js'

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

      expect(result).toEqual({ outcome: 'insufficient-funds', shortfall: 400 })
      expect((await readOwnQuest(db, sponsor, task.id))?.task.status).toBe('draft')
    })

    it('counts what is already reserved, so the same credit is not committed twice', async () => {
      const sponsor = await anAgent('sponsor')
      await credit(sponsor, 100)
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
      await publishQuest(db, { stewardId: steward, taskId: first.task.id, at: now() })

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

      const result = await publishQuest(db, { stewardId: steward, taskId: task.id, at: now() })

      expect(result).toEqual({ outcome: 'published', escrowed: 100 })
      expect((await readOwnQuest(db, sponsor, task.id))?.task.status).toBe('active')
      expect(await escrowHeldFor(db, task.id)).toBe(100)
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
        publishQuest(db, { stewardId: steward, taskId: task.id, at: now() }),
      ).rejects.toThrow()

      expect((await readOwnQuest(db, sponsor, task.id))?.task.status).toBe('pending_review')
    })

    it('refuses a steward publishing its own quest', async () => {
      const steward = await anAgent('steward', ['steward'])
      const { task } = await createQuestDraft(db, { authorId: steward, draft: aDraft() })
      await submitQuestForReview(db, { authorId: steward, taskId: task.id, at: now() })
      await moderate(task.id)

      expect(await publishQuest(db, { stewardId: steward, taskId: task.id, at: now() })).toEqual({
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

      expect(await publishQuest(db, { stewardId: steward, taskId: task.id, at: now() })).toEqual({
        outcome: 'awaiting-moderation',
      })
    })

    it('stores the refusal, frees the reservation, and records who refused', async () => {
      const sponsor = await anAgent('sponsor')
      const steward = await anAgent('steward', ['steward'])
      await credit(sponsor, 100)
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
      await publishQuest(db, { stewardId: steward, taskId: task.id, at: now() })

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

      expect(await publishQuest(db, { stewardId: steward, taskId: task.id, at: now() })).toEqual({
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
      await publishQuest(db, { stewardId: steward, taskId: task.id, at: now() })

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
      await publishQuest(db, { stewardId: steward, taskId: task.id, at: now() })
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
