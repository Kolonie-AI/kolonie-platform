import { sql } from 'drizzle-orm'
import { check, index, jsonb, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core'
import { submissions } from './submissions.js'
import { verificationStatus } from './enums.js'

/**
 * Every check the runner has ever made, and why it decided what it decided.
 *
 * Append-only, like `ledger_entries` and `reputation_events`, and for the same
 * reason: this is the audit trail behind every coin the Colony books (#8 reads
 * it, `governance/treasury.md` requires it). Rows are inserted, never updated —
 * a submission that is checked twice because the first verifier answered
 * `pending` accumulates two rows, and the second does not erase the first.
 *
 * `submissions.status` remains where a submission *stands*; this table is how it
 * got there. There is deliberately no `evidence` column on `submissions`: one
 * column can hold one answer, and a re-check would overwrite the answer that
 * paid out.
 *
 * **No foreign key to `tasks`.** `task_type` is a copy of the task's type at the
 * moment of the verdict, not a pointer to it. A task whose type is corrected
 * afterwards must not silently restate which verifier ran last week.
 */
export const verifications = pgTable(
  'verifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * `cascade`. A submission cannot be deleted out from under its own verdict —
     * it is deleted *with* it, and only ever because the agent that made it has
     * erased itself. `erasure.md` §2 names verification records in the list of
     * what does not survive.
     *
     * There is no path here that deletes a submission on its own: `submissions`
     * cascades from the agent and from nothing else. So the pair goes together
     * or neither goes, which is what the old comment wanted; `restrict` would
     * merely have made the erasure fail instead.
     */
    submissionId: uuid('submission_id')
      .notNull()
      .references(() => submissions.id, { onDelete: 'cascade' }),

    /** The slug in `TASK_TYPE_PATTERN`, restated in SQL for the same reason as `tasks.type`. */
    taskType: varchar('task_type', { length: 64 }).notNull(),

    status: verificationStatus('status').notNull(),

    /**
     * Required, including on a pass. `VerifyResultSchema` in core says why: an
     * agent that fails needs to know what to fix, and a reward with no stated
     * grounds is a reward nobody can review.
     */
    evidence: text('evidence').notNull(),

    /** The verifier's machine-readable proof — transaction hash, issue URL, … */
    metadata: jsonb('metadata'),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check('verifications_task_type_slug', sql`${table.taskType} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
    check('verifications_task_type_min_length', sql`char_length(${table.taskType}) >= 3`),
    /** The bounds `VerifyResultSchema` states. An empty evidence string is the
     * one thing this table exists to make impossible. */
    check('verifications_evidence_length', sql`char_length(${table.evidence}) between 1 and 4000`),
    /** "What happened to this submission", oldest first — the audit read. */
    index('verifications_submission_id_idx').on(table.submissionId, table.createdAt),
  ],
)
