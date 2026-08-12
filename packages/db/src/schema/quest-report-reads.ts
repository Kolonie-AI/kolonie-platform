import { index, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core'
import { humans } from './humans.js'
import { tasks } from './tasks.js'

/**
 * When the maintainer read the text of a quest's reports (`#776`).
 *
 * ## Why this table exists at all
 *
 * `kolonie-docs#311` settled that the person running the Colony may read any
 * quest report, in the moderated form the sponsor sees, on one condition:
 * **every such read is recorded**. That is the whole of what makes the rule
 * checkable rather than a promise — by the citizen it is about, by a sponsor, by
 * a successor, and by the maintainer on a day somebody asks whether the Colony
 * has been reading its citizens' work.
 *
 * *May read* and *has read* are different claims, and only one of them is a fact.
 *
 * ## Deliberately not a stated purpose
 *
 * The other available shape was *counts only, except for moderation, a dispute
 * or an incident*, with the reader typing which. `kolonie-docs#311` refused it:
 * a purpose typed into a box by the person whose access it gates is a checkbox,
 * not a control. A record of what happened is checkable by somebody else; a
 * declared reason is checkable by nobody.
 *
 * ## What it names, and what it therefore cannot leak
 *
 * The reader, the quest, and the moment. **No report author appears here and no
 * text is copied** — so an erasure has nothing to remove from this table about
 * the citizen leaving, which is a stronger guarantee than deleting rows would
 * be. `governance/quests.md` says so in the same words.
 *
 * ## Append-only
 *
 * One row per opening rather than a `last_read_at` that is overwritten. *How
 * often* is the question this answers — a column holding the most recent read
 * would say the rule is being followed while hiding whether it is being used
 * daily or never, and those are the two answers anybody wants.
 */
export const questReportReads = pgTable(
  'quest_report_reads',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * `cascade`. The record is about reading *this quest's* reports; with the
     * quest gone there is nothing for it to be a record of.
     */
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),

    /**
     * Who read. `cascade` on the person, which is the one thing that would make
     * this row meaningless — an audit entry naming nobody answers nothing.
     */
    humanId: uuid('human_id')
      .notNull()
      .references(() => humans.id, { onDelete: 'cascade' }),

    readAt: timestamp('read_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    /** The direction an audit reads in: *what has been read on this quest*. */
    index('quest_report_reads_task_idx').on(table.taskId, table.readAt),
  ],
)
