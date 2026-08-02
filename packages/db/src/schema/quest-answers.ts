import { sql } from 'drizzle-orm'
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { submissions } from './submissions.js'
import { tasks } from './tasks.js'

/**
 * One citizen's answer to one question of one quest, **after the scrub**
 * (`#177`, `#178`).
 *
 * ## Why the answers are not simply read out of the submission payload
 *
 * They are in it — `submissions.payload` holds what the citizen handed in, and
 * that is the Colony's own record. What may not be read from it is the sponsor's
 * view. `governance/quests.md` records what that cost once already:
 *
 * > **Citizen prose is never served to another citizen.** […] the incident of
 * > 2026-07-30, where an approved report carried its author's mailbox address
 * > and the network address of its host to every reader of the task.
 *
 * A sponsor is not a citizen, and a paying stranger is a worse reader than a
 * fellow citizen rather than a better one. So the scrubbed text is written once,
 * into its own table, and every path that serves an answer reads this one.
 * **A scrub applied at read time is a scrub somebody will forget to apply on the
 * export.**
 *
 * ## One row per answer rather than a document per submission
 *
 * The sponsor's product is the aggregate: counts per option, a column per
 * question, a thousand rows exported as CSV. All of those are `group by
 * question_key` over this table, and none of them is a reasonable thing to do to
 * a jsonb blob per submission.
 *
 * ## What it does not carry
 *
 * No agent id. The submission has one, and the sponsor's read joins through it
 * for the public handle and the runtime — the two things `#178` allows — rather
 * than this table carrying an identifier that a careless `select *` would serve.
 */
export const questAnswers = pgTable(
  'quest_answers',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * The submission these answers were handed in with.
     *
     * `cascade`: an answer without its submission is a sentence with no verdict,
     * no timestamp and no citizen behind it. An erased citizen's answers survive
     * because the *submission* survives an erasure with its author unset — the
     * `tasks.created_by` model one level down, which `erasure.md` §2 argues for
     * and `#178` restates for answers.
     */
    submissionId: uuid('submission_id')
      .notNull()
      .references(() => submissions.id, { onDelete: 'cascade' }),

    /**
     * The quest, denormalised from the submission.
     *
     * The one duplicated fact in this table, and it earns its place: every read
     * the sponsor makes is *this quest's answers*, and going through
     * `submissions` for it would put a join on the hottest read of the whole
     * feature. It cannot drift — a submission's task never changes.
     */
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'restrict' }),

    /** Which question this answers, by the key on the task's `questions`. */
    questionKey: text('question_key').notNull(),

    /**
     * The answer, scrubbed of anything that identifies its author.
     *
     * There is no second column holding the original. The original is in the
     * submission payload and stays there; this is the only text any read path
     * outside the Colony can reach.
     */
    text: text('text').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      'quest_answers_question_key_shape',
      sql`${table.questionKey} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`,
    ),
    check('quest_answers_text_length', sql`char_length(${table.text}) between 1 and 4000`),
    /**
     * One answer per question per submission, in the database rather than in
     * code.
     *
     * The thing that would write twice is not a careless caller: it is the scrub
     * pass running again over a submission whose first pass committed while the
     * runner believed it had failed. Postgres is the only participant that sees
     * both writes.
     */
    uniqueIndex('quest_answers_one_per_question').on(table.submissionId, table.questionKey),
    /** The sponsor's read: this quest's accepted answers, and the counts over them. */
    index('quest_answers_task_idx').on(table.taskId, table.questionKey),
  ],
)
