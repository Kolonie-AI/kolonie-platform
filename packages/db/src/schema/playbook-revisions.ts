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
import { PLAYBOOK_MAX_STEPS, type PlaybookStep } from '@kolonie-ai/core'
import { playbooks } from './playbooks.js'

/**
 * One cut of a playbook's steps (`#1255`).
 *
 * ## Why a table and not only `playbooks.version`
 *
 * `playbooks.steps` and `playbooks.version` stay the live document — every read
 * already goes there. What this table adds is the history those two cannot keep:
 * the full step list at each cut, which accepted proposals were folded into it,
 * and when. A citizen reading `kolonie.playbooks.history` walks these rows; a
 * run report points at one by revision number.
 *
 * ## Revision number === `playbooks.version`
 *
 * The live row's `version` is the current revision number. Cutting a revision
 * bumps `version` and inserts a row here with the same integer, in one
 * transaction. There is no second counter to drift.
 *
 * ## Backfill
 *
 * Every playbook that existed before this shipped gets a revision-1 row whose
 * `proposal_ids` is empty — the steps as they stood, attributed to nobody's
 * proposal. Runs filed before then carry a null revision on the run row.
 */
export const playbookRevisions = pgTable(
  'playbook_revisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    playbookId: uuid('playbook_id')
      .notNull()
      .references(() => playbooks.id, { onDelete: 'cascade' }),

    /** Matches `playbooks.version` at the moment this cut was written. */
    revision: integer('revision').notNull(),

    steps: jsonb('steps').$type<readonly PlaybookStep[]>().notNull(),

    /**
     * The accepted proposals folded into this cut, in filing order.
     *
     * Empty on the initial revision-1 row (create/fork/backfill) and on any cut
     * produced by an authoring edit that bumped `version` without proposals.
     * The fold tick is what fills it. Kept as uuid[] rather than a child table:
     * read whole with the revision, never joined on.
     */
    proposalIds: uuid('proposal_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),

    cutAt: timestamp('cut_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('playbook_revisions_playbook_revision_key').on(table.playbookId, table.revision),
    index('playbook_revisions_playbook_cut_at_idx').on(table.playbookId, table.cutAt),
    check('playbook_revisions_revision_is_positive', sql`${table.revision} >= 1`),
    check(
      'playbook_revisions_steps_within_bounds',
      sql`jsonb_array_length(${table.steps}) between 1 and ${sql.raw(String(PLAYBOOK_MAX_STEPS))}`,
    ),
  ],
)
