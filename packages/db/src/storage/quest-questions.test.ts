import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { TaskId } from '@kolonie-ai/core'
import { type Database } from '../client.js'
import { tasks } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { readTask } from './tasks.js'

const target = databaseTestTarget()

/**
 * What a quest row has to carry before anything may read it (`#542`).
 *
 * On 2026-08-07 one live quest held two questions with a `prompt`, a `required`
 * and no `key`. `TaskSchema` refuses that row on the way out of `toTask`, so
 * `kolonie.tasks.list`, `kolonie.tasks.get`, `kolonie.quests.list`,
 * `kolonie.quests.read` and the console's agent page all answered `internal` — to
 * every citizen, not only to the quest's author — and none of them said which
 * row. It took `#526`, `#538`, `#542`, `#555` and a finding inside `#537` before
 * the id came out, and it came out of reading the table by hand.
 *
 * Nothing in the application could write it: `QuestQuestionSchema` has required
 * `key` since `#177` and both write paths parse through it. That leaves a
 * hand-written statement, which is why the rule is on the row here rather than
 * restated in a third schema that the same statement would also walk past.
 */
describe('a quest question carries its key', () => {
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

  const aQuest = async (questions: unknown): Promise<TaskId> => {
    const [row] = await db
      .insert(tasks)
      .values({
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
      .returning({ id: tasks.id })
    if (row === undefined) throw new Error('inserting a quest returned no row')
    return row.id as TaskId
  }

  /**
   * Which constraint refused the insert.
   *
   * **Read off `constraint_name` down the cause chain, not out of the message**,
   * for the reason `account-proofs.test.ts` gives where this helper was first
   * written: Drizzle wraps the driver's error in its own *"Failed query: …"*, so
   * asserting on the message would pass against a database carrying none of these
   * rules.
   */
  const refusedBy = async (questions: unknown): Promise<string | undefined> => {
    try {
      await aQuest(questions)
    } catch (error: unknown) {
      for (let current: unknown = error; current != null;) {
        if (typeof current === 'object' && 'constraint_name' in current) {
          return (current as { constraint_name?: string }).constraint_name
        }
        current =
          typeof current === 'object' && current !== null && 'cause' in current
            ? (current as { cause?: unknown }).cause
            : null
      }

      return 'refused by something that named no constraint'
    }

    return undefined
  }

  it('accepts a question that names its key', async () => {
    const id = await aQuest([{ key: 'went-well', prompt: 'How did it go?', required: true }])

    const task = await readTask(db, { taskId: id })

    expect(task?.questions.map((question) => question.key)).toEqual(['went-well'])
  })

  /** Every Academy rung, and the reason the constraint is not simply `> 0`. */
  it('accepts a task that asks nothing', async () => {
    const id = await aQuest([])

    expect((await readTask(db, { taskId: id }))?.questions).toEqual([])
  })

  /** The row that actually happened. */
  it('refuses a question with no key at all', async () => {
    expect(
      await refusedBy([
        { prompt: 'What did you do to pay the invoice?', required: true },
        { prompt: 'What was unclear before you paid?', required: true },
      ]),
    ).toBe('tasks_questions_carry_a_key')
  })

  /**
   * Four more shapes `like_regex` has to fail, because a key that is present and
   * unusable costs what an absent one does: an answer submitted against it names
   * something `quest_answers` and the sponsor's export have no column for.
   */
  it.each([
    ['an empty key', ''],
    ['a key that is not a slug', 'Went_Well'],
    ['a key with a trailing dash', 'went-'],
    ['a key that is not a string', 7],
  ])('refuses %s', async (_name, key) => {
    expect(await refusedBy([{ key, prompt: 'How did it go?', required: true }])).toBe(
      'tasks_questions_carry_a_key',
    )
  })

  it('refuses a list where only the second question forgot', async () => {
    expect(
      await refusedBy([
        { key: 'went-well', prompt: 'How did it go?', required: true },
        { prompt: 'What was unclear?', required: true },
      ]),
    ).toBe('tasks_questions_carry_a_key')
  })

  /**
   * The constraint closes one class of unreadable row; this is the rest of the
   * defence. Whatever the next class turns out to be, the reader is told which
   * row it was rather than which field path.
   *
   * `prompt` is the field used here because the constraint deliberately does not
   * reach it — the row goes in, `TaskSchema` refuses it on the way out, and the
   * question is whether the failure says anything a maintainer can act on.
   */
  it('names the row it cannot serve', async () => {
    const id = await aQuest([{ key: 'went-well', prompt: 'no', required: true }])

    await expect(readTask(db, { taskId: id })).rejects.toThrow(
      new RegExp(`task ${id} cannot be served:.*questions\\.0\\.prompt`),
    )
  })
})
