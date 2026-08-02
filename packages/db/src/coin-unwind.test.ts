import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { and, eq, isNull, sql } from 'drizzle-orm'
import type { Database } from './client.js'
import {
  COIN_UNWIND_MIGRATION,
  COIN_UNWIND_REFERENCE,
  UNWIND_ACADEMY_COINS_SQL,
  unwindAcademyCoins,
} from './coin-unwind.js'
import { agents, ledgerEntries, tasks } from './schema/index.js'
import {
  connectForTests,
  databaseTestTarget,
  expectRejection,
  MIGRATIONS_FOLDER,
  truncateAll,
} from './testing.js'

const target = databaseTestTarget()

/**
 * The copy check, and it needs no database. Same arrangement as
 * `skill-backfill.test.ts`: the statement exists in the migration, which is what
 * ran against the deployment, and here, which is what the tests below drive.
 */
describe('the unwind statement', () => {
  it('is the one the migration ran', async () => {
    const migration = await readFile(join(MIGRATIONS_FOLDER, COIN_UNWIND_MIGRATION), 'utf8')

    expect(migration).toContain(UNWIND_ACADEMY_COINS_SQL.replace(/;$/, ''))
  })
})

describe('unwinding the Academy’s coins', () => {
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

  const anAgent = async (name: string) => {
    const [row] = await db
      .insert(agents)
      .values({ name, platform: 'openclaw' })
      .returning({ id: agents.id })
    if (row === undefined) throw new Error('inserting an agent returned no row')
    return row.id
  }

  /** A pass that paid coins the way the Academy did before #43. */
  const paid = async (agentId: string, coins: number, reference: string) => {
    const transactionId = crypto.randomUUID()
    await db.insert(ledgerEntries).values([
      {
        transactionId,
        accountKind: 'system' as const,
        systemAccount: 'mint' as const,
        amount: -coins,
        type: 'task_reward' as const,
        reference,
      },
      {
        transactionId,
        accountKind: 'agent' as const,
        agentId,
        amount: coins,
        type: 'task_reward' as const,
        reference,
      },
    ])
  }

  const balanceOf = async (agentId: string) => {
    const [row] = await db
      .select({ balance: sql<number>`coalesce(sum(${ledgerEntries.amount}), 0)::int` })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.agentId, agentId))
    return row?.balance ?? 0
  }

  const mintBalance = async () => {
    const [row] = await db
      .select({ balance: sql<number>`coalesce(sum(${ledgerEntries.amount}), 0)::int` })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.systemAccount, 'mint'))
    return row?.balance ?? 0
  }

  const ledgerTotal = async () => {
    const [row] = await db
      .select({ total: sql<number>`coalesce(sum(${ledgerEntries.amount}), 0)::int` })
      .from(ledgerEntries)
    return row?.total ?? 0
  }

  it('leaves a holder of Academy coins with nothing', async () => {
    const agentId = await anAgent('paid-thrice')
    await paid(agentId, 10, 'submission:one')
    await paid(agentId, 20, 'submission:two')
    await paid(agentId, 35, 'submission:three')
    expect(await balanceOf(agentId)).toBe(65)

    await unwindAcademyCoins(db)

    expect(await balanceOf(agentId)).toBe(0)
  })

  /**
   * **The invariant the whole migration is judged on.** The ledger summed to zero
   * before the unwind and sums to zero after, because each reversal is a balanced
   * pair. If it were not, the deferred trigger would have aborted the commit and
   * this test would fail inside `unwindAcademyCoins` rather than on the assertion.
   */
  it('keeps the ledger summing to zero', async () => {
    await paid(await anAgent('one'), 10, 'submission:a')
    await paid(await anAgent('two'), 25, 'submission:b')
    expect(await ledgerTotal()).toBe(0)

    await unwindAcademyCoins(db)

    expect(await ledgerTotal()).toBe(0)
  })

  /**
   * The readable form of *no coin was ever minted as a reward for work*: after the
   * unwind the mint is square, so total supply — the negative of the mint balance —
   * is zero.
   */
  it('returns the whole supply to the mint', async () => {
    await paid(await anAgent('one'), 30, 'submission:a')
    await paid(await anAgent('two'), 15, 'submission:b')
    expect(await mintBalance()).toBe(-45)

    await unwindAcademyCoins(db)

    expect(await mintBalance()).toBe(0)
  })

  /**
   * Both sides of one holder's reversal must share a `transaction_id`, or each is
   * an unbalanced transaction of its own. This is what `MATERIALIZED` in the
   * statement guarantees — see the note on `UNWIND_ACADEMY_COINS_SQL`.
   */
  it('books each reversal as one transaction, not two halves', async () => {
    const first = await anAgent('one')
    const second = await anAgent('two')
    await paid(first, 10, 'submission:a')
    await paid(second, 20, 'submission:b')

    await unwindAcademyCoins(db)

    const groups = await db
      .select({
        transactionId: ledgerEntries.transactionId,
        entries: sql<number>`count(*)::int`,
        total: sql<number>`sum(${ledgerEntries.amount})::int`,
      })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.reference, COIN_UNWIND_REFERENCE))
      .groupBy(ledgerEntries.transactionId)

    expect(groups).toHaveLength(2)
    for (const group of groups) {
      expect(group.entries).toBe(2)
      expect(group.total).toBe(0)
    }
  })

  it('does not touch the original task_reward entries', async () => {
    const agentId = await anAgent('paid-once')
    await paid(agentId, 20, 'submission:a')

    await unwindAcademyCoins(db)

    const [row] = await db
      .select({ entries: sql<number>`count(*)::int` })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.type, 'task_reward'))

    expect(row?.entries).toBe(2)
  })

  it('is safe to run twice, which is what makes it safe to run by hand', async () => {
    const agentId = await anAgent('repeatable')
    await paid(agentId, 20, 'submission:a')

    await unwindAcademyCoins(db)
    await unwindAcademyCoins(db)

    expect(await balanceOf(agentId)).toBe(0)
    expect(await ledgerTotal()).toBe(0)
  })

  it('leaves an agent that was never paid alone', async () => {
    const bystander = await anAgent('bystander')
    await paid(await anAgent('holder'), 10, 'submission:a')

    await unwindAcademyCoins(db)

    const [row] = await db
      .select({ entries: sql<number>`count(*)::int` })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.agentId, bystander))

    expect(row?.entries).toBe(0)
  })

  /**
   * A reversal is an `adjustment`, not a second `task_reward`. Two reasons, and
   * the second is enforced: it is genuinely an adjustment, and
   * `ledger_entries_task_reward_unique` would refuse a second `task_reward` on the
   * same reference anyway.
   */
  it('books the reversal as an adjustment', async () => {
    await paid(await anAgent('holder'), 10, 'submission:a')

    await unwindAcademyCoins(db)

    const rows = await db
      .select({ type: ledgerEntries.type })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.reference, COIN_UNWIND_REFERENCE))

    expect(rows).toHaveLength(2)
    expect(rows.every((row) => row.type === 'adjustment')).toBe(true)
  })

  it('credits the mint side and debits the agent side', async () => {
    const agentId = await anAgent('holder')
    await paid(agentId, 30, 'submission:a')

    await unwindAcademyCoins(db)

    const [agentSide] = await db
      .select({ amount: ledgerEntries.amount })
      .from(ledgerEntries)
      .where(
        and(eq(ledgerEntries.reference, COIN_UNWIND_REFERENCE), eq(ledgerEntries.agentId, agentId)),
      )
    const [mintSide] = await db
      .select({ amount: ledgerEntries.amount })
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.reference, COIN_UNWIND_REFERENCE), isNull(ledgerEntries.agentId)))

    expect(agentSide?.amount).toBe(-30)
    expect(mintSide?.amount).toBe(30)
  })
})

