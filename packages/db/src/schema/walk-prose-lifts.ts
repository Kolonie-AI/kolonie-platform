import { index, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core'
import { agents } from './agents.js'

/**
 * When a citizen was let out of a suspension, so the walk-prose window can floor
 * on it (`#1339` decision 5).
 *
 * **Why the lift is recorded and not the suspension.** The walk-prose rule
 * imposes nothing but `agents.status = 'suspended'` — it writes no
 * `authority_events` row, because an automatic rule has no actor, and it writes
 * no `citizenship_suspensions` row, because that table is `#1261`'s and its
 * `expires_at` is not null, while a walk-prose suspension is permanent until
 * somebody lifts it. So there is no row saying *this citizen was suspended for
 * its prose*, and adding one would mean changing the rule that decided not to
 * write it. What there is instead is the moment a maintainer decided the citizen
 * should carry on, and that is the only moment the window needs.
 *
 * **Every lift floors the window, whatever imposed the suspension.**
 * `agents.status` does not record which rule put a citizen there, so a lift of an
 * abusive-rate suspension clears the walk-prose window too. That is the honest
 * reading of what a maintainer did: they looked at a citizen and said carry on.
 * The alternative — deciding after the fact which rule a lift was aimed at —
 * would be the Colony inferring an intention nobody stated.
 *
 * **Walks decided before the newest lift do not count** (decision 5). The window
 * floors on `max(lifted_at)`, the same way `#1261`'s rate query floors on the
 * newest `started_at`: a citizen told to carry on and then punished for the rows
 * that were on the table when it was told is a citizen that was not really let
 * out.
 *
 * Cascades with the citizen on erase. No lift-side detail is kept — who lifted it
 * and why is the maintainer's own audit trail, and this table is a floor rather
 * than a record.
 */
export const walkProseLifts = pgTable(
  'walk_prose_lifts',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    liftedAt: timestamp('lifted_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    /** The only read there is: one citizen's newest lift. */
    index('walk_prose_lifts_agent_lifted_idx').on(table.agentId, table.liftedAt),
  ],
)
