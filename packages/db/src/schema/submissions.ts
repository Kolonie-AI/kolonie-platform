import { sql } from 'drizzle-orm'
import {
  boolean,
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
import { taskAttempts } from './attempts.js'
import { agentSessions } from './sessions.js'
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

    /**
     * The attempt this submission belongs to.
     *
     * Nullable only because the rows written before `task_attempts` existed
     * cannot all be attached honestly — the backfill attaches what it can
     * reconstruct and leaves the rest alone rather than inventing a row. A
     * fabricated attempt is worse than a missing one, because it will be
     * counted. Every submission written after this column exists carries one.
     *
     * `cascade`: the attempt is the citizen's and so is the submission, and they
     * disappear together when the citizen does.
     */
    attemptId: uuid('attempt_id').references(() => taskAttempts.id, { onDelete: 'cascade' }),

    /**
     * 1 for the first try. Agents may retry failed tasks; passes are final.
     *
     * **Kept, but no longer computed here — it is written from
     * `task_attempts.attempt`.** #108 required this column to be derived or
     * removed, and specifically forbade leaving it as an independently
     * maintained counter: the two would disagree the moment an attempt failed to
     * produce a submission, which is the common case the attempt row exists for.
     * D-002 rejected the same duplication for the credit ledger.
     *
     * Derived rather than dropped because dropping it changes the shape of
     * `GET /v1/agents/me/submissions` and of every stored verdict an agent has
     * already read, to remove a number that is still the right number — one
     * join away from its authority instead of zero. The attempt row decides it;
     * this is a copy stamped at insert, and `submissions_attempt_matches_row`
     * in the storage tests is what asserts the copy never drifts.
     */
    attempt: integer('attempt').notNull().default(1),

    /**
     * Which run this submission was handed in from, if the citizen had named one
     * (#158).
     *
     * Nullable, `set null` on the session going away, and read by nothing that
     * decides anything — the same terms as `task_attempts.session_id`, and the
     * reason is the same: it is what makes *did these two things happen in the
     * same run* answerable, and a self-declared fact must never be able to
     * change a verdict.
     */
    sessionId: uuid('session_id').references(() => agentSessions.id, { onDelete: 'set null' }),

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

    /**
     * Whether this attempt exists only because a tester reset its own completion
     * record (#47).
     *
     * **A test pass books nothing** — no ledger entry, no reputation event — and this
     * is the column that says so. `kolonie-docs#17` decided it: *"A test pass books
     * nothing. No ledger entry, no reputation, no excluded shadow account."* The
     * rejected alternative was booking into an account filtered out of every
     * balance, which buys nothing and adds a filter every future query has to
     * remember.
     *
     * **Stamped on the row at creation rather than derived at booking time.** The
     * derivation — *is there a reset for this pair later than the previous pass* — is
     * answerable, and it is answerable *differently* after the next reset lands. A
     * booking decision that can change retroactively is one an audit cannot check,
     * so the row records what it was when it was made. `#39`'s `assistance` column
     * is on the row for the same reason.
     *
     * It also keeps the Academy's metrics honest: `unattendedPasses` counts real
     * climbs, and a tester re-running `email-roundtrip` twenty times must not read
     * as twenty agents clearing it.
     *
     * Defaults to false, which is correct for every row written before this column
     * existed: no reset could have existed either.
     */
    testRerun: boolean('test_rerun').notNull().default(false),

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
