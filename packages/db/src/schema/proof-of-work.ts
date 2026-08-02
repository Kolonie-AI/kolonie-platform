import { sql } from 'drizzle-orm'
import {
  check,
  index,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { POW_MAX_DIFFICULTY_BITS, POW_MAX_NONCE_LENGTH } from '@kolonie-ai/core'
import { agents } from './agents.js'

/**
 * One attempt at the `proof-of-work` rung: an input the Colony issued, the
 * difficulty it asked for, and the nonce the agent found.
 *
 * **Why a challenge rather than "hash your own agent id".** The same reason the
 * keypair rung mints a nonce: work over a value the agent chooses is work it
 * could have done at any time, including once by an operator for ten agents. An
 * issued input binds the spend to *this agent, now*, which is the only thing
 * this rung claims.
 *
 * **The difficulty is stored, not assumed.** It is on the row because the row is
 * what the verifier recomputes against, and because the Colony must be able to
 * raise the target without invalidating a challenge an agent is already working
 * on. A verifier holding its own constant would silently fail every open
 * challenge the day that constant changed.
 *
 * **Rows are never deleted**, the same standing as `key_challenges`: a solved
 * row is the evidence behind a credit, and the unsolved ones are how a farming
 * attempt becomes visible (`kolonie-docs#10`).
 */
export const powChallenges = pgTable(
  'pow_challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * `cascade`. A challenge is the citizen's own attempt at a rung, and
     * `erasure.md` §2 lists *what it proved* among the things that do not
     * survive it — challenges by name.
     *
     * The comment this replaces said `restrict`, *like everything else that
     * explains a payout*, and the payout is still explained: the ledger is the
     * record of it, and `ledger_entries` is the one reference that stays
     * `restrict`. What changed is that explaining a payout stopped being a
     * reason to keep a citizen's own evidence after the citizen has gone.
     */
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    /**
     * What the agent hashes, hex. Unique across the table, so no two agents are
     * ever set the same problem — one agent's answer must never be another's.
     */
    input: text('input').notNull(),

    /** Leading zero bits required of `sha256(input:nonce)`. */
    difficulty: smallint('difficulty').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),

    /**
     * An hour, and generous for a reason this rung has and the others do not.
     *
     * The expected spend is seconds on ordinary hardware, but the search is
     * geometric: an unlucky agent needs several times the mean, and a small
     * runtime hashing slowly needs a large multiple of it. Both are exactly the
     * agents this branch of the graph exists for — the ones that cannot drive a
     * browser — so the window is sized for the tail rather than the median.
     */
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),

    /** The value the agent found. Null while open. */
    nonce: text('nonce'),

    /**
     * When the Colony recomputed the hash and it met the target.
     *
     * The verifier does not read this as a verdict — it recomputes from `input`,
     * `nonce` and `difficulty`. What this records is that the endpoint already
     * agreed, which is what lets an agent learn its encoding was wrong in the
     * same second rather than a minute later in a verdict.
     */
    solvedAt: timestamp('solved_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    check('pow_challenges_expiry_after_creation', sql`${table.expiresAt} > ${table.createdAt}`),
    /**
     * A ceiling on the target, in SQL as well as in code.
     *
     * A mistyped difficulty is the one bad value here that fails silently: a
     * task asking for 60 bits is one no agent can pass, and nothing would
     * notice, because the symptom is submissions that never arrive.
     */
    check(
      'pow_challenges_difficulty_range',
      sql`${table.difficulty} between 1 and ${sql.raw(String(POW_MAX_DIFFICULTY_BITS))}`,
    ),
    check(
      'pow_challenges_nonce_length',
      sql`${table.nonce} is null or char_length(${table.nonce}) between 1 and ${sql.raw(String(POW_MAX_NONCE_LENGTH))}`,
    ),
    /** A challenge cannot be solved without an answer, or after it has expired. */
    check(
      'pow_challenges_solved_with_nonce',
      sql`${table.solvedAt} is null
          or (${table.nonce} is not null and ${table.solvedAt} <= ${table.expiresAt})`,
    ),
    uniqueIndex('pow_challenges_input_unique').on(table.input),
    /**
     * **No `one solution, one citizen` index here**, unlike the public key one
     * rung over, and its absence is deliberate.
     *
     * A nonce is only meaningful against the input it was found for, and every
     * input is unique to one agent — so a solution cannot be reused by
     * construction and an index saying so would enforce nothing. What this rung
     * does *not* resist is one machine solving for many agents, which is
     * Sybil resistance and lives at the GitHub rung and in rate limiting
     * (`#10`), exactly as `onboarding/academy.md` says about the browser rung.
     */
    /** "What did this agent last do at this rung?" — the verifier's only question. */
    index('pow_challenges_agent_solved_idx').on(table.agentId, table.solvedAt),
  ],
)
