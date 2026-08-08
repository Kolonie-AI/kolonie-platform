import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import {
  QUEST_AUDIT_OFF,
  QUEST_REVIEW_REWARD_LAMPORTS,
  noStagesRun,
  type AgentId,
  type QuestDraft,
  type TaskId,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agents, ledgerEntries, payoutObligations, tasks } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { oweForReview } from './payouts.js'
import {
  createQuestDraft,
  publishQuest,
  recordQuestModeration,
  refuseQuest,
  submitQuestForReview,
} from './quests/index.js'

/**
 * A steward is owed for deciding a quest, either verdict (`D-105`, `#499`).
 *
 * **What `#499` asked for is unchanged; what pays it is not** (`#553` phase B′).
 * The steward used to be credited from the Treasury inside the deciding
 * transaction. Under D-106 there are no credits and no balance anybody holds, so
 * the write in that transaction is an **obligation** — the same one an accepted
 * report makes — and the payout runner that already knows how to pay, refuse,
 * retry, forfeit and settle an erasure does the rest.
 *
 * `#499`'s four properties survive the change and are each a test here: the same
 * amount for both verdicts, once per quest, the decision commits whatever
 * happens to the money, and it is owed to the steward that did the reading.
 *
 * **The Treasury branch is gone rather than ported.** *Can the Colony afford
 * this right now* is the payout runner's `floatShort`, and a second, different
 * affordability rule on the same money is how two answers to one question start.
 * What replaces those tests is stronger: a steward whose payment cannot go out
 * today is **owed**, where before it was silently unpaid with a line on stderr.
 *
 * Its own file rather than more of `quests.test.ts`, which is already long and
 * is where every other agent working the quest path is editing.
 */

const target = databaseTestTarget()

