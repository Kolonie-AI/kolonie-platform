import { sql } from 'drizzle-orm'
import { check, index, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core'
import {
  PLAYBOOK_STATUS_DECISION_SOURCES,
  PLAYBOOK_STATUSES,
  type PlaybookStatus,
  type PlaybookStatusDecisionSource,
} from '@kolonie-ai/core'
import { playbooks } from './playbooks.js'

const oneOf = (values: readonly string[]) => sql.raw(values.map((one) => `'${one}'`).join(', '))

/**
 * One `open` ↔ `blocked` transition on a playbook (`#1256`).
 *
 * ## Why a table and not only columns on `playbooks`
 *
 * The playbook row carries the **latest** reason (`status_reason` /
 * `status_changed_at` / `status_changed_by`) so `get` can show it without a
 * join — the same shape `refusal_reason` has. What the row cannot keep is the
 * earlier transition: blocking and clearing both have to be recorded, and
 * overwriting the columns would lose the block when the clear arrives.
 *
 * Append-only. A playbook that is blocked, repaired by a revision, and blocked
 * again has three rows here; the pair (or triple) is the record.
 *
 * ## Who
 *
 * `decided_by` is a closed vocabulary ({@link PLAYBOOK_STATUS_DECISION_SOURCES}),
 * not a foreign key. Today it is always `moderation` — the threshold and the
 * revision-clear are Colony decisions. A citizen cannot write here.
 */
export const playbookStatusEvents = pgTable(
  'playbook_status_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    playbookId: uuid('playbook_id')
      .notNull()
      .references(() => playbooks.id, { onDelete: 'cascade' }),

    fromStatus: varchar('from_status', { length: 16 }).$type<PlaybookStatus>().notNull(),
    toStatus: varchar('to_status', { length: 16 }).$type<PlaybookStatus>().notNull(),

    reason: text('reason').notNull(),

    decidedBy: varchar('decided_by', { length: 32 })
      .$type<PlaybookStatusDecisionSource>()
      .notNull(),

    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      'playbook_status_events_from_is_known',
      sql`${table.fromStatus} in (${oneOf(PLAYBOOK_STATUSES)})`,
    ),
    check(
      'playbook_status_events_to_is_known',
      sql`${table.toStatus} in (${oneOf(PLAYBOOK_STATUSES)})`,
    ),
    check(
      'playbook_status_events_decided_by_is_known',
      sql`${table.decidedBy} in (${oneOf(PLAYBOOK_STATUS_DECISION_SOURCES)})`,
    ),
    check(
      'playbook_status_events_is_open_blocked_pair',
      sql`(${table.fromStatus} = 'open' and ${table.toStatus} = 'blocked')
        or (${table.fromStatus} = 'blocked' and ${table.toStatus} = 'open')`,
    ),
    check('playbook_status_events_reason_not_blank', sql`length(trim(${table.reason})) > 0`),
    index('playbook_status_events_playbook_idx').on(table.playbookId, table.decidedAt),
  ],
)
