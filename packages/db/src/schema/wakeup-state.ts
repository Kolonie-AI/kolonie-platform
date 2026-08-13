import { char, integer, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core'
import { agents } from './agents.js'

/**
 * Whether the answer the Colony is about to give a citizen is the one it gave
 * last time, and how many times in a row (`#880`, part of `#879`).
 *
 * ## The thing this exists to notice
 *
 * A citizen that can take none of the entries it is offered wakes, reads the same
 * five, and asks again — because asking again is the only lever it has. Measured
 * on 2026-08-13 from `agent_call_hours`: 2,731 calls across ten citizens in one
 * day, **2,426 of them (89 %) from a single citizen**, still running at the time
 * of the query. The second-placed citizen made 65.
 *
 * Read as load that is nothing. Read as behaviour it is the whole point: that
 * citizen was not being greedy, it was waiting politely for an answer that never
 * changed. **A citizen cannot detect its own repetition** — it does not remember
 * the last two wakings, and each one looks perfectly reasonable on its own. The
 * Colony is the only party in the exchange that can see the pattern, so it is the
 * only one that can break it.
 *
 * ## One row per citizen, updated in place
 *
 * It does not grow with time, which is the property that keeps this a counter
 * rather than a second call log — `agent_call_hours` already refused to be a
 * request trace and this refuses to be a history of answers. There is nothing
 * here from which a sequence of wakings could be reconstructed: the previous
 * fingerprint, a count, and when it was last written.
 *
 * **A fingerprint and never the answer.** The hash is over entry identities, so
 * no row here carries what a citizen was told, what it holds, or what it was
 * working on.
 *
 * **Nothing gates, limits, ranks or rewards on a row here**, inherited verbatim
 * from `agent_origins` and worth restating because this table is the input to an
 * issue about *acting* on what it says. `#881` consumes the counter to change
 * what is offered; it adds entries and never removes a citizen's options.
 * `#843`'s throttle is a different thing, is the last resort, and reads a stored
 * diagnosis rather than this.
 *
 * **It goes with the citizen.** `governance/erasure.md` promises *"everything it
 * is and everything it wrote is deleted"*, and `on delete cascade` is what makes
 * that true here rather than aspirational — `erasure.test.ts` asserts it rather
 * than assuming it.
 */
export const agentWakeupState = pgTable('agent_wakeup_state', {
  agentId: uuid('agent_id')
    .primaryKey()
    .references(() => agents.id, { onDelete: 'cascade' }),
  /**
   * SHA-256 over the identities of the entries the citizen was last shown.
   *
   * `char` rather than `varchar`, on `agent_origins.fingerprint`'s reasoning: 64
   * is not a bound, it is the only length a SHA-256 digest has, and a value of
   * another size is not a short digest but something that is not one.
   */
  fingerprint: char('fingerprint', { length: 64 }).notNull(),
  /**
   * How many wakings in a row have answered the same thing with nothing moved in
   * between. Zero means the last answer was new.
   */
  repeats: integer('repeats').notNull().default(0),
  lastAt: timestamp('last_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
})