describe('what a steward is paid for deciding a quest', () => {
  let db: Database

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
    fixture = 0
  })

  const now = (): string => new Date().toISOString()

  const anAgent = async (name: string, roles: readonly 'steward'[] = []) => {
    const [row] = await db
      .insert(agents)
      .values({ name, platform: 'openclaw', status: 'citizen', roles: [...roles] })
      .returning({ id: agents.id })
    return row!.id as AgentId
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
    // Nothing, so no escrow and no audit guard stand between this test and the
    // decision it is about. `#499` is not about the sponsor's money.
    reward: { credits: 0, reputation: 5, lamports: 0 },
    slots: 10,
    expiresAt: new Date(Date.now() + 7 * 24 * 3_600_000).toISOString(),
    audience: 'citizens',
    requires: [],
    minReputation: 0,
    minActivityDays: null,
    distinctOperators: false,
    publishObstacles: true,
    timeoutHours: 24,
    assistanceAllowed: true,
    // Prose, which is what a sponsor that says nothing about it gets (#525).
    deliverable: 'report',
    ...overrides,
  })

  const moderate = async (taskId: TaskId): Promise<void> => {
    const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1)
    const result = await recordQuestModeration(db, {
      taskId,
      decision: 'approved',
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

  /**
   * A quest by somebody else, moderated, sitting in the steward's queue.
   *
   * A fresh sponsor and a fresh steward each time, because two tests here decide
   * two quests and `agents_name_unique` is case-insensitive — the same pair
   * reused would fail on the second call rather than on the assertion.
   */
  let fixture = 0
  const aQuestAwaitingReview = async (): Promise<{ steward: AgentId; taskId: TaskId }> => {
    const nth = ++fixture
    const sponsor = await anAgent(`sponsor-${nth}`)
    const steward = await anAgent(`steward-${nth}`, ['steward'])
    const { task } = await createQuestDraft(db, { authorId: sponsor, draft: aDraft() })
    await submitQuestForReview(db, { authorId: sponsor, taskId: task.id, at: now() })
    await moderate(task.id)
    return { steward, taskId: task.id }
  }

  /** What the Colony owes this steward for reviews, as rows. */
  const reviewObligations = async (agentId: AgentId) =>
    await db
      .select()
      .from(payoutObligations)
      .where(and(eq(payoutObligations.agentId, agentId), eq(payoutObligations.kind, 'review')))

  /** Every ledger entry naming this agent — none, for a review, and that is the point. */
  const ledgerEntriesOf = async (agentId: AgentId) =>
    await db.select().from(ledgerEntries).where(eq(ledgerEntries.agentId, agentId))

  it('owes a steward that publishes', async () => {
    const { steward, taskId } = await aQuestAwaitingReview()

    const result = await publishQuest(db, {
      stewardId: steward,
      taskId,
      at: now(),
      audit: QUEST_AUDIT_OFF,
    })

    expect(result.outcome).toBe('published')
    const owed = await reviewObligations(steward)
    expect(owed).toHaveLength(1)
    expect(owed[0]?.lamports).toBe(QUEST_REVIEW_REWARD_LAMPORTS)
    expect(owed[0]?.taskId).toBe(taskId)
    // A review has no submission, which is what the second uniqueness rule is
    // there to carry instead.
    expect(owed[0]?.submissionId).toBeNull()
  })

  it('owes a steward that refuses, the same amount', async () => {
    const { steward, taskId } = await aQuestAwaitingReview()

    const result = await refuseQuest(db, {
      stewardId: steward,
      taskId,
      reason: 'Say which page the citizen should register on.',
      at: now(),
    })

    expect(result).toEqual({ outcome: 'refused' })
    const owed = await reviewObligations(steward)
    expect(owed).toHaveLength(1)
    expect(owed[0]?.lamports).toBe(QUEST_REVIEW_REWARD_LAMPORTS)
  })

  /**
   * The whole of D-105, asserted as one comparison rather than as two numbers
   * that happen to match. A payment that differed by verdict would carry an
   * opinion about the verdict, and *refusing is the decision the Colony most
   * needs done well*.
   */
  it('records identically for the two verdicts', async () => {
    const published = await aQuestAwaitingReview()
    await publishQuest(db, {
      stewardId: published.steward,
      taskId: published.taskId,
      at: now(),
      audit: QUEST_AUDIT_OFF,
    })

    const refused = await aQuestAwaitingReview()
    await refuseQuest(db, {
      stewardId: refused.steward,
      taskId: refused.taskId,
      reason: 'Say which page the citizen should register on.',
      at: now(),
    })

    const shape = (row: { lamports: number; kind: string; submissionId: string | null }) => ({
      lamports: row.lamports,
      kind: row.kind,
      submissionId: row.submissionId,
    })

    expect((await reviewObligations(published.steward)).map(shape)).toEqual(
      (await reviewObligations(refused.steward)).map(shape),
    )
  })

  /**
   * **A review is owed, not booked**, and this is the assertion that says the
   * old path is gone rather than merely unused: no credit reaches the steward,
   * because there is nowhere for one to go.
   */
  it('writes no ledger entry for the steward, because a review is not a credit', async () => {
    const { steward, taskId } = await aQuestAwaitingReview()

    await publishQuest(db, { stewardId: steward, taskId, at: now(), audit: QUEST_AUDIT_OFF })

    expect(await ledgerEntriesOf(steward)).toEqual([])
  })

  /**
   * `#499` asks that this be asserted rather than relied on. The bound used to
   * be natural — a quest leaves `pending_review` once — and the submission's
   * uniqueness was carrying it for reports. A review has no submission, so
   * `payout_obligations_review_unique` is what carries it now, and a retried
   * publication paying a steward twice is exactly what it stops.
   */
  it('owes once per quest, however many times the decision is called', async () => {
    const { steward, taskId } = await aQuestAwaitingReview()

    await publishQuest(db, { stewardId: steward, taskId, at: now(), audit: QUEST_AUDIT_OFF })
    const second = await publishQuest(db, {
      stewardId: steward,
      taskId,
      at: now(),
      audit: QUEST_AUDIT_OFF,
    })
    const third = await refuseQuest(db, {
      stewardId: steward,
      taskId,
      reason: 'Say which page the citizen should register on.',
      at: now(),
    })

    expect(second.outcome).toBe('not-in-review')
    expect(third.outcome).toBe('not-in-review')
    expect(await reviewObligations(steward)).toHaveLength(1)
  })

  /**
   * The uniqueness rule on its own terms, without going through the states that
   * happen to prevent a second call today. `oweForReview` is what a later retry
   * path would reach, and this is the assertion that it is safe to.
   */
  it('refuses a second review obligation for the same steward and quest', async () => {
    const { steward, taskId } = await aQuestAwaitingReview()
    await publishQuest(db, { stewardId: steward, taskId, at: now(), audit: QUEST_AUDIT_OFF })

    const again = await db.transaction((tx) =>
      oweForReview(tx, {
        stewardId: steward,
        taskId,
        lamports: QUEST_REVIEW_REWARD_LAMPORTS,
      }),
    )

    expect(again).toBeUndefined()
    expect(await reviewObligations(steward)).toHaveLength(1)
  })

  /**
   * The Treasury branch is **gone**, and this is what replaces the two tests
   * that covered it.
   *
   * Before `#553` phase B′, a steward deciding a quest the Treasury could not
   * pay for got the verdict and no money, with a line on stderr — the decision
   * committing was the whole point (`#499`) and it still is. What changes is the
   * other half: there is now a **record that it is owed**, so the money is late
   * rather than lost, and *can the Colony afford this today* is asked once, by
   * the payout runner, where it was already being asked.
   */
  it('records the debt whatever the Colony can afford today, because affordability is the runner’s question', async () => {
    const { steward, taskId } = await aQuestAwaitingReview()

    const result = await refuseQuest(db, {
      stewardId: steward,
      taskId,
      reason: 'Say which page the citizen should register on.',
      at: now(),
    })

    expect(result).toEqual({ outcome: 'refused' })
    const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1)
    expect(row?.status).toBe('rejected')

    // Nothing was funded anywhere in this test, and the steward is owed anyway.
    const owed = await reviewObligations(steward)
    expect(owed).toHaveLength(1)
    expect(owed[0]?.paidAt).toBeNull()
  })
})
