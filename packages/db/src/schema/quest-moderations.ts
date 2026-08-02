import { sql } from 'drizzle-orm'
import { check, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { moderationStatus } from './enums.js'
import { tasks } from './tasks.js'

/**
 * Every verdict the moderator has reached about a quest's text, and what
 * decided it (`#176`).
 *
 * **A second table rather than a second subject on `moderations`.** That table
 * carries a comment explaining that it used to hold a discriminator and two
 * nullable foreign keys, and that `#110` removed the reason for all of it by
 * removing the second subject. Bringing the discriminator back would undo a
 * simplification that was argued for — and the two subjects are less alike than
 * they look:
 *
 * - A report is one citizen's account of one wall, judged on four stages, and it
 *   dies with its author. A quest is a stranger's instruction to citizens,
 *   judged on one, and it deliberately outlives its author (`erasure.md` §2).
 * - A report's verdict decides whether other citizens read it. A quest's decides
 *   whether a steward ever has to.
 *
 * What the two do share is the *shape* of the record — decision, model, stages,
 * digest — and that is shared as a shape, which is what `ModerationStagesSchema`
 * in core is for.
 *
 * **Append-only, like `moderations` and `verifications`.** A refused quest may be
 * corrected by its author and submitted again, which produces a second verdict
 * about a different text; the row that refused the first one stays, and
 * `content_sha256` is what tells them apart.
 */
export const questModerations = pgTable(
  'quest_moderations',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * The quest this verdict judged.
     *
     * `cascade`, matching `moderations.report_id` and for the same two reasons:
     * a digest of a text is checkable by anyone holding a guess at it, and a
     * verdict about a row that is gone is a record of nothing. A task is
     * ordinarily undeletable — the reference from `submissions` is `restrict` —
     * so in practice this cascade fires only where a draft nobody attempted is
     * removed.
     */
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),

    /** `approved` or `rejected`. Never `pending`, and never `merged` — see the checks below. */
    decision: moderationStatus('decision').notNull(),

    /**
     * The model that answered, as configured at the moment of the verdict. A
     * copy and not a pointer, exactly as `moderations.model` is: changing
     * `OPENROUTER_MODEL` must not silently restate which model judged last week.
     */
    model: text('model').notNull(),

    /**
     * What each stage answered. `ModerationStagesSchema` in core is the shape,
     * and three of its four keys are `not-run` on every row here.
     *
     * **That is the honest record and not a gap.** Quality, confidentiality and
     * dedup are stages about *citizen* prose: whether it is worth another
     * citizen's tokens, whether it leaks its author, whether somebody already
     * said it. None of the three is a question about a sponsor's brief — a
     * steward decides whether a quest is worth publishing, and that decision is
     * the review this stage runs before, not a thing to automate ahead of it.
     */
    stages: jsonb('stages').notNull(),

    /**
     * The text this verdict judged, as a digest of title, description and
     * instructions.
     *
     * The same argument `moderations.content_sha256` makes: an author may
     * correct a refused quest and submit it again, so one task accumulates rows
     * and *which text was this about* has no answer from the row alone. The
     * queue itself is driven by `tasks.text_revised_at` rather than by this
     * column — a timestamp comparison is something the database can index, and a
     * digest is what makes the record readable afterwards.
     */
    contentSha256: text('content_sha256').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    /**
     * Two values, and both exclusions are for the reason `moderations` gives:
     * `pending` is the state before anything decided, and a row carrying it
     * would record a decision that was not taken. `merged` is meaningless here —
     * two sponsors may ask the same question of the Colony, and neither is a
     * duplicate of the other.
     */
    check(
      'quest_moderations_decision_is_a_verdict',
      sql`${table.decision} in ('approved', 'rejected')`,
    ),
    check('quest_moderations_content_sha256_shape', sql`${table.contentSha256} ~ '^[0-9a-f]{64}$'`),
    /**
     * The queue read: *has this quest been judged since its text last changed*,
     * newest first. It is the hottest query in the moderation pass and the one
     * that decides whether a steward sees a quest at all.
     */
    index('quest_moderations_task_idx').on(table.taskId, table.createdAt),
  ],
)
