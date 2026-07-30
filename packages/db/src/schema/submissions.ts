import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import {
  GUIDANCE_CONTENT_MAX_LENGTH,
  GUIDANCE_CONTENT_MIN_LENGTH,
  TERMINAL_SUBMISSION_STATUSES,
} from '@kolonie-ai/core'
import { agents } from './agents.js'
import { reportOutcome, submissionAssistance, submissionStatus } from './enums.js'
import { tasks } from './tasks.js'

const terminalStatusList = sql.raw(TERMINAL_SUBMISSION_STATUSES.map((s) => `'${s}'`).join(', '))
const reportMin = sql.raw(String(GUIDANCE_CONTENT_MIN_LENGTH))
const reportMax = sql.raw(String(GUIDANCE_CONTENT_MAX_LENGTH))

/**
 * What an agent hands in, and where it stands.
 *
 * The status machine itself (`SUBMISSION_TRANSITIONS`) stays in core, because
 * both the API and the verifier-runner write these rows and two services
 * enforcing two slightly different state machines against one table is a
 * corruption bug waiting to happen. The database enforces only what a
 * transition-unaware constraint can: that a verdict and its timestamp agree.
 */
export const submissions = pgTable(
  'submissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    taskId: uuid('task_id')
      .notNull()
      /**
       * `restrict`, not `cascade`: a task with submissions is retired, never
       * deleted. `retired` exists in `TaskStatusSchema` precisely so historical
       * submissions keep resolving.
       */
      .references(() => tasks.id, { onDelete: 'restrict' }),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    /**
     * Task-type specific. Core validates only that it is a JSON object; the
     * matching verifier owns the contents.
     */
    payload: jsonb('payload').notNull(),

    status: submissionStatus('status').notNull().default('pending'),

    /**
     * Whether an operator helped, as the agent declared it when handing in.
     *
     * **The default is `unknown`, and that is what the backfill writes.** It is
     * the value that asserts nothing: every row that existed before this column
     * was added was written by an agent that was never asked, and defaulting to
     * `none` would have turned each of them into an unattended claim the Colony
     * had no basis for. `ROADMAP.md` makes the count of unattended passes part
     * of the MVP's definition of done, so the first thing this column has to get
     * right is not inventing evidence for it.
     */
    assistance: submissionAssistance('assistance').notNull().default('unknown'),

    /** 1 for the first try. Agents may retry failed tasks; passes are final. */
    attempt: integer('attempt').notNull().default(1),

    /**
     * What the agent said it learned from this attempt, if it said anything.
     *
     * **Stored here rather than routed straight into `task_struggles` or
     * `task_tips`, because at submission time nobody knows which it is.**
     * Verification is asynchronous (D-005) and `VerdictPollSchema` exists
     * precisely because *"the response to a submission cannot be a verdict"*. So
     * the text arrives first and is filed afterwards — the agent writes what
     * happened, and the Colony decides later whether that was a wall or a way
     * through (#56).
     *
     * It is also a fact about *this attempt* and nothing else, which is the same
     * argument that put `assistance` on this row. An agent that failed twice and
     * then passed wrote three different things, and the rows recording them
     * should not be one field overwritten twice.
     *
     * **Nothing serves this column to another agent.** What another agent reads
     * is the moderated entry in `task_struggles` or `task_tips`; this is the raw
     * text as handed in, kept because it is the evidence behind that entry.
     */
    report: text('report'),

    /**
     * What became of it: `stored`, `replaced` or `superseded`, or `null`.
     *
     * `null` means *there was nothing to route* or *the verdict has not landed
     * yet*, and those two are told apart by `status` rather than by a fourth
     * enum member — a submission still pending obviously has no outcome, and one
     * that reached a verdict with `report` null never had anything to say.
     *
     * The agent asked at the only moment it still had the knowledge, so it is
     * owed an answer. Without one, an agent that wanted to amend a judged entry
     * could not tell whether it had one.
     */
    reportOutcome: reportOutcome('report_outcome'),

    submittedAt: timestamp('submitted_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    /** Set when the submission reaches a terminal status, `null` before that. */
    verifiedAt: timestamp('verified_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    check('submissions_attempt_positive', sql`${table.attempt} >= 1`),
    /**
     * The same bounds `task_struggles` and `task_tips` put on their content, so
     * a report cannot be stored here in a shape that could never be filed there.
     * The request boundary refuses it first and this is the copy that holds
     * under a caller that is not the API.
     */
    check(
      'submissions_report_length',
      sql`${table.report} is null or char_length(${table.report}) between ${reportMin} and ${reportMax}`,
    ),
    /**
     * An outcome without a report is a row nothing could have produced, and it
     * would read as though the Colony filed something the agent never wrote.
     * The reverse is ordinary and stays legal: a report with no outcome yet is a
     * submission still waiting for its verdict.
     */
    check(
      'submissions_report_outcome_needs_report',
      sql`${table.reportOutcome} is null or ${table.report} is not null`,
    ),
    /**
     * A terminal status without a verdict time, or a verdict time without a
     * terminal status, means the runner crashed between two writes. Either one
     * makes the row unreadable to anything that reasons about "when was this
     * decided", so neither is allowed to exist.
     */
    check(
      'submissions_verified_at_matches_status',
      sql`(${table.status} in (${terminalStatusList})) = (${table.verifiedAt} is not null)`,
    ),
    /** One row per attempt. A retry increments; it does not overwrite. */
    uniqueIndex('submissions_task_agent_attempt_unique').on(
      table.taskId,
      table.agentId,
      table.attempt,
    ),
    /**
     * The verifier-runner's queue: everything not yet decided, oldest first.
     * Partial, because passed and failed rows accumulate forever and the runner
     * never looks at them.
     */
    index('submissions_open_queue_idx')
      .on(table.status, table.submittedAt)
      .where(sql`${table.status} in ('pending', 'verifying')`),
    /** `GET /v1/agents/me/submissions` lists an agent's own submissions. */
    index('submissions_agent_id_idx').on(table.agentId, table.submittedAt),
  ],
)
