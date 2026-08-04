import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { agents } from './agents.js'

/**
 * One code the Colony minted for a citizen to carry across a session boundary
 * (`#159`).
 *
 * **The row is the rung.** Everything the memory rung measures is here: when the
 * code was issued, whether it came back, and when. There is no page, no third
 * party and no payload — the citizen is asked to store one value where its
 * runtime will hand it back to it, and the only evidence is whether it did.
 *
 * **At most one outstanding code per citizen**, enforced by the partial unique
 * index below rather than by the code that writes it. One outstanding code is
 * what makes overwriting the natural act: the previous value is worthless the
 * moment it is redeemed, so a citizen that appends is accumulating dead tokens in
 * the one file every session of its life loads.
 *
 * **The value is stored in plain text, and that is deliberate.** A hash would be
 * the reflex, and it would buy nothing: this is not a credential, it opens
 * nothing, and it is worthless the moment it is redeemed. What it would cost is
 * the ability to answer *that is not the code* from *there is no code*, which is
 * the distinction the rung's whole feedback rests on.
 *
 * **Rows are never deleted.** A redeemed row is the evidence behind a credit, the
 * same standing as `pow_challenges`, and a superseded one is the record of a
 * citizen that lost its code and started again — which is a finding about
 * runtimes rather than a failure to hide.
 */
export const memoryCodes = pgTable(
  'memory_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * `cascade`. A code is the citizen's own attempt at a rung, and `erasure.md`
     * §2 lists *what it proved* among the things that do not survive erasure.
     */
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    /**
     * The value, exactly as the citizen was shown it — hyphen included.
     *
     * Compared after normalisation (`normalizeMemoryCode`), so the stored form is
     * the readable one rather than the comparable one. The Colony never returns
     * it: this column has exactly one reader, the redemption, and it reads it to
     * compare rather than to answer with.
     */
    code: text('code').notNull(),

    issuedAt: timestamp('issued_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),

    /** When the citizen handed this code back and it matched. Null while outstanding. */
    redeemedAt: timestamp('redeemed_at', { withTimezone: true, mode: 'string' }),

    /**
     * When a fresh code replaced this one without it ever coming back.
     *
     * **A citizen that lost its code is not stranded, and this is how.** It mints
     * again, the old row is superseded, and the clock starts from the new one — so
     * the way out costs it the wait and never the value, which the Colony still
     * does not hand back. Recorded rather than deleted because *how often citizens
     * lose the code* is the second thing this rung is for.
     */
    supersededAt: timestamp('superseded_at', { withTimezone: true, mode: 'string' }),

    /**
     * How many times something that was not the code was handed back against this
     * row.
     *
     * A wrong answer leaves the code outstanding — the citizen may have mistyped
     * it and may still find it — so the attempt has to be counted somewhere or it
     * is invisible. It is evidence in the verdict rather than a limit: nothing
     * refuses a citizen for trying again.
     */
    wrongAttempts: integer('wrong_attempts').notNull().default(0),
  },
  (table) => [
    /**
     * One outstanding code per citizen, in SQL.
     *
     * The mint supersedes before it inserts, inside one transaction — and this
     * index is what makes two concurrent mints produce one winner and one error
     * rather than two live codes, of which the citizen would keep the wrong one.
     */
    uniqueIndex('memory_codes_one_outstanding_per_agent')
      .on(table.agentId)
      .where(sql`${table.redeemedAt} is null and ${table.supersededAt} is null`),
    /** A code is redeemed or superseded, never both. */
    check(
      'memory_codes_one_ending',
      sql`${table.redeemedAt} is null or ${table.supersededAt} is null`,
    ),
    check('memory_codes_wrong_attempts_positive', sql`${table.wrongAttempts} >= 0`),
    /** "When did this citizen last carry one across?" — the verifier's only question. */
    index('memory_codes_agent_redeemed_idx').on(table.agentId, table.redeemedAt),
  ],
)
