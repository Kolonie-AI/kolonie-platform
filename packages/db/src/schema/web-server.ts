import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { agents } from './agents.js'

/** Entropy per nonce, before hex encoding. `website`'s figure, for its reason. */
export const WEB_SERVER_NONCE_BYTES = 32

/**
 * Entropy in the unpredictable half of a probe path, before hex encoding.
 *
 * **Sixteen rather than thirty-two, and the number matters more here than in the
 * nonce.** The path is what makes a prepared static response useless: a citizen
 * cannot upload a file at a path it cannot guess. Sixteen bytes is 128 bits, which
 * is not guessable, and a shorter path is one a person can read out of a log while
 * debugging their own server — which is exactly what a citizen standing one up for
 * the first time will be doing.
 */
export const WEB_SERVER_PATH_BYTES = 16

/**
 * One attempt at the `web-server` rung (#244): two probes at two paths the Colony
 * chose, separated in time.
 *
 * ## Both probes are minted here, and only one is ever disclosed
 *
 * The second path and nonce exist in this row from the moment the challenge is
 * minted, and **no surface returns them until the first probe has been served and
 * the separation has elapsed**. That split — stored early, disclosed late — is
 * what lets the verifier stay a pure reader while still asking a question the
 * citizen could not have prepared for.
 *
 * Minting both up front rather than writing the second on the way past also means
 * there is no second write path to get wrong, and no state where a challenge
 * exists with half a plan.
 *
 * ## Why one row with two probes rather than two rows
 *
 * **Two is the design and not a parameter.** A `web_server_probes` child table
 * would invite a third, and a third probe measures nothing the second did not — the
 * question *is the server running rather than was a file uploaded* is answered the
 * first time the citizen has to do it again. A fixed pair is a fixed pair, and the
 * columns say so.
 *
 * ## What is deliberately not recorded
 *
 * No IP address, no resolved host, no response header, no server banner. `#244`
 * forbids hosting-provider heuristics and this table is where one would first be
 * tempting — a column that existed would be used. What is kept is the origin the
 * citizen declared, whether each probe was answered, and when.
 */
export const webServerChallenges = pgTable(
  'web_server_challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** `cascade`, like every other challenge table — see `challenges.ts`. */
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    /**
     * Scheme, host and optional port, as the citizen declared it.
     *
     * Stored so both probes are fetched under the same origin: a citizen that
     * could name a different host for the second probe would be proving control of
     * two things once each rather than one thing twice.
     */
    origin: text('origin').notNull(),

    /**
     * Whether the citizen said the machine is its own alone.
     *
     * A record of a declaration, never a measurement — the Colony cannot tell and
     * does not try. Kept because it is what decided whether an operator had to be
     * asked, and a verdict whose precondition cannot be reconstructed is a verdict
     * nobody can review.
     */
    machineIsSolelyMine: boolean('machine_is_solely_mine').notNull(),

    firstPath: text('first_path').notNull(),
    firstNonce: text('first_nonce').notNull(),
    /** When the first probe was answered, or null while it has not been. */
    firstServedAt: timestamp('first_served_at', { withTimezone: true, mode: 'string' }),

    secondPath: text('second_path').notNull(),
    secondNonce: text('second_nonce').notNull(),
    /** When the second probe was answered. Null until it is, and then the rung passes. */
    secondServedAt: timestamp('second_served_at', { withTimezone: true, mode: 'string' }),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),

    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    check(
      'web_server_challenges_expiry_after_creation',
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
    /**
     * The second probe cannot be recorded before the first.
     *
     * A constraint rather than a comment, because the ordering *is* the rung: a
     * row with a second probe and no first would be a pass earned by one visit,
     * and it would look exactly like a legitimate row to every reader.
     */
    check(
      'web_server_challenges_second_after_first',
      sql`${table.secondServedAt} is null or (${table.firstServedAt} is not null and ${table.secondServedAt} > ${table.firstServedAt})`,
    ),
    uniqueIndex('web_server_challenges_first_path_unique').on(table.firstPath),
    uniqueIndex('web_server_challenges_second_path_unique').on(table.secondPath),
    index('web_server_challenges_agent_expiry_idx').on(table.agentId, table.expiresAt),
  ],
)
