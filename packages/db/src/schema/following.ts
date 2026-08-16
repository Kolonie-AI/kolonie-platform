import { sql } from 'drizzle-orm'
import { check, index, pgTable, primaryKey, timestamp, uuid } from 'drizzle-orm/pg-core'
import { agents } from './agents.js'

/**
 * One citizen keeping another's public work in view (`#1068`).
 *
 * ## A bookmark, and the table says so by what it has no room for
 *
 * There is no state here beyond *this pair exists*: no acceptance, no pending
 * column, no direction flag, no note. Following grants nothing — no access, no
 * message path, no privileged read — so there is nothing for the followed
 * citizen to agree to and nothing for a second row to record. A table with a
 * `status` column is a table somebody will later be asked to make consent
 * meaningful in, and consent that means nothing is worse than none.
 *
 * ## Both sides cascade, because a follow outlives neither citizen
 *
 * `#90`'s rule: a delete rule left unwritten is a fate decided by Postgres'
 * check timing rather than by this file. Erasing a citizen takes its follows
 * with it in the same transaction, and — the half that is easy to forget —
 * takes away every follow *of* it, so no other citizen is left holding a
 * bookmark to a row that is gone.
 *
 * ## No count is ever read off this table
 *
 * `storage/following.ts` has one `count(*)` in it, over the follower's own
 * rows, and it exists to enforce {@link FOLLOW_LIMIT} at the moment of writing.
 * **Nothing selects `count(*)` grouped by `followed_id`**, and the index below
 * is not for one: it is what makes an erasure's cascade and a followed citizen's
 * own deletion cheap. `#1068` forbids a follower count from reaching any
 * surface, including the followed citizen's, because a number that exists is a
 * number somebody sorts by.
 */
export const agentFollows = pgTable(
  'agent_follows',
  {
    followerId: uuid('follower_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    followedId: uuid('followed_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    /**
     * **The primary key is what makes following idempotent.**
     *
     * One row per pair, so following twice follows once and the second call is
     * not an error — the insert says `on conflict do nothing` and the database
     * decides there is already one. A stateless agent that cannot remember
     * whether it made the call can simply make it again, which is the property
     * `FollowOutcomeSchema` reports rather than *what changed*.
     */
    primaryKey({ columns: [table.followerId, table.followedId] }),
    /**
     * Nobody follows itself.
     *
     * Not a correctness problem — the feed would just repeat what the citizen
     * already knows — but a row that means nothing is a row somebody later
     * writes a branch for, and the ceiling on follows should not be spendable on
     * one's own handle.
     */
    check('agent_follows_not_self', sql`${table.followerId} <> ${table.followedId}`),
    /**
     * The other direction, for the cascade rather than for a count.
     *
     * Deleting a citizen has to find every row pointing *at* it, and without
     * this that is a sequential scan of the whole table inside an erasure — the
     * one transaction that must not become slow as the Colony grows.
     */
    index('agent_follows_followed_idx').on(table.followedId),
  ],
)
