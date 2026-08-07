import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import type { Database } from './client.js'
import {
  BACKFILL_QUESTION_KEYS_SQL,
  QUESTION_KEY_BACKFILL_MIGRATION,
  backfillQuestionKeys,
} from './question-key-backfill.js'
import { tasks } from './schema/index.js'
import { connectForTests, databaseTestTarget, MIGRATIONS_FOLDER, truncateAll } from './testing.js'

const target = databaseTestTarget()

/**
 * The copy check, and it needs no database. Same arrangement as
 * `raster-rename.test.ts` and `credit-rename.test.ts`: the statement exists in
 * the migration, which is what ran against the deployment, and here, which is
 * what the tests below drive.
 */
describe('the backfill statement', () => {
  it('is the one the migration ran', async () => {
    const migration = await readFile(
      join(MIGRATIONS_FOLDER, QUESTION_KEY_BACKFILL_MIGRATION),
      'utf8',
    )

    expect(migration).toContain(BACKFILL_QUESTION_KEYS_SQL)
  })

  /**
   * The order is the whole reason both statements are in one migration. Adding
   * the constraint first would refuse the row the repair exists to reach, and the
   * migration would fail on the only deployment that has one.
   */
  it('runs before the constraint that would have refused the row', async () => {
    const migration = await readFile(
      join(MIGRATIONS_FOLDER, QUESTION_KEY_BACKFILL_MIGRATION),
      'utf8',
    )

    expect(migration.indexOf('UPDATE "tasks"')).toBeLessThan(
      migration.indexOf('tasks_questions_carry_a_key'),
    )
  })
})

/**
 * **The row that could not be read** (`#542`).
 *
 * Driven against a database with the constraint dropped, because that is the
 * state the repair actually meets: the rows it is for were written before the
 * rule existed, and after the migration no statement can produce another one.
 * Every test puts the constraint back, so nothing here weakens the schema the
 * rest of the suite runs against.
 */
describe('backfilling a keyless question', () => {
  let db: Database

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  /**
   * The constraint is the thing this repair precedes, so it is not in force
   * while the repair is being driven — and it is put back before the next file
   * sees the schema. `addTheConstraint` is the migration's own statement, so a
   * test that changes one and not the other fails here.
   */
  const ADD_THE_CONSTRAINT = sql`ALTER TABLE "tasks" ADD CONSTRAINT "tasks_questions_carry_a_key" CHECK (jsonb_array_length("tasks"."questions") = jsonb_array_length(jsonb_path_query_array("tasks"."questions", '$[*] ? (@.key like_regex "^[a-z0-9]+(-[a-z0-9]+)*$")')))`

  beforeEach(async () => {
    await truncateAll(db)
    await db.execute(
      sql`ALTER TABLE "tasks" DROP CONSTRAINT IF EXISTS "tasks_questions_carry_a_key"`,
    )
  })

  afterEach(async () => {
    await truncateAll(db)
    await db.execute(ADD_THE_CONSTRAINT)
  })

  const aQuestAsking = async (questions: unknown): Promise<void> => {
    await db.insert(tasks).values({
      type: 'a-quest',
      title: 'Prove the settlement path end to end',
      description: 'What this quest is, for somebody deciding whether to answer it.',
      instructions: 'What the citizen is actually asked to do.',
      rewardCredits: 0,
      rewardReputation: 1,
      timeoutHours: 24,
      status: 'active',
      kind: 'quest',
      audience: 'citizens',
      questions,
    })
  }

  const storedQuestions = async (): Promise<unknown> => {
    const [row] = await db.select({ questions: tasks.questions }).from(tasks)
    return row?.questions
  }

  /** The two questions of `767f79cd`, as the table held them. */
  it('gives each question a key derived from its position', async () => {
    await aQuestAsking([
      { prompt: 'What did you do to pay the invoice?', required: true },
      { prompt: 'What was unclear before you paid?', required: true },
    ])

    await backfillQuestionKeys(db)

    expect(await storedQuestions()).toEqual([
      { key: 'question-1', prompt: 'What did you do to pay the invoice?', required: true },
      { key: 'question-2', prompt: 'What was unclear before you paid?', required: true },
    ])
  })

  it('keeps the order the sponsor wrote them in', async () => {
    await aQuestAsking([
      { prompt: 'First' },
      { prompt: 'Second' },
      { prompt: 'Third' },
      { prompt: 'Fourth' },
    ])

    await backfillQuestionKeys(db)

    expect((await storedQuestions()) as { prompt: string; key: string }[]).toEqual([
      { prompt: 'First', key: 'question-1' },
      { prompt: 'Second', key: 'question-2' },
      { prompt: 'Third', key: 'question-3' },
      { prompt: 'Fourth', key: 'question-4' },
    ])
  })

  /**
   * The rejection case, and the one that matters most: a key a citizen may
   * already have answered against is never rewritten. Only the neighbour that
   * has none is touched.
   */
  it('leaves a well-formed key exactly as it was', async () => {
    await aQuestAsking([
      { key: 'went-well', prompt: 'How did it go?', required: true },
      { prompt: 'What was unclear?', required: true },
    ])

    await backfillQuestionKeys(db)

    expect(await storedQuestions()).toEqual([
      { key: 'went-well', prompt: 'How did it go?', required: true },
      { key: 'question-2', prompt: 'What was unclear?', required: true },
    ])
  })

  it('replaces a key that is present and unusable', async () => {
    await aQuestAsking([{ key: 'Went_Well', prompt: 'How did it go?' }])

    await backfillQuestionKeys(db)

    expect(await storedQuestions()).toEqual([{ key: 'question-1', prompt: 'How did it go?' }])
  })

  it('touches nothing on a task that asks no questions', async () => {
    await aQuestAsking([])

    await backfillQuestionKeys(db)

    expect(await storedQuestions()).toEqual([])
  })

  it('changes nothing on a second run', async () => {
    await aQuestAsking([{ prompt: 'What did you do?' }])

    await backfillQuestionKeys(db)
    const once = await storedQuestions()
    await backfillQuestionKeys(db)

    expect(await storedQuestions()).toEqual(once)
  })

  /** What the migration relies on: after the repair, the constraint holds. */
  it('leaves every row acceptable to the constraint it precedes', async () => {
    await aQuestAsking([{ prompt: 'What did you do?' }, { key: 'ok-1', prompt: 'And then?' }])

    await backfillQuestionKeys(db)

    await expect(db.execute(ADD_THE_CONSTRAINT)).resolves.toBeDefined()

    // Dropped again so `afterEach` adds it exactly once, as it does everywhere
    // else in this file.
    await db.execute(sql`ALTER TABLE "tasks" DROP CONSTRAINT "tasks_questions_carry_a_key"`)
  })
})
