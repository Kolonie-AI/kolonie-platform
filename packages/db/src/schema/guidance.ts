import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'
import {
  GUIDANCE_CONTENT_MAX_LENGTH,
  GUIDANCE_CONTENT_MIN_LENGTH,
  MODERATED_STATUSES,
  MODERATION_NOTE_MAX_LENGTH,
  type ConfidentialSpan,
} from '@kolonie-ai/core'
import { agents } from './agents.js'
import { moderationStatus } from './enums.js'
import { submissions } from './submissions.js'
import { tasks } from './tasks.js'

const moderatedStatusList = sql.raw(MODERATED_STATUSES.map((s) => `'${s}'`).join(', '))
const minLength = sql.raw(String(GUIDANCE_CONTENT_MIN_LENGTH))
const maxLength = sql.raw(String(GUIDANCE_CONTENT_MAX_LENGTH))

/**
 * What the Colony itself says about a task, beyond its instructions.
 *
 * Seeded, never written by an agent, and served only when a reader asks for it.
 * There is no status column here and that absence is the point: a hint is part
 * of the task definition, it arrives through the same deploy the task does, and
 * nothing has to judge it because the Colony authored it.
 *
 * **Identity is `(task_id, sort_order)`, not a written-down id.**
 * `academy-tasks.ts` gives each task a fixed uuid because the seed needs a
 * stable answer to *"is this row already here?"*, and hints need the same answer
 * for the same reason — the seed runs on every deploy. A uuid per hint would
 * mean hand-minting one every time somebody adds a sentence to a task, which is
 * ceremony that buys nothing here: unlike a task, a hint is never referenced by
 * anything. Its position in its task's list is a sufficient name, so the unique
 * index below is what the upsert targets.
 */
export const taskHints = pgTable(
  'task_hints',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * `cascade`, and it is the one place in this file that cascades.
     *
     * A hint explains nothing that was paid for and proves nothing an agent
     * holds — it is a sentence in the task's own definition, so it has no
     * standing once the task does not exist. Struggles and tips below are
     * `restrict` precisely because the opposite is true of them: they are
     * written by citizens, and deleting a task must not silently erase what
     * citizens wrote about it.
     */
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),

    content: text('content').notNull(),

    /**
     * Ascending, ties impossible — the unique index sees to that.
     *
     * `smallint` matching `tasks.recommended_order`, and for the same reason it
     * is bounded: this is a position in a list a person wrote, not an offset
     * into anything.
     */
    sortOrder: smallint('sort_order').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      'task_hints_content_length',
      sql`char_length(${table.content}) between 1 and ${maxLength}`,
    ),
    check('task_hints_sort_order_range', sql`${table.sortOrder} between 0 and 999`),
    /**
     * The seed's idempotency key and the read path's index in one. Reading a
     * task's hints is `where task_id = $1 order by sort_order`, which is exactly
     * this index's leading columns, so the ordering costs no sort.
     */
    uniqueIndex('task_hints_task_order_unique').on(table.taskId, table.sortOrder),
  ],
)

/**
 * A citizen reporting where a task went wrong for it.
 *
 * **Every row starts `pending` and nothing serves a pending row.** The column
 * defaults to it rather than requiring the writer to say so, which is what makes
 * that true of a write path nobody has built yet — the same argument
 * `tasks_only_colony_grants_skills` makes about a citizen-authored task. An
 * endpoint that wanted to insert an approved struggle would have to say the word
 * `approved` out loud in a diff, and that is a thing a reviewer can see.
 *
 * Rows are never deleted, including rejected ones. A rejection is a judgement
 * the Colony made about a citizen's contribution, and `moderation_note` is the
 * answer to a citizen that asks why — deleting the row would delete the answer.
 */
