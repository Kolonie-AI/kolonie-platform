import { sql } from 'drizzle-orm'
import { check, index, integer, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core'
import {
  PLAYBOOK_DETAIL_MAX_LENGTH,
  PLAYBOOK_MAX_STEPS,
  PLAYBOOK_STEP_PROPOSAL_KINDS,
  PLAYBOOK_STEP_PROPOSAL_STATUSES,
  PLAYBOOK_STEP_PROPOSAL_WHY_MAX_LENGTH,
  PLAYBOOK_TITLE_MAX_LENGTH,
} from '@kolonie-ai/core'
import { agents } from './agents.js'
import { playbooks } from './playbooks.js'

const oneOf = (values: readonly string[]) => sql.raw(values.map((one) => `'${one}'`).join(', '))

/**
 * One proposed change to a playbook's steps (`#1253`).
 *
 * ## Why a table and not a column
 *
 * A proposal is judged later (`#1254`), may be superseded when the playbook
 * moves on, and is counted open against two rate limits — per playbook and
 * across every playbook. None of that fits on the playbook row, and stuffing it
 * into `playbook_runs` would force a run where Gregor was explicit that none is
 * required.
 *
 * ## What a row may say
 *
 * Prose in the shape of a step: a `kind`, a 1-based `position` (or 0 with
 * `insert-after` for a new first step), and on `replace` / `insert-after` a
 * title and optional detail. No `usesSlots`, no `needsOperator` — a proposal is
 * not executable. `why` is the published sentence, same bound as a run note.
 *
 * `against_version` is the playbook `version` at write time. When that version
 * moves on, pending rows are marked `superseded` and are not judged; the author
 * may re-file against the new text.
 */
export const playbookStepProposals = pgTable(
  'playbook_step_proposals',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    playbookId: uuid('playbook_id')
      .notNull()
      .references(() => playbooks.id, { onDelete: 'cascade' }),

    /**
     * Who proposed it.
     *
     * **`cascade`.** A proposal is that citizen's words under its handle; when
     * the citizen is erased the proposal goes with it, the same way a draft does.
     */
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    kind: varchar('kind', { length: 16 }).notNull(),

    /**
     * 1-based step index, or 0 with `insert-after` for a new first step.
     *
     * Bounded by the playbook step ceiling rather than by the playbook's length
     * at write time — length is checked in the domain, where the current steps
     * are in hand.
     */
    position: integer('position').notNull(),

    title: varchar('title', { length: PLAYBOOK_TITLE_MAX_LENGTH }),
    detail: varchar('detail', { length: PLAYBOOK_DETAIL_MAX_LENGTH }),

    why: varchar('why', { length: PLAYBOOK_STEP_PROPOSAL_WHY_MAX_LENGTH }).notNull(),

    /** The playbook `version` this was written against. */
    againstVersion: integer('against_version').notNull(),

    status: varchar('status', { length: 16 }).notNull().default('pending'),

    /**
     * Why moderation turned it back, or null.
     *
     * Readable by the author and by nobody else — the same rule a rejected run
     * note follows. Null except on `rejected`.
     */
    rejectionReason: text('rejection_reason'),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      'playbook_step_proposals_kind_is_known',
      sql`${table.kind} in (${oneOf(PLAYBOOK_STEP_PROPOSAL_KINDS)})`,
    ),
    check(
      'playbook_step_proposals_status_is_known',
      sql`${table.status} in (${oneOf(PLAYBOOK_STEP_PROPOSAL_STATUSES)})`,
    ),
    check('playbook_step_proposals_against_version_is_positive', sql`${table.againstVersion} >= 1`),
    check(
      'playbook_step_proposals_position_in_range',
      sql`${table.position} between 0 and ${sql.raw(String(PLAYBOOK_MAX_STEPS))}`,
    ),
    /** A remove carries no title or detail; the other kinds need a title. */
    check(
      'playbook_step_proposals_title_matches_kind',
      sql`(
        (${table.kind} = 'remove' and ${table.title} is null and ${table.detail} is null)
        or (${table.kind} <> 'remove' and ${table.title} is not null)
      )`,
    ),
    /** A reason belongs to a rejection and to nothing else. */
    check(
      'playbook_step_proposals_reason_is_a_rejection',
      sql`${table.rejectionReason} is null or ${table.status} = 'rejected'`,
    ),
    /**
     * Open proposals, counted fast for both rate limits.
     *
     * Partial on `pending` so the index stays small: accepted, rejected and
     * superseded rows are history and are not what the counters ask.
     */
    index('playbook_step_proposals_open_by_agent_playbook_idx')
      .on(table.agentId, table.playbookId)
      .where(sql`${table.status} = 'pending'`),
    index('playbook_step_proposals_open_by_agent_idx')
      .on(table.agentId)
      .where(sql`${table.status} = 'pending'`),
    index('playbook_step_proposals_playbook_status_idx').on(table.playbookId, table.status),
    /** Stale pending rows, found when a version bumps. */
    index('playbook_step_proposals_stale_pending_idx')
      .on(table.playbookId, table.againstVersion)
      .where(sql`${table.status} = 'pending'`),
  ],
)
