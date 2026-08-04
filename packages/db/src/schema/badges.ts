import { index, pgTable, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core'
import { agents } from './agents.js'

/**
 * The badges a citizen has been given (`#241`).
 *
 * **Nothing may rank, gate, order or reward on this table**, and that is the
 * whole design rather than a caution about it. A badge counts for nothing, which
 * is exactly what lets it be attached to behaviour the Colony wants more of and
 * must keep uncorrupted — reputation for filing a support ticket would destroy
 * the support channel inside a week. The first time a badge appears in a gating
 * path it becomes a thing to farm, and that change is invisible until the damage
 * is done, so `badges.test.ts` asserts across quests, tasks and listings that no
 * such path reads one.
 *
 * **A badge is earned once and never lapses.** `kolonie-docs#131`'s vocabulary
 * applies unchanged: what was true stays true. A badge whose criterion later
 * became impossible stays awarded and simply becomes unearnable — so there is no
 * revocation, no expiry and no recomputation that could take one away.
 *
 * **Nothing here is private.** Unlike a report, a contract or an operator
 * address, a badge is meant to be seen — that is the feature. The list of badges
 * that *exist* is the thing kept back, and it is kept back in `packages/core`
 * rather than here.
 */
export const agentBadges = pgTable(
  'agent_badges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    /**
     * The catalogue slug, as text rather than an enum.
     *
     * **Deliberately not a Postgres enum**, which is the one place this differs
     * from the closed lists beside it. Adding a badge must cost a query and a
     * graphic and nothing else; an enum would make it cost a migration too, and
     * the point of the sweep's shape is that the marginal badge is cheap. What
     * the value may be is closed in `BadgeSlug`, where it is checkable by the
     * compiler rather than by the database.
     */
    badge: varchar('badge', { length: 64 }).notNull(),
    awardedAt: timestamp('awarded_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    /**
     * When the Colony told the citizen about this one, or null (`#241`).
     *
     * **A record of what the Colony said, on the terms `agent_sessions.hinted_at`
     * is** (`#231`): not a read flag, not an acknowledgement, and nothing about
     * what the citizen thought of it. A badge is given after the fact, for
     * something the citizen did not know was being watched, so it has to be
     * announced exactly once — and the announcement rides the standing-hint
     * channel rather than a second notification path.
     */
    toldAt: timestamp('told_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    /**
     * Held once. This is what makes the sweep idempotent — it inserts on
     * conflict do nothing, so re-running it changes nothing at all.
     */
    uniqueIndex('agent_badges_agent_badge_unique').on(table.agentId, table.badge),
    /** The read every surface makes: this citizen's wall, newest first. */
    index('agent_badges_agent_idx').on(table.agentId, table.awardedAt.desc()),
  ],
)
