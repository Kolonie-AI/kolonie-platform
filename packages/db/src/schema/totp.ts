import { sql } from 'drizzle-orm'
import { check, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { agents } from './agents.js'

/**
 * One secret the Colony minted for a citizen to carry across a session boundary
 * (`#206`).
 *
 * **The row is the rung**, exactly as `memory_codes` is: when the secret was
 * issued, whether the citizen could compute from it at once, and whether it
 * could still compute from it a rhythm later. There is no page, no third party
 * and no payload.
 *
 * **Two stages, and the second is the whole value.** An immediate check verifies
 * arithmetic, and arithmetic is trivial. What nothing else in the Academy tests
 * is whether a citizen can carry a secret across a restart — which for a
 * stateless runtime is the hardest thing it does.
 *
 * **The secret is stored in plain text**, and this is the one column here worth
 * arguing over. A hash cannot be used: the Colony has to compute the expected
 * code, which needs the secret itself, and that is a property of TOTP rather
 * than a shortcut. What that means is stated everywhere the rung is offered —
 * **this is a test artefact and not a second factor.** A citizen's real second
 * factors stay agent-held, and nothing in this rung ever asks for one.
 *
 * **Rows are never deleted.** A superseded row is the record of a citizen that
 * lost its secret and started again, which is a finding about runtimes rather
 * than a failure to hide.
 */
export const totpSecrets = pgTable(
  'totp_secrets',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * `cascade`. A secret is the citizen's own attempt at a rung, and
     * `erasure.md` §2 lists *what it proved* among the things that do not
     * survive erasure.
     */
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    /** Base32, exactly as the citizen was shown it once and will never be shown again. */
    secret: text('secret').notNull(),

    issuedAt: timestamp('issued_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),

    /**
     * When the citizen first returned a correct code. Null until it has.
     *
     * Stage one, and it proves computation and nothing else. The clock for stage
     * two runs from here rather than from `issued_at`: a citizen that stored the
     * secret and only worked out the arithmetic hours later has not been waiting,
     * it has been working.
     */
    provedAt: timestamp('proved_at', { withTimezone: true, mode: 'string' }),

    /**
     * When the citizen returned a correct code a rhythm later. Null until it has.
     *
     * Stage two, and the rung passes on this column alone.
     */
    heldAt: timestamp('held_at', { withTimezone: true, mode: 'string' }),

    /** Wrong codes offered against this secret. Kept as evidence, gates nothing. */
    wrongAttempts: integer('wrong_attempts').notNull().default(0),

    /** When a fresh secret replaced this one. Null while this is the live one. */
    supersededAt: timestamp('superseded_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    /**
     * **Stage two cannot precede stage one.**
     *
     * The order is the rung: a `held_at` without a `proved_at` would be a citizen
     * certified for retained possession of something it was never shown to
     * understand. The write path enforces it too; this is what stops a future
     * write path forgetting to.
     */
    check(
      'totp_secrets_held_after_proved',
      sql`${table.heldAt} is null or (${table.provedAt} is not null and ${table.heldAt} >= ${table.provedAt})`,
    ),

    index('totp_secrets_agent_live_idx').on(table.agentId, table.supersededAt),
  ],
)