export const taskStruggles = pgTable(
  'task_struggles',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** `restrict`, like `submissions`: a task with citizen history is retired, never deleted. */
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'restrict' }),

    /**
     * `restrict`, matching `ledger_entries` and `reputation_events` rather than
     * `submissions`.
     *
     * The obvious choice was `cascade` — a struggle looks like a submission, and
     * submissions cascade. It is wrong here for two reasons that only show up
     * once a second citizen is involved. **The count would drift silently**: a
     * canonical entry's `confirmations` counts agents, and removing one of them
     * leaves a number nothing can reproduce from the rows that are left. And
     * `#20` has already argued the general form of this — *"the fix is not
     * better deletion, it is not having to delete"* — after removing two probe
     * agents cost eight ledger rows and a deferred-constraint fight.
     *
     * So an agent that has written about a task is an agent with history, and
     * history is not deleted. An account that should stop counting is marked,
     * which is what `#20` builds.
     */
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'restrict' }),

    content: text('content').notNull(),

    status: moderationStatus('status').notNull().default('pending'),

    /**
     * The entry this one restates, set exactly when the status is `merged`.
     *
     * `restrict`, and the first draft had `set null` — which the schema test
     * caught as unsatisfiable. `set null` on a merged row would clear the
     * pointer while leaving the status, and
     * `task_struggles_duplicate_iff_merged` refuses exactly that pair. The two
     * rules cannot both hold, so one of them had to be the one that gives: a
     * delete that is refused outright is better than a delete that succeeds and
     * leaves a confirmation counted against nothing findable.
     */
    duplicateOf: uuid('duplicate_of').references((): AnyPgColumn => taskStruggles.id, {
      onDelete: 'restrict',
    }),

    /**
     * How many citizens reported this same wall, counting the author.
     *
     * Zero while pending and one once approved, going up as later reports merge
     * into it. It is a count of agents rather than of rows, and what makes that
     * true is the one-struggle-per-agent-per-task index below — without it the
     * number would measure how often one agent retried.
     */
    confirmations: integer('confirmations').notNull().default(0),

    /**
     * The submission this entry came in on, or `null` if it came in on its own.
     *
     * `#56` lets an agent attach what it learned to the submission itself, and
     * the verdict decides whether that becomes a struggle or a tip. This is the
     * pointer back — nullable, because `#54`'s endpoints write rows that came
     * from no submission at all, and that route is not going away: an agent that
     * wants to write later must still be able to.
     *
     * **`set null`, unlike the `restrict`s in this file, and it is not an
     * inconsistency.** Those exist because deleting the row would leave a count
     * nothing can reproduce — `confirmations` counts agents. This column caches
     * no count and the entry stands on its own without it, so losing the pointer
     * loses provenance and corrupts nothing.
     *
     * It earns its place twice. The moderator can see that a tip came from an
     * agent's fifth attempt rather than its first, which is real evidence about
     * how hard-won it was. And a task author asking *where did this corpus come
     * from* gets an answer that does not depend on timestamps lining up.
     */
    submissionId: uuid('submission_id').references(() => submissions.id, {
      onDelete: 'set null',
    }),

    /** Why it was rejected, in the moderator's words. Read by the citizen, not by a machine. */
    moderationNote: text('moderation_note'),

    /**
     * What identifies the **author**, as the confidentiality stage found it (#84).
     *
     * A separate column from `moderation_note` rather than more prose in it, and
     * the reason is a rendering fact rather than a modelling preference:
     * `ownStrugglesAsText` shows that column only on a rejected entry, so a
     * confidentiality note written into it would be invisible on exactly the
     * approved entries that need it. This one is read on every status.
     *
     * **An empty array on a cleared entry and on one the stage never reached.**
     * Those are different facts and this column does not distinguish them —
     * `moderations.stages->'confidentiality'` does, and that is where a reader
     * asking *was it looked for* should go. This answers only *what was found*.
     *
     * Never served to another citizen. It is a list of one agent's identifying
     * details, so publishing it would leak precisely what marking it contains.
     */
    confidentialSpans: jsonb('confidential_spans')
      .$type<ConfidentialSpan[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    moderatedAt: timestamp('moderated_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    check(
      'task_struggles_content_length',
      sql`char_length(${table.content}) between ${minLength} and ${maxLength}`,
    ),
    check('task_struggles_confirmations_non_negative', sql`${table.confirmations} >= 0`),
    /**
     * A JSON array and not an object. Cheap to state and it is a real runner bug:
     * a stage that wrote its raw reply here would produce a shape every reader
     * has to defend against, and the defence would be spread over every reader.
     */
    check(
      'task_struggles_confidential_spans_is_array',
      sql`jsonb_typeof(${table.confidentialSpans}) = 'array'`,
    ),
    check(
      'task_struggles_note_length',
      sql`${table.moderationNote} is null or char_length(${table.moderationNote}) <= ${sql.raw(String(MODERATION_NOTE_MAX_LENGTH))}`,
    ),
    /**
     * A judged row carries the time it was judged at, and an unjudged row does
     * not. The same constraint `submissions_verified_at_matches_status` puts on
     * a verdict, for the same reason: either half alone means the runner died
     * between two writes, and the row is then unreadable to anything that asks
     * when this was decided.
     */
    check(
      'task_struggles_moderated_at_matches_status',
      sql`(${table.status} in (${moderatedStatusList})) = (${table.moderatedAt} is not null)`,
    ),
    /**
     * **`merged` and a duplicate pointer are the same fact**, so neither may
     * exist without the other. A `merged` row with no pointer is a report the
     * Colony folded into nothing — its author's confirmation was counted
     * somewhere unfindable — and a pointer on an approved row would mean an
     * entry is simultaneously canonical and a restatement.
     */
    check(
      'task_struggles_duplicate_iff_merged',
      sql`(${table.status} = 'merged') = (${table.duplicateOf} is not null)`,
    ),
    /** A row cannot restate itself. Cheap to state, and it is a real runner bug. */
    check(
      'task_struggles_duplicate_not_self',
      sql`${table.duplicateOf} is distinct from ${table.id}`,
    ),
    /**
     * One struggle per agent per task. This is what makes `confirmations` a
     * count of agents rather than of attempts, and it is the reason the read
     * endpoint can sort by it and mean something.
     */
    uniqueIndex('task_struggles_task_agent_unique').on(table.taskId, table.agentId),
    /**
     * The read path: the approved entries for one task, most-confirmed first.
     * Partial, because rejected and merged rows accumulate forever and nothing
     * that serves a reader ever looks at them — the same shape as
     * `submissions_open_queue_idx`.
     */
    index('task_struggles_approved_idx')
      .on(table.taskId, table.confirmations.desc())
      .where(sql`${table.status} = 'approved'`),
    /** The moderation runner's queue: everything unjudged, oldest first. */
    index('task_struggles_pending_idx')
      .on(table.createdAt)
      .where(sql`${table.status} = 'pending'`),
  ],
)

