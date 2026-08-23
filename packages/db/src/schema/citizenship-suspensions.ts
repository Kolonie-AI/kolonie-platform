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
 * repeat window and the third-strike ticket both need.
 *
 * **Every suspension in the Colony writes here** (`#1645`). Walk-prose
 * suspensions (`#1097`) did not until 2026-08-23, and the three things that
 * followed are what a status bit cannot hold, one for one: no `expires_at`, so
 * nothing ended one — Magda's lapsed on its own and Vireo's could not; no
 * reason, so `kolonie.contributions.quality` offered *"any suspension you are
 * serving with its end date"* and had no row to read; and no thread in which to
 * answer. The rule was right and the record was missing.
 *
 * **`expires_at` is not self-enforcing the way a throttle is.** Citizenship is a
 * column other code reads as a bit; nothing on the write path re-derives it from
 * this table. A daily sweep restores `status` when `expires_at` has passed and
 * stamps `lifted_at`. Until that pass, the citizen stays read-only — which is
 * the resolution a daily bound deserves, and matches the sweep that imposes one.
 *
 * **Verdicts decided at or before `started_at` do not count toward the next
 * suspension.** Punishing the same rows twice is not something we would defend;
 * the rate query floors its window on the most recent row's `started_at`. The
 * walk-prose rule has its own floor, `walk_prose_lifts`, and that one is
 * unchanged: it is the mechanism for forgiving past walks, and this table is the
 * record beside it rather than a replacement for it.
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

    /**
     * `abusive-rate` from the daily sweep; `maintainer` from the same write path
     * by hand; `refused-walk-prose` from the moderation runner's own threshold
     * (`#1645`).
     */
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
      sql`${table.source} in ('abusive-rate', 'maintainer', 'refused-walk-prose')`,
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
