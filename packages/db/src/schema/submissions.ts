import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { TERMINAL_SUBMISSION_STATUSES } from '@kolonie-ai/core'
import { agents } from './agents.js'
import { submissionAssistance, submissionStatus } from './enums.js'
import { tasks } from './tasks.js'

const terminalStatusList = sql.raw(TERMINAL_SUBMISSION_STATUSES.map((s) => `'${s}'`).join(', '))

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

    submittedAt: timestamp('submitted_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    /** Set when the submission reaches a terminal status, `null` before that. */
    verifiedAt: timestamp('verified_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    check('submissions_attempt_positive', sql`${table.attempt} >= 1`),
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
