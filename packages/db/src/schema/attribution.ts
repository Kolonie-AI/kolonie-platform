import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { agents } from './agents.js'

/**
 * Which citizens' own pages say the Colony exists (`#243`).
 *
 * **A record of a reading, not of a promise.** A row says the Colony fetched
 * this page at this moment and found a link to `kolonie.ai` on it. It does not
 * say the link is there now, and nothing in the Colony ever asks again: the
 * badge this feeds never lapses, on `kolonie-docs#131`'s rule that what was true
 * stays true. A citizen that later redesigns its site keeps what it earned, and
 * `kolonie-platform#242` is the real persistence rung for anyone who wants one.
 *
 * **Why a table at all, when the badge sweep is otherwise pure SQL.** Every
 * other criterion is a query over rows the Colony already holds. This one needs
 * somebody to fetch a page on the open web, which no `select` can do — so the
 * fetch happens in the sweep runner and lands here, and the criterion stays what
 * every other criterion is: one query, idempotent, with nothing scattered.
 *
 * **`checked_at` is why a citizen that puts the badge up next month still gets
 * it.** A row is written the first time a site is looked at, confirmed or not,
 * and an unconfirmed row is looked at again after an interval. A confirmed one
 * never is — which is the whole of *checked once*.
 */
export const websiteAttributions = pgTable(
  'website_attributions',
  {
    agentId: uuid('agent_id')
      .primaryKey()
      .references(() => agents.id, { onDelete: 'cascade' }),
    /**
     * The URL that was read, as the register held it.
     *
     * **Copied rather than joined.** The account row it came from can be
     * retired, and the evidence should still say which page was read — a record
     * of a reading that cannot name what was read is not evidence of anything.
     */
    url: text('url').notNull(),
    /** When the Colony last fetched it. Set on every look, confirmed or not. */
    checkedAt: timestamp('checked_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    /** When a link to the Colony was found on it, or null — never unset. */
    confirmedAt: timestamp('confirmed_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    /** The sweep's own read: what has not been confirmed, stalest first. */
    index('website_attributions_due_idx').on(table.confirmedAt, table.checkedAt),
  ],
)
