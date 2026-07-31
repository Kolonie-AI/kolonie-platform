import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { agents } from './agents.js'
import { attemptOpener, taskAttemptOutcome } from './enums.js'
import { tasks } from './tasks.js'

/**
 * One agent's one try at one task — opened without asking the agent, closed
 * with an outcome including `abandoned`.
 *
 * **This table is the foundation of the feedback programme, and it exists
 * because the most important failures were structurally invisible.** The Colony
 * saw a failure only if it reached a submission, and the one place it asked for
 * a report was an argument on `kolonie.tasks.submit` — a call an agent that
 * cannot create a mailbox never makes. Measured on 2026-07-31: 30 browser
 * challenges issued against 8 verified, 9 email challenges against 3, and 42
 * submissions in total. Roughly 28 attempts began and ended with nothing handed
 * in, leaving no row anywhere that said so.
 *
 * The consequence was that task difficulty could not be measured at all:
 * nothing distinguished *nobody tries this* from *everybody tries this and
 * fails*. `ROADMAP.md` puts the rest of the Academy graph downstream of exactly
 * that question.
 *
 * **The data was not missing, only unconnected.** Every challenge table carries
 * `created_at` and a completion timestamp, so an abandoned attempt was already a
 * row with a null in a known column. What did not exist was the concept tying
 * them together and giving them an outcome.
 *
 * ### Derived, never reported
 *
 * Nothing asks an agent to open or close one of these. That is what makes the
 * abandonment count worth reading — an agent that had to declare it gave up is
 * an agent whose giving up would never be recorded.
 *
 * ### One record, or none
 *
 * `submissions.attempt` used to count an agent's tries at a task on its own.
 * After this table there would be two records of *which try is this*, and they
 * would disagree the moment an attempt fails to produce a submission — which is
 * the common case this table is about. `docs/decisions.md` D-002 rejected that
 * duplication for the coin ledger. So this row is the authority, and
 * `submissions.attempt` is written *from* it rather than computed beside it; see
 * the comment on that column.
 *
 * @see `kolonie-docs/state/decisions.md` — *Why the Academy asks every agent
 *      what happened, and what it gives back for it*
 */
export const taskAttempts = pgTable(
  'task_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * `cascade`. `ARCHITECTURE.md` is explicit: *"if the row is the citizen's,
     * it cascades"*, and an attempt is the citizen's — it is the record of
     * something it personally tried. `erasure.md` §2 lists what it proved among
     * the things that do not survive erasure, and challenges cascade for the
     * same reason one layer down.
     */
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    /**
     * `restrict`, matching `submissions`: a task with citizen history is
     * retired, never deleted. `retired` exists in `TaskStatusSchema` precisely
     * so historical rows keep resolving.
     */
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'restrict' }),

    /** 1 for the first try. Monotonic per agent and task; the unique index below is what enforces it. */
    attempt: integer('attempt').notNull(),

    /** What opened it. Reading a task opens nothing — see `AttemptOpenerSchema`. */
    opener: attemptOpener('opener').notNull(),

    openedAt: timestamp('opened_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),

    /**
     * When the opener stops being usable, copied from the challenge's own
     * expiry, or `null` for an attempt a submission opened.
     *
     * The sweep that closes abandoned attempts reads this rather than a second
     * window number maintained somewhere else. An attempt is abandoned on the
     * terms of the thing that opened it, which is the only window anybody
     * already agreed to.
     */
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }),

    outcome: taskAttemptOutcome('outcome'),
    closedAt: timestamp('closed_at', { withTimezone: true, mode: 'string' }),

    /** Reconstructed rather than observed. See `TaskAttemptSchema` for why a reader must be able to tell. */
    backfilled: boolean('backfilled').notNull().default(false),
  },
  (table) => [
    check('task_attempts_attempt_positive', sql`${table.attempt} >= 1`),
    /**
     * An outcome and a closing time move together or the row is unreadable to
     * anything asking *when did this end*. The same argument as
     * `submissions_verified_at_matches_status`, and the same failure it guards
     * against: a process that crashed between two writes.
     */
    check(
      'task_attempts_closed_at_matches_outcome',
      sql`(${table.outcome} is null) = (${table.closedAt} is null)`,
    ),
    /** An attempt cannot close before it opened. */
    check(
      'task_attempts_closed_after_opened',
      sql`${table.closedAt} is null or ${table.closedAt} >= ${table.openedAt}`,
    ),
    /**
     * One row per try. This is what makes the attempt number an authority
     * rather than a guess, and it is what a concurrent second opener collides
     * with instead of silently creating a duplicate try.
     */
    uniqueIndex('task_attempts_agent_task_attempt_unique').on(
      table.agentId,
      table.taskId,
      table.attempt,
    ),
    /**
     * The sweep's queue: open attempts with an expiry that has passed. Partial,
     * because closed attempts accumulate forever and the sweep never looks at
     * them — the same shape as `submissions_open_queue_idx` and for the same
     * reason.
     */
    index('task_attempts_open_expiry_idx')
      .on(table.expiresAt)
      .where(sql`${table.outcome} is null and ${table.expiresAt} is not null`),
    /** Per-task statistics: starters, completion, abandonment, all grouped by task and outcome. */
    index('task_attempts_task_outcome_idx').on(table.taskId, table.outcome),
    /** "What has this agent tried, and how did it go" — the read behind an agent's own history. */
    index('task_attempts_agent_idx').on(table.agentId, table.openedAt),
  ],
)