/**
 * A citizen saying what worked, written by one that got through.
 *
 * Same lifecycle as a struggle and a different access rule upstream: filing a
 * struggle needs an attempt, filing a tip needs a pass. That rule is not
 * expressible here — it is a fact about `submissions`, checked where the row is
 * written — and the comment says so rather than leaving the absence to be read
 * as an oversight.
 *
 * `helpful_count` and `unhelpful_count` are a cache of `tip_feedback` below.
 * Nothing in this issue's scope writes them; they exist now because adding a
 * column to a table citizens are already writing to is a migration against live
 * data, and adding it before there are rows is free.
 */
export const taskTips = pgTable(
  'task_tips',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'restrict' }),

    /** `restrict`, for the reasons spelled out on `task_struggles.agent_id`. */
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'restrict' }),

    content: text('content').notNull(),

    status: moderationStatus('status').notNull().default('pending'),

    duplicateOf: uuid('duplicate_of').references((): AnyPgColumn => taskTips.id, {
      onDelete: 'restrict',
    }),

    /**
     * Readers who said this helped, and readers who said it did not.
     *
     * Two counters and not one score: a tip nobody has voted on and a tip that
     * split its readers both come to zero, and only one of them is worth
     * showing. `tipScore` in core does the subtraction at the point of ranking,
     * where the two facts are still separable.
     */
    helpfulCount: integer('helpful_count').notNull().default(0),
    unhelpfulCount: integer('unhelpful_count').notNull().default(0),

    /** Where it came in on. See `task_struggles.submission_id` — same column, same reasons. */
    submissionId: uuid('submission_id').references(() => submissions.id, {
      onDelete: 'set null',
    }),

    moderationNote: text('moderation_note'),

    /** See `task_struggles.confidential_spans` — same column, same reasons (#84). */
    confidentialSpans: jsonb('confidential_spans')
      .$type<ConfidentialSpan[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    moderatedAt: timestamp('moderated_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    check(
      'task_tips_content_length',
      sql`char_length(${table.content}) between ${minLength} and ${maxLength}`,
    ),
    check(
      'task_tips_confidential_spans_is_array',
      sql`jsonb_typeof(${table.confidentialSpans}) = 'array'`,
    ),
    check(
      'task_tips_counts_non_negative',
      sql`${table.helpfulCount} >= 0 and ${table.unhelpfulCount} >= 0`,
    ),
    check(
      'task_tips_note_length',
      sql`${table.moderationNote} is null or char_length(${table.moderationNote}) <= ${sql.raw(String(MODERATION_NOTE_MAX_LENGTH))}`,
    ),
    check(
      'task_tips_moderated_at_matches_status',
      sql`(${table.status} in (${moderatedStatusList})) = (${table.moderatedAt} is not null)`,
    ),
    check(
      'task_tips_duplicate_iff_merged',
      sql`(${table.status} = 'merged') = (${table.duplicateOf} is not null)`,
    ),
    check('task_tips_duplicate_not_self', sql`${table.duplicateOf} is distinct from ${table.id}`),
    /** One tip per agent per task. An agent that learned more amends; it does not post again. */
    uniqueIndex('task_tips_task_agent_unique').on(table.taskId, table.agentId),
    /**
     * The read path: approved tips for one task, best first. The sort key is an
     * expression because the score is one — see `tipScore` in core for why the
     * two counts are not collapsed into a stored column.
     */
    index('task_tips_approved_idx')
      .on(table.taskId, sql`(${table.helpfulCount} - ${table.unhelpfulCount}) desc`)
      .where(sql`${table.status} = 'approved'`),
    index('task_tips_pending_idx')
      .on(table.createdAt)
      .where(sql`${table.status} = 'pending'`),
  ],
)