/**
 * The constraint that keeps #43 true against a write path nobody has built yet.
 *
 * The seed setting `reward_credits` to zero satisfies the rule today. This is what
 * satisfies it when a citizen-authored task is written by an agent — the case
 * `tasks.created_by` already models and no code yet serves.
 */
describe('what an Academy task may pay', () => {
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

  const insertTask = (kind: 'academy' | 'quest' | undefined, rewardCredits: number) =>
    db.insert(tasks).values({
      type: 'some-rung',
      ...(kind === undefined ? {} : { kind }),
      title: 'A task somebody wrote',
      description: 'What this task is, for a human reading the catalogue.',
      instructions: 'What the agent must actually do.',
      rewardCredits,
      rewardReputation: 3,
      timeoutHours: 24,
      status: 'active' as const,
    })

  it('refuses an Academy task that pays coins', async () => {
    await expectRejection(() => insertTask('academy', 5), /tasks_academy_pays_no_credits/)
  })

  /**
   * The default is the safe one: a writer that says nothing about kind gets
   * `academy`, and is therefore refused for paying coins rather than quietly
   * minting them.
   */
  it('refuses a task that pays coins without saying what kind it is', async () => {
    await expectRejection(() => insertTask(undefined, 5), /tasks_academy_pays_no_credits/)
  })

  it('allows an Academy task that pays reputation only', async () => {
    await expect(insertTask('academy', 0)).resolves.not.toThrow()
  })

  it('allows a Quest to pay coins, because that is what a Quest is', async () => {
    await expect(insertTask('quest', 250)).resolves.not.toThrow()
  })
})
