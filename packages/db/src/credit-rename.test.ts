import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import type { Database } from './client.js'
import {
  assertNoRewardToConvert,
  CREDIT_RENAME_MIGRATION,
  REWARD_RENAME_GUARD_SQL,
} from './credit-rename.js'
import { tasks } from './schema/index.js'
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
 * `coin-unwind.test.ts`: the statement exists in the migration, which is what
 * ran against the deployment, and here, which is what the tests below drive.
 */
describe('the rename guard', () => {
  it('is the one the migration ran', async () => {
    const migration = await readFile(join(MIGRATIONS_FOLDER, CREDIT_RENAME_MIGRATION), 'utf8')

    expect(migration).toContain(REWARD_RENAME_GUARD_SQL.replace(/;$/, ''))
  })

  it('guards the pre-rename column name in the migration', () => {
    expect(REWARD_RENAME_GUARD_SQL).toContain('"reward_coins"')
  })
})

/**
 * `#218` renames the reward column and converts nothing, and the entire argument
 * for that is a measurement: every value was `0` when the issue was written.
 *
 * A measurement is not a property of the schema, so it is enforced rather than
 * remembered. These tests drive the guard against the column's post-rename name,
 * because by the time the suite runs the migration has already applied — the
 * statement is the same one either way, which is why it takes the name.
 */
describe('refusing to reinterpret a coin as a cent', () => {
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

  const aQuestPaying = (rewardLamports: number) =>
    db.insert(tasks).values({
      type: 'some-quest',
      kind: 'quest' as const,
      title: 'A quest somebody wrote',
      description: 'What this quest is, for a human reading the catalogue.',
      instructions: 'What the citizen must actually do.',
      rewardLamports,
      rewardReputation: 0,
      timeoutHours: 24,
      status: 'active' as const,
    })

  it('passes on the table the rename actually ran against', async () => {
    await expect(assertNoRewardToConvert(db, 'reward_lamports')).resolves.not.toThrow()
  })

  it('passes when every reward is zero', async () => {
    await aQuestPaying(0)

    await expect(assertNoRewardToConvert(db, 'reward_lamports')).resolves.not.toThrow()
  })

  /**
   * The case the guard exists for. The old unit was a whole coin and the new one
   * is a cent, so the same integer means a hundred times less money — a silent
   * rename here is the most expensive kind of correct-looking migration.
   */
  it('refuses, and says how many rows, when a reward is not zero', async () => {
    await aQuestPaying(250)
    await aQuestPaying(7)

    // The count, not the `%` placeholder — asserting the substituted message is
    // what tells the two apart. `expectRejection` is used rather than
    // `rejects.toThrow`, which cannot see past Drizzle's wrapper and would pass
    // on the query text alone.
    await expectRejection(
      () => assertNoRewardToConvert(db, 'reward_lamports'),
      /2 row\(s\) are non-zero/,
    )
  })

  it('names the issue that owes the conversion decision', async () => {
    await aQuestPaying(1)

    await expectRejection(
      () => assertNoRewardToConvert(db, 'reward_lamports'),
      /1 row\(s\) are non-zero[\s\S]*conversion decision is owed/,
    )
  })

  /**
   * The live table on the day of the rename. `#218` argued the rename was safe
   * because every value was zero; this asserts the same thing the guard does, at
   * the level the acceptance criteria asked for it.
   */
  it('holds no non-zero reward at all', async () => {
    const [row] = await db
      .select({ offending: sql<number>`count(*) filter (where ${tasks.rewardLamports} <> 0)::int` })
      .from(tasks)

    expect(row?.offending).toBe(0)
  })
})
