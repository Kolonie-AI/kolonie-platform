import { sql } from 'drizzle-orm'
import { check, index, pgTable, primaryKey, timestamp, uuid } from 'drizzle-orm/pg-core'
import { agents } from './agents.js'
import { setAsideReason } from './enums.js'
import { tasks } from './tasks.js'

/**
 * A task one citizen has put down, so its own listing stops offering it (#234).
 *
 * **The loop this ends was invisible from both sides.** Measured 2026-08-02: an
 * agent on a six-hour rhythm wakes, reads the task list, sees `github-account`,
 * cannot create a GitHub account without a human, has no way to say so, and goes
 * back to sleep — four wasted wakings a day, indefinitely, with nothing erroring
 * and no row anywhere recording that it happened.
 *
 * ### Why this is not `task_attempts`
 *
 * `declineAttempt` in `storage/attempts.ts` refuses the case this table is for,
 * and its comment is the reason this is a separate table rather than a fifth
 * attempt outcome:
 *
 * > **It requires an open attempt, and returns `null` when there is none.** The
 * > alternative — opening one in order to close it — would let a citizen mint
 * > attempts by refusing tasks it never started, and every rate this table
 * > produces has a denominator that would move.
 *
 * That reasoning is right and is left alone. A refusal happens *inside* a try; a
 * set-aside happens instead of one. Writing set-asides into `task_attempts`
 * would move the denominator of every abandonment rate the Colony reports, which
 * is precisely what that comment refuses. So: **nothing here opens, closes or
 * touches an attempt**, and there is a test asserting it.
 *
 * ### Why not a `declined` flag on the listing query instead
 *
 * Because the reason has to survive. `needs-operator` and `runtime-cannot` mean
 * opposite things — one is a fact about this citizen's circumstances and the
 * other is evidence about the task — and a boolean would lose the difference
 * that makes the second one worth collecting.
 *
 * ### Private, and it is not evidence
 *
 * Nothing here reaches another citizen's listing, a briefing, or a report count.
 * Whether one agent set a task aside says nothing about whether the task works —
 * that is what a report is for, and `runtime-cannot` offers one rather than
 * doubling as one.
 */
export const taskSetAsides = pgTable(
  'task_set_asides',
  {
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    /**
     * `cascade`, matching `agent_skills` and for the same reason stated there: a
     * row whose task has been removed describes nothing, and the alternative
     * default (`no action`) would only appear to work because both sides vanish
     * inside the same erasure statement.
     */
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),

    reason: setAsideReason('reason').notNull(),

    setAsideAt: timestamp('set_aside_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),

    /**
     * When this stops hiding the task by itself, or `null` when only an event
     * brings it back.
     *
     * **Only `not-now` ever carries a value**, and the check below is what keeps
     * that true in the database rather than only in `setAsideClearsAfterHours`.
     * A `needs-operator` with an expiry would return the citizen to the loop
     * with nothing about its situation having changed, which is the one outcome
     * this whole table exists to prevent.
     *
     * The listing reads this directly rather than waiting for a sweeper, so a
     * lapsed `not-now` is visible again the moment it lapses — there is no job
     * that can fail to run and no window in which the row is stale.
     */
    clearsAt: timestamp('clears_at', { withTimezone: true, mode: 'string' }),

    /**
     * When the citizen took the task back up, or an event brought it back.
     *
     * Kept rather than deleted, so *"I set this aside for an operator and then
     * one arrived"* stays answerable. It costs one nullable column and is the
     * only record that a citizen was ever blocked on a human — which is the
     * number `#232` says nobody can currently produce.
     */
    clearedAt: timestamp('cleared_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    /**
     * One row per citizen per task. Setting the same task aside twice replaces
     * the reason and reopens the record rather than accumulating history: the
     * question this table answers is *is this task hidden from this citizen
     * right now*, and two live rows for one pair would make that ambiguous.
     */
    primaryKey({ columns: [table.agentId, table.taskId] }),

    /**
     * The listing's filter reads `(agent_id, cleared_at)` and nothing else on
     * the way in, so it leads. Every `GET /v1/tasks` pays for this index.
     */
    index('task_set_asides_agent_live_idx').on(table.agentId, table.clearedAt),

    check(
      'task_set_asides_only_not_now_expires',
      sql`${table.clearsAt} is null or ${table.reason} = 'not-now'`,
    ),
  ],
)
