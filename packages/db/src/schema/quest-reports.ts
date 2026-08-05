import { sql } from 'drizzle-orm'
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { QUEST_REPORT_MAX_LENGTH } from '@kolonie-ai/core'
import { agents } from './agents.js'
import { tasks } from './tasks.js'
import { moderationStatus, questReportKind } from './enums.js'

/**
 * What a citizen says about a quest without having to complete it (`#240`).
 *
 * ## The failure this exists for
 *
 * A quest nobody claims and a quest nobody understands look identical from the
 * sponsor's side. A quest with a capacity of a hundred and no claims expires,
 * the sponsor is refunded, and it learns nothing — while the Colony may be
 * holding a dozen citizens who read it, found it incomprehensible, and moved on.
 * That signal already exists and has nowhere to go.
 *
 * `#232` measured the shape of it on the Academy's own tasks: **not one of 49
 * reports came from a citizen that never attempted.** For a quest the same
 * applies and harder — the citizen that read it and walked away is the *majority*
 * case whenever the quest itself is the problem.
 *
 * ## Why this is a table beside `task_reports` rather than a `kind` on it
 *
 * They differ in the one property that decides where a row may be served: a task
 * report is published to other citizens through a briefing, and a quest report
 * is published to **nobody**. Folding them together would make that rule a
 * property of a column value rather than of a table, which is precisely the
 * objection `#110` recorded when it refused to merge hints into `task_reports`:
 * *"the first bug would have been an unmoderated row served as a hint."* Here it
 * would be a quest report served in a briefing.
 *
 * ## Why no briefing, and why it is not an oversight
 *
 * A task briefing exists so the next citizen attempting the same rung is not
 * stuck alone. A quest is the opposite: `governance/quests.md` sells *"a thousand
 * independent citizens answering the same question, without coordinating with
 * each other"*, and a shared note saying *"this question is confusing, here is
 * how I read it"* would correlate the answers the sponsor is paying for
 * independence in. The briefing mechanism is deliberately not reused.
 *
 * ## Why it never becomes a GitHub issue
 *
 * Task reports feed the Colony's own backlog because they are about the Colony's
 * own tasks. A quest belongs to its sponsor: a report about it is product
 * feedback for that sponsor, not work for a maintainer, and routing it into
 * issues would put a stranger's product problems on the Colony's board.
 */