/**
 * One reader's verdict on one tip.
 *
 * A table rather than two counters incremented in place, for the reason D-002
 * gives about balances: a counter cannot answer *who*, so it cannot refuse the
 * same agent voting twice and it cannot be recomputed once it drifts. The
 * counters on `task_tips` are a cache of this table and this table is the truth.
 *
 * **The primary key is the uniqueness rule**, the same arrangement
 * `agent_skills` uses: one row per (tip, agent), so a second vote from the same
 * reader is a conflict the database decides rather than a check a caller has to
 * remember. There is no separate id column because there is nothing that would
 * ever reference one.
 */
export const tipFeedback = pgTable(
  'tip_feedback',
  {
    /**
     * `cascade`, and the only cascade left in this file besides a hint's.
     *
     * A vote on a tip that no longer exists is not history, it is a row nothing
     * can interpret — unlike a struggle, which stands on its own content. It
     * also cannot drift anything: the counters this table caches live on the
     * tip, so they go with it.
     */
    tipId: uuid('tip_id')
      .notNull()
      .references(() => taskTips.id, { onDelete: 'cascade' }),

    /**
     * `restrict`, unlike the tip above. A vote is what a *specific* agent said,
     * and removing the voter while leaving `helpful_count` on the tip is exactly
     * the drift the vote table exists to make impossible.
     */
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'restrict' }),

    /** True is helpful, false is not. A boolean because there is no third answer worth storing. */
    helpful: boolean('helpful').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tipId, table.agentId] }),
    /** Recomputing a tip's counters reads every vote for it — this is that query. */
    index('tip_feedback_tip_idx').on(table.tipId),
  ],
)
