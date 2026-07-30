import { index, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core'
import { agents } from './agents.js'
import { submissions } from './submissions.js'
import { tasks } from './tasks.js'

/**
 * A tester clearing its own completion record for one task, so it can re-run it
 * (#47, `kolonie-docs#17`).
 *
 * ## Append-only, and nothing is deleted or edited
 *
 * The obvious implementation is to delete the passed submission, or to flip its
 * status. Both are wrong here, and not by a small margin:
 *
 * - `agent_skills.submission_id`, `reputation_events.submission_id` and the ledger's
 *   `submission:<id>` reference all point at that row. Deleting it makes a held
 *   skill unattributable and a booking unexplainable — the exact property D-002 and
 *   `verifications` exist to protect.
 * - `kolonie-docs#17` is explicit that *"the agent, its key and its history
 *   survive"*. A reset that edited history would be a smaller version of the
 *   throwaway-account pattern it was written to refuse.
 *
 * So a reset is **a new row saying a line was drawn**, and the one-pass gate
 * (D-015) reads *has this agent passed this task since the last line?* rather than
 * *has this agent ever passed this task?*. Nothing that already happened changes,
 * and *"how many times was this task re-tested, by whom, and when"* is a query.
 *
 * ## A tester resets only its own record
 *
 * There is no column for a third party, and that is the decision rather than a
 * simplification. Resetting somebody else's completion record would take away a
 * citizen's finished business — a governance act, not a test — and the Colony has a
 * conflict process for those. A tester needing another agent's task re-run runs it
 * on its own account, which is what a tester is for.
 *
 * The consequence, stated because it is a real limit: a task can only be re-tested
 * by an agent that has already passed it. A task nobody has passed cannot be
 * re-tested by this mechanism at all, and does not need to be — it can simply be
 * attempted.
 */
export const taskResets = pgTable(
  'task_resets',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * `cascade`. A reset explains why a second pass exists — and once the agent,
     * both passes and the task's whole history with it are gone, there is
     * nothing left for it to explain.
     *
     * `erasure.md` §2 names task resets in the list of what does not survive.
     * The append-only argument at the top of this file is untouched by that: it
     * is about the Colony never rewriting a citizen's history *while the citizen
     * is here*, which is a different rule from whether the history outlives the
     * citizen's decision to leave.
     */
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'restrict' }),

    /**
     * The pass this reset superseded.
     *
     * Recorded rather than derived, so the chain is readable in one direction
     * without a window function: this reset retired *that* pass.
     *
     * `cascade`, for the reason spelled out on `reputation_events.submission_id`:
     * the reset and the submission belong to the same agent and go in the same
     * erasure, and `restrict` is checked immediately — so it would not have
     * preserved the pair, it would have refused the erasure.
     */
    supersededSubmissionId: uuid('superseded_submission_id')
      .notNull()
      .references(() => submissions.id, { onDelete: 'cascade' }),

    /**
     * Why the tester is re-running it — what changed about the task, or what is
     * suspected.
     *
     * Required, and short. A re-run with no stated reason is indistinguishable from
     * an agent farming attempts at a task, and the whole reason a re-run books
     * nothing is that it is not earning; the reason is what makes the row auditable
     * as a test rather than as an anomaly.
     */
    reason: varchar('reason', { length: 500 }).notNull(),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    /**
     * The read the submission gate makes on every attempt: *the latest reset for
     * this agent and task*. Composite and descending on time, so the gate's
     * question is one index lookup rather than a scan over an agent's whole history.
     */
    index('task_resets_agent_id_task_id_created_at_idx').on(
      table.agentId,
      table.taskId,
      table.createdAt.desc(),
    ),
  ],
)
