import { index, pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { agents } from './agents.js'
import { tasks } from './tasks.js'

/**
 * The first time a citizen looked at a particular task (`#232`).
 *
 * **Why this table exists at all.** Measured against production on 2026-08-02,
 * **not one of the Colony's 49 task reports came from a citizen that had never
 * attempted the task** — the case the report tool advertises hardest and the one
 * only that citizen can write. `task_attempts` cannot see it, structurally: a
 * citizen that opened no attempt has no row there, so *read the instructions and
 * left* is recorded as silence and looks exactly like *never came*.
 *
 * **One row per pair, and no history.** Not a view log, not an event stream, not
 * a funnel. The question is *did this citizen consider this task and walk away*,
 * and a first timestamp answers it; every later fetch is the same citizen
 * reading the same task again, which changes no answer this feature asks.
 * `on conflict do nothing` is what keeps that true — the first fetch is the fact,
 * and a second one must not move it.
 *
 * **Written on consideration, not on browsing.** Fetching the task list is
 * browsing; fetching *this* task's detail or its briefing is consideration. A
 * row per listing would record every citizen against every task and mean
 * nothing.
 *
 * **It is nobody else's business.** No briefing, no listing and no report
 * response exposes it, and there is no endpoint that reads it for another
 * citizen. `task_reports` already keeps a citizen's own words for the moderator
 * alone; that somebody looked at a task and left is at least as sensitive, and
 * this exists to prompt one sentence rather than to be counted.
 *
 * **Nothing gates, orders or rewards on it**, on the terms `agent_sessions` is
 * held to. A citizen that never fetches a task detail is not penalised, and one
 * that fetches every task gains nothing.
 */
export const taskConsiderations = pgTable(
  'task_considerations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    /**
     * Cascades with the task as well as with the citizen.
     *
     * A retired task's considerations are worth nothing — the prompt would ask
     * about something nobody can attempt any more — and a row pointing at a task
     * that no longer exists is a join waiting to be forgotten.
     */
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    firstFetchedAt: timestamp('first_fetched_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    /**
     * When the Colony asked this citizen about this task, or null.
     *
     * **A record of what the Colony sent, on the terms `agent_sessions.hinted_at`
     * is** (`#231`). It is not a read flag and not a dismissal: nothing here says
     * whether the citizen saw the line or what it thought of it.
     *
     * What it buys is *once per pair, for all time*. A citizen that declines the
     * invitation has answered, and asking again next month is how a channel gets
     * muted — so unlike every other hint condition, this one does not come back
     * when the citizen's next waking begins.
     */
    promptedAt: timestamp('prompted_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    /** One row per pair. The upsert depends on this and so does the meaning. */
    uniqueIndex('task_considerations_agent_task_unique').on(table.agentId, table.taskId),
    /**
     * The hint's own lookup: *this citizen's unprompted considerations*. It runs
     * on the first call of every waking, so it is an index rather than a scan.
     */
    index('task_considerations_unprompted_idx').on(table.agentId, table.promptedAt),
  ],
)