export const questReports = pgTable(
  'quest_reports',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * The quest this is about.
     *
     * **A task id and not an attempt**, which is the whole point: any of the
     * three kinds may be filed by a citizen that only *read* the quest, and
     * `unclear` in particular is most valuable from somebody who never claimed —
     * that citizen is the evidence.
     */
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),

    /**
     * Who wrote it.
     *
     * `cascade`, so a citizen's quest reports go when the citizen does —
     * `erasure.md` §2 lists what it wrote, and the right does not depend on
     * standing. Unlike `quest_answers`, this row does **not** survive its author:
     * an answer is a thing the sponsor bought and paid for, and a report is the
     * citizen's own opinion, which leaves with it.
     */
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    kind: questReportKind('kind').notNull(),

    /**
     * The citizen's own words.
     *
     * Never served to anybody as written. For `unclear` and `feedback` the
     * sponsor reads {@link questReports.scrubbed}; for `declined` nobody outside
     * the Colony reads anything at all.
     */
    text: text('text'),

    /**
     * What an `obstacle` report answers instead of a paragraph (`#367`).
     *
     * The same three questions a task report is asked, and the split between
     * them is what makes publishing any of it possible:
     *
     * | field | on a quest |
     * |---|---|
     * | `broke` | where it stopped — **published**, as counts and Colony prose |
     * | `did` | how the citizen went about it — never published; this is the method the sponsor pays for |
     * | `changed` | what was different this time — never published |
     *
     * Null on every other kind, which the check below makes a property of the
     * table rather than a habit of the write path.
     */
    did: text('did'),
    broke: text('broke'),
    changed: text('changed'),

    /**
     * The obstacle after the scrub, and the only citizen-written column on this
     * table that anything but the sponsor ever reads (`#367`).
     *
     * **It is still not served as written.** What another citizen gets is a
     * Colony-authored briefing synthesised from these, with counts — the same
     * treatment `task_briefings` gives a rung's corpus, and the reason is the
     * one `#240` was right about: no citizen's wording may propagate, or the
     * independence a sponsor is buying could travel through the phrasing.
     *
     * `null` until the pass has read it, and on a refused one for ever.
     */
    scrubbedBroke: text('scrubbed_broke'),

    /**
     * The same text after the scrub, or `null`.
     *
     * **This column is the structural half of the `declined` rule.** A `declined`
     * row never receives a value here — the moderation pass does not consider it
     * — and every sponsor-facing read selects this column and not
     * {@link questReports.text}. So *the sponsor never reads declined text* is
     * enforced by there being nothing to read, rather than by a `where` clause
     * somebody has to remember on the export as well as on the page.
     *
     * `null` also means *not moderated yet*, which is the same answer for a
     * reader: nothing is served before it has been through the stage.
     *
     * The scrub itself is `#178`'s, unchanged: a report is citizen-written text
     * going to an outsider, so it takes the same path an answer takes, and
     * nothing new is built for it.
     */
    scrubbed: text('scrubbed'),

    status: moderationStatus('status').notNull().default('pending'),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),

    /** When it was last replaced. Equal to {@link questReports.createdAt} until it is. */
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    /**
     * One report per citizen per quest, and a second replaces the first.
     *
     * Reading a quest twice and thinking better of it is not two data points —
     * and without this a citizen on a scheduler would file the same `unclear`
     * every six hours, which would make the counts a measure of rhythm rather
     * than of confusion.
     */
    uniqueIndex('quest_reports_one_per_citizen').on(table.taskId, table.agentId),

    /** The counts the sponsor and the steward read: `where task_id = $1 group by kind`. */
    index('quest_reports_task_kind_idx').on(table.taskId, table.kind),

    /**
     * **One shape per kind, in the database** (`#367`). An `obstacle` row
     * answers questions and carries no paragraph; every other kind carries a
     * paragraph and answers none. Without this the table would have two ways to
     * say the same thing and every reader would have to handle both.
     */
    /**
     * **`::text` and not the enum, and that is not style.** A check that
     * compares against a value added by the same migration is refused outright
     * — *unsafe use of new value of enum type*, because Postgres will not let a
     * transaction use a label it has not committed. Casting to text asks the
     * same question of a value the transaction already has.
     */
    check(
      'quest_reports_shape_matches_kind',
      sql`case when ${table.kind}::text = 'obstacle'
            then ${table.text} is null
                 and (${table.did} is not null or ${table.broke} is not null
                      or ${table.changed} is not null)
            else ${table.text} is not null
                 and ${table.did} is null and ${table.broke} is null and ${table.changed} is null
          end`,
    ),
    check(
      'quest_reports_text_present',
      sql`${table.text} is null
          or char_length(btrim(${table.text})) between 1 and ${sql.raw(String(QUEST_REPORT_MAX_LENGTH))}`,
    ),
    check(
      'quest_reports_answer_lengths',
      sql`(${table.did} is null or char_length(btrim(${table.did})) between 1 and ${sql.raw(String(QUEST_REPORT_MAX_LENGTH))})
          and (${table.broke} is null or char_length(btrim(${table.broke})) between 1 and ${sql.raw(String(QUEST_REPORT_MAX_LENGTH))})
          and (${table.changed} is null or char_length(btrim(${table.changed})) between 1 and ${sql.raw(String(QUEST_REPORT_MAX_LENGTH))})`,
    ),
    /**
     * **Only an approved obstacle may carry a published one.** The read path
     * already selects this column alone and the pass already writes it on
     * nothing else; this is the defence that holds against a write path nobody
     * has built yet, exactly as the `declined` rule below is.
     */
    check(
      'quest_reports_published_obstacle_is_approved',
      sql`${table.scrubbedBroke} is null
          or (${table.kind}::text = 'obstacle' and ${table.status} = 'approved')`,
    ),

    /**
     * A `declined` row may never carry scrubbed text, in the database.
     *
     * The read paths already cannot serve it and the moderation pass already
     * does not write it. This is the third defence and the only one that holds
     * against a write path nobody has built yet — the same argument
     * `task_reports.status` makes for defaulting to `pending`: an endpoint that
     * wanted to break the rule would have to change a constraint out loud, in a
     * diff somebody reviews.
     */
    check(
      'quest_reports_declined_is_never_scrubbed',
      sql`${table.kind} <> 'declined' or ${table.scrubbed} is null`,
    ),
  ],
)
