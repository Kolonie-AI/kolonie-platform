import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  QUEST_AUDIT_OFF,
  QUEST_REVIEW_REWARD_CREDITS,
  noStagesRun,
  type AgentId,
  type QuestDraft,
  type TaskId,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agents, ledgerEntries, tasks } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { balanceOfAgent } from './balance.js'
import { treasuryBalance } from './escrow.js'
import {
  createQuestDraft,
  publishQuest,
  recordQuestModeration,
  refuseQuest,
  submitQuestForReview,
} from './quests/index.js'

/**
 * A steward is paid for deciding a quest, either verdict (`D-105`, `#499`).
 *
 * **The four things `#499` says have to be true, and each is a test here**: the
 * same amount for both verdicts, once per quest, it survives an empty Treasury,
 * and it lands in the steward's one balance.
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

  /**
   * Money into the Treasury, from the mint.
   *
   * **Every test here has to do this explicitly**, and that is worth stating
   * because it is not obvious: nothing in the ordinary fixtures leaves the
   * Treasury with anything in it. `quests.test.ts`'s `credit` helper books
   * `treasury → agent`, so a test that funds a sponsor drives the Treasury
   * *negative*. Production's bootstrap balance has no equivalent in a truncated
   * database, so a test that forgot this would be testing the empty branch and
   * passing.
   */
  const fundTreasury = async (amount: number): Promise<void> => {
    const transactionId = crypto.randomUUID()
    await db.insert(ledgerEntries).values([
      {
        transactionId,
        accountKind: 'system' as const,
        systemAccount: 'mint' as const,
        amount: -amount,
        type: 'adjustment' as const,
        reference: `bootstrap:treasury:${transactionId}`,
      },
      {
        transactionId,
        accountKind: 'system' as const,
        systemAccount: 'treasury' as const,
        amount,
        type: 'adjustment' as const,
        reference: `bootstrap:treasury:${transactionId}`,
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

  const reviewEntries = async (agentId: AgentId) =>
    await db.select().from(ledgerEntries).where(eq(ledgerEntries.agentId, agentId))

  it('pays a steward that publishes', async () => {
    await fundTreasury(100)
    const { steward, taskId } = await aQuestAwaitingReview()

    const result = await publishQuest(db, {
      stewardId: steward,
      taskId,
      at: now(),
      audit: QUEST_AUDIT_OFF,
    })

    expect(result.outcome).toBe('published')
    // Read back rather than inferred from the booking: `#499`'s first two
    // criteria are about the balance, which is the ledger summed and not a
    // column anybody wrote.
    expect((await balanceOfAgent(db, steward)).credits).toBe(QUEST_REVIEW_REWARD_CREDITS)
  })

  it('pays a steward that refuses, the same amount', async () => {
    await fundTreasury(100)
    const { steward, taskId } = await aQuestAwaitingReview()

    const result = await refuseQuest(db, {
      stewardId: steward,
      taskId,
      reason: 'Say which page the citizen should register on.',
      at: now(),
    })

    expect(result).toEqual({ outcome: 'refused' })
    expect((await balanceOfAgent(db, steward)).credits).toBe(QUEST_REVIEW_REWARD_CREDITS)
  })

  /**
   * The whole of D-105, asserted as one comparison rather than as two numbers
   * that happen to match. A payment that differed by verdict would carry an
   * opinion about the verdict, and *refusing is the decision the Colony most
   * needs done well*.
   */
  it('books identically for the two verdicts', async () => {
    await fundTreasury(100)
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

    const shape = (row: { amount: number; type: string; memo: string | null }) => ({
      amount: row.amount,
      type: row.type,
      // The quest id differs between the two and nothing else does.
      memo: row.memo?.replace(/quest .*/, 'quest <id>'),
    })

    expect((await reviewEntries(published.steward)).map(shape)).toEqual(
      (await reviewEntries(refused.steward)).map(shape),
    )
  })

  it('books it as review_reward against the treasury, and the pair balances', async () => {
    await fundTreasury(100)
    const { steward, taskId } = await aQuestAwaitingReview()
    await publishQuest(db, { stewardId: steward, taskId, at: now(), audit: QUEST_AUDIT_OFF })

    const [entry] = await reviewEntries(steward)
    expect(entry?.type).toBe('review_reward')
    expect(entry?.amount).toBe(QUEST_REVIEW_REWARD_CREDITS)

    const both = await db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.transactionId, entry!.transactionId))
    expect(both).toHaveLength(2)
    expect(both.reduce((sum, row) => sum + row.amount, 0)).toBe(0)
    expect(both.find((row) => row.accountKind === 'system')?.systemAccount).toBe('treasury')

    // The money came out of the Treasury and not from the mint: a review is
    // paid, not minted (D-038).
    expect(await treasuryBalance(db)).toBe(100 - QUEST_REVIEW_REWARD_CREDITS)
  })

  /**
   * `#499` asks that this be asserted rather than relied on. The bound is
   * natural today — a quest leaves `pending_review` once — but a retry path
   * added later would break it silently, and a steward paid twice for one
   * reading is the thing that would not be noticed.
   */
  it('pays once per quest, however many times the decision is called', async () => {
    await fundTreasury(100)
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
    expect(await reviewEntries(steward)).toHaveLength(1)
    expect((await balanceOfAgent(db, steward)).credits).toBe(QUEST_REVIEW_REWARD_CREDITS)
  })

  /**
   * The branch `#499` asked to be decided rather than discovered, and it is not
   * hypothetical: at pilot prices the fee on a quest is zero, so every payment
   * here comes out of a bootstrap balance nothing replenishes.
   *
   * **A steward's verdict must not fail on the Colony's bookkeeping.** A steward
   * that reads a quest carefully, refuses it for a good reason and is told the
   * refusal did not go through because the Treasury is empty has been given a
   * worse outcome than an unpaid review.
   */
  describe('when the Treasury cannot cover it', () => {
    it('still decides, pays nothing, and says so', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        // Deliberately not funded, and not zero either: one less than the price
        // is the boundary, and a test at zero would pass on a `> 0` check.
        await fundTreasury(QUEST_REVIEW_REWARD_CREDITS - 1)
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

        expect(await reviewEntries(steward)).toEqual([])
        expect((await balanceOfAgent(db, steward)).credits).toBe(0)
        expect(warn).toHaveBeenCalledOnce()
        expect(warn.mock.calls[0]?.[0]).toContain('the steward was not paid')
      } finally {
        warn.mockRestore()
      }
    })

    it('does not overdraw it on the quest that empties it', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        await fundTreasury(QUEST_REVIEW_REWARD_CREDITS)
        const first = await aQuestAwaitingReview()
        const second = await aQuestAwaitingReview()

        await publishQuest(db, {
          stewardId: first.steward,
          taskId: first.taskId,
          at: now(),
          audit: QUEST_AUDIT_OFF,
        })
        await publishQuest(db, {
          stewardId: second.steward,
          taskId: second.taskId,
          at: now(),
          audit: QUEST_AUDIT_OFF,
        })

        expect((await balanceOfAgent(db, first.steward)).credits).toBe(QUEST_REVIEW_REWARD_CREDITS)
        expect((await balanceOfAgent(db, second.steward)).credits).toBe(0)
        expect(await treasuryBalance(db)).toBe(0)
      } finally {
        warn.mockRestore()
      }
    })
  })
})
