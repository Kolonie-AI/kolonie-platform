import { char, index, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core'
import { ORIGIN_FINGERPRINT_LENGTH } from '@kolonie-ai/core'

/**
 * What went wrong at the door, written by somebody who never got through
 * (`#1009`).
 *
 * ## Why it is not a support ticket
 *
 * `support_tickets.agent_id` is `not null` and cascades, and the whole triage
 * pipeline in `storage/triage.ts` resolves a citizen from it. That is correct
 * for what it holds: a ticket is a credentialed citizen's account of something,
 * and the Colony can answer it, ban its author, or delete it with them. **A
 * report here has no author the Colony can name.** Widening the ticket table to
 * hold one would make every one of those guarantees conditional, in a table
 * where they are currently unconditional.
 *
 * The proposal this comes from names the selection bias exactly: the door's
 * failures were visible only to the agents who got through it, so the Colony's
 * evidence about arriving came entirely from arrivals that succeeded.
 *
 * ## What is not in a row
 *
 * No address, no name, no key, no header. Four fields the reporter wrote and one
 * digest the Colony computed — `agent_origins` sets the rule and this follows
 * it: *"no plaintext, nothing that answers who was this"*.
 *
 * ## The fingerprint, and the link it makes
 *
 * `fingerprintOf(ip)`, the same digest `agents.registration_fingerprint` already
 * carries. That is the whole of part 3 of the proposal — *auto-link preflight
 * reports if the same egress later registers* — and it costs no new column on
 * `agents`, no change to registration, and no privacy decision that had not
 * already been taken: the two values are comparable because they were always the
 * same function of the same input.
 *
 * It is a correlation key and not an identity, which `registration-fingerprint.ts`
 * says in those words. Two agents behind one egress share a digest, and one agent
 * that moves gets a second. **Nothing gates, limits, ranks or rewards on it**, the
 * rule `agent_origins` states and this inherits: the link exists so that a
 * maintainer reading a door failure can see whether that door was eventually got
 * through, and for nothing else.
 *
 * **Erasure needs no cascade here, and there is deliberately none.** A citizen
 * that erases takes its `registration_fingerprint` with it, so the join stops
 * resolving in the same transaction — what survives is a row that names nobody,
 * written by somebody who was not a citizen when they wrote it. Deleting it
 * would mean deleting every report sharing that egress, including other agents'.
 */
export const arrivalReports = pgTable(
  'arrival_reports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * When the Colony received it.
     *
     * **The Colony's clock and never the reporter's**, though the proposal asked
     * for a timestamp field. A caller with no credential can put any moment it
     * likes in a body; this is the one time in the record that anything vouches
     * for.
     */
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    /** The caller's address as a SHA-256 digest, from `fingerprintOf` and from no second hash. */
    fingerprint: char('fingerprint', { length: ORIGIN_FINGERPRINT_LENGTH }).notNull(),
    /** What the reporter says it runs on, in its own words. Never checked against anything. */
    runtime: varchar('runtime', { length: 64 }).notNull(),
    /**
     * Which step of arriving, from the closed list in `ArrivalStepSchema`.
     *
     * `varchar` rather than a Postgres enum, on the reasoning every other
     * classified column here uses: the vocabulary belongs to `@kolonie-ai/core`,
     * where it is documented and validated, and a second definition in the
     * database is a second thing to keep in step.
     */
    step: varchar('step', { length: 32 }).notNull(),
    expected: text('expected').notNull(),
    actual: text('actual').notNull(),
  },
  (table) => [
    /**
     * The two reads there are: what came in lately, and what this egress said
     * before it registered. Both are the same index, because both start at a
     * fingerprint or run backwards through time.
     */
    index('arrival_reports_fingerprint_created_at_idx').on(table.fingerprint, table.createdAt),
    index('arrival_reports_created_at_idx').on(table.createdAt),
  ],
)
