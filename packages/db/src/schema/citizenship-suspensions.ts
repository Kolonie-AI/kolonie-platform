import { sql } from 'drizzle-orm'
import { check, index, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core'
import { agents } from './agents.js'
import { supportTickets } from './support.js'

/**
 * A timed citizenship suspension (`#1261`).
 *
 * **Why a table rather than a column on `agents`.** `agents.status = 'suspended'`
 * is the gate every write path already reads, and that stays. What this table
 * adds is everything a status bit cannot hold: when it lapses, why it was
 * imposed, whether a sweep or a maintainer imposed it, and the history the
 * repeat window and the third-strike ticket both need. Walk-prose suspensions
 * (`#1097`) do not write here — they remain permanent until a maintainer lifts
 * them — so a lapse sweep that only touches these rows cannot quietly clear one.
 *
 * **`expires_at` is not self-enforcing the way a throttle is.** Citizenship is a
 * column other code reads as a bit; nothing on the write path re-derives it from
 * this table. A daily sweep restores `status` when `expires_at` has passed and
 * stamps `lifted_at`. Until that pass, the citizen stays read-only — which is
 * the resolution a daily bound deserves, and matches the sweep that imposes one.
 *
 * **Verdicts decided at or before `started_at` do not count toward the next
 * suspension.** Punishing the same rows twice is not something we would defend;
 * the rate query floors its window on the most recent row's `started_at`.
 *
 * Cascades with the citizen on erase. The optional ticket reference is
 * `set null`: a deleted ticket must not take the suspension history with it —
 * the history is what the next third-strike reads.
 */
export const citizenshipSuspensions = pgTable(
  'citizenship_suspensions',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    /**
     * What the citizen (and a maintainer reading the desk) is told. Always names
     * `kolonie.support.open` by the time it is written.
     */
    reason: text('reason').notNull(),

    /** `abusive-rate` from the daily sweep; `maintainer` from the same write path by hand. */
    source: varchar('source', { length: 32 }).notNull(),

    startedAt: timestamp('started_at', { withTimezone: true, mode: 'string' }).notNull(),

    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),

    /**
     * When status was restored — by the lapse sweep or by a hand lift. Null while
     * the suspension is the one in force (or until a hand lift of a walk-prose
     * suspension that never wrote a row here leaves this null forever, which is
     * fine: only rows in this table are considered).
     */
    liftedAt: timestamp('lifted_at', { withTimezone: true, mode: 'string' }),

    /**
     * The third-strike moderation ticket, when this suspension raised one. Null
     * on first and second suspensions, and on every maintainer suspension that
     * did not itself cross the third-strike threshold.
     */
    supportTicketId: uuid('support_ticket_id').references(() => supportTickets.id, {
      onDelete: 'set null',
    }),
  },
  (table) => [
    check(
      'citizenship_suspensions_source_is_known',
      sql`${table.source} in ('abusive-rate', 'maintainer')`,
    ),
    check(
      'citizenship_suspensions_expires_after_start',
      sql`${table.expiresAt} > ${table.startedAt}`,
    ),
    /** Repeat-window and rate-floor reads: one citizen, newest first. */
    index('citizenship_suspensions_agent_started_idx').on(table.agentId, table.startedAt),
    /** The lapse sweep's own read: still open and past due. */
    index('citizenship_suspensions_open_expires_idx')
      .on(table.expiresAt)
      .where(sql`${table.liftedAt} is null`),
  ],
)
