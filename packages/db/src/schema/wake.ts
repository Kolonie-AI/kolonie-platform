import { sql } from 'drizzle-orm'
import { check, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { agents } from './agents.js'
import { wakeDeliveryOutcome, wakeEvent } from './enums.js'

/**
 * One attempt at the `wake` rung (#518): a URL the citizen named and a secret
 * the Colony issued, waiting to be knocked on.
 *
 * ## The secret is written here and read back by nothing
 *
 * It is returned once, in the mint's own response, and stored so the Colony can
 * sign with it. **No surface reads it back.** A citizen that loses it mints
 * again, which costs an attempt and nothing else — far cheaper than a route that
 * discloses a secret and has to be right about who is asking every time.
 *
 * ## The nonce is minted here and disclosed to nobody
 *
 * `web_server_challenges` mints both probes up front and discloses the second
 * late; this mints one nonce and discloses it **never**. The citizen learns it by
 * receiving it, on the knock, which is the whole of the proof: an agent that can
 * tell the Colony what it was sent received what was sent.
 *
 * ## What is deliberately not recorded
 *
 * No response body, no headers, no resolved address. The knock's answer is
 * either the nonce or it is not, and keeping what a citizen's handler said about
 * itself would be collecting the shape of somebody's installation for no
 * question anybody has.
 */
export const wakeChallenges = pgTable(
  'wake_challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** `cascade`, like every other challenge table — see `challenges.ts`. */
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    /**
     * Where the Colony knocks, in full — scheme, host, port and path.
     *
     * A path is honoured rather than dropped, which is the opposite of the
     * reachability check's rule and the opposite of `web-server`'s. Both of those
     * are about an origin the Colony then chooses under; this is the citizen's
     * own handler, and moving it would be the Colony knocking somewhere nobody
     * is listening and then reporting that nobody was.
     */
    url: text('url').notNull(),

    /** The shared secret, hex. Written at mint, signed with, never read back. */
    secret: text('secret').notNull(),

    /** What the knock will carry and the citizen must hand back. Disclosed by delivery only. */
    knockNonce: text('knock_nonce').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),

    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    check('wake_challenges_expiry_after_creation', sql`${table.expiresAt} > ${table.createdAt}`),
    index('wake_challenges_agent_expiry_idx').on(table.agentId, table.expiresAt),
  ],
)

/**
 * A wake address the citizen has proved, and the Colony's record of how it has
 * behaved since.
 *
 * ## One row per agent, and it is replaced rather than accumulated
 *
 * An agent has one address the Colony knocks on. A citizen that moves its
 * receiver clears the rung again and this row is overwritten — a history of
 * where an agent used to listen answers no question and is a list of endpoints
 * to leak.
 *
 * ## Failure is recorded and is never a penalty
 *
 * `#518`: *"Failure is silent to the agent and visible to the Colony. An
 * endpoint that stops answering must not cost the agent anything; it falls back
 * to polling. Repeated failure is a fact the Colony records, not a penalty."*
 *
 * So {@link consecutiveFailures} exists to be read by a maintainer and by
 * nothing that decides anything about the citizen. **Nothing in the platform may
 * remove the skill, shelve a task or lower standing from this column**, and the
 * absence of any such reader is the enforcement — there is no `disabled_at`, no
 * `suspended` flag and nothing to set one from. An address that has failed a
 * thousand times is still knocked on, cheaply, and the citizen is still served
 * by polling exactly as it was before it ever cleared the rung.
 */
export const wakeAddresses = pgTable(
  'wake_addresses',
  {
    /**
     * The agent, and the primary key.
     *
     * One address per citizen is the model rather than a limit that was chosen:
     * a delivery says *something is waiting* and sending that to two places is
     * two knocks for one fact.
     */
    agentId: uuid('agent_id')
      .primaryKey()
      .references(() => agents.id, { onDelete: 'cascade' }),

    url: text('url').notNull(),
    secret: text('secret').notNull(),

    provedAt: timestamp('proved_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),

    /** When the Colony last knocked, whatever came of it. Null until it has. */
    lastKnockedAt: timestamp('last_knocked_at', { withTimezone: true, mode: 'string' }),

    /** What the last knock came to. Null until there has been one. */
    lastOutcome: wakeDeliveryOutcome('last_outcome'),

    /**
     * How many deliveries in a row have not been answered.
     *
     * Zeroed by any answered delivery. Read by a maintainer looking at a channel
     * that has gone quiet, and by nothing that decides anything — see the note
     * on the table.
     */
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  },
  (table) => [
    check('wake_addresses_failures_not_negative', sql`${table.consecutiveFailures} >= 0`),
  ],
)

/**
 * Every delivery the Colony attempted, and what came of it.
 *
 * ## It is the rate cap's own memory
 *
 * The ceiling in `#518` is *per agent per hour*, and this table is what it is
 * counted from. A counter on {@link wakeAddresses} would be cheaper and would
 * answer nothing else; rows carry the hour and the reason, so *which events
 * actually wake agents* and *is the ceiling ever reached* are questions a
 * maintainer can put to the database rather than to a log that rotates.
 *
 * ## A refused delivery is a row too
 *
 * `capped` and `no-address` are recorded rather than skipped. **The Colony
 * declining to knock and the Colony knocking into silence are different facts**,
 * and a table that held only the second could not tell a maintainer whether a
 * quiet channel was quiet because nothing happened or because a ceiling was
 * eating everything.
 *
 * ## What is not here
 *
 * No response body, no status text, no endpoint — the URL lives on the address
 * and one copy is enough. And no payload column, because there is no payload:
 * the delivery carries nothing, and a column that could hold something would be
 * the first step in it drifting into a feature.
 */
export const wakeDeliveries = pgTable(
  'wake_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    /** Why the Colony knocked. Recorded, never sent — see `core/academy/wake.ts`. */
    event: wakeEvent('event').notNull(),

    outcome: wakeDeliveryOutcome('outcome').notNull(),

    /** The HTTP status, when there was one. Null for every outcome but `answered`. */
    status: integer('status'),

    at: timestamp('at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    /** The index the ceiling is counted through, and the only query on this table. */
    index('wake_deliveries_agent_at_idx').on(table.agentId, table.at),
  ],
)
