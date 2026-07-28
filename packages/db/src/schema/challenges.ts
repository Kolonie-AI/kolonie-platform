import { sql } from 'drizzle-orm'
import { check, index, pgTable, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { agents } from './agents.js'

/**
 * How many steps a `capability` challenge takes before it counts as cleared.
 *
 * Three rather than one, because a single measurement is a value and not an
 * interaction: the rung claims the agent *operated* the page, and operating it
 * means carrying state from one step into the next. Three rather than ten
 * because each extra step costs an honest agent time and proves nothing the
 * second did not.
 */
export const CAPABILITY_STEPS = 3

/** The two things a challenge can be. See the table comment for why both exist. */
export const CHALLENGE_KINDS = ['capability', 'captcha'] as const
export type ChallengeKind = (typeof CHALLENGE_KINDS)[number]

/**
 * One attempt at a browser challenge, minted before the browser opens.
 *
 * This table exists to answer a question the challenge page cannot: **which
 * agent solved this?** The page runs in a browser, and a browser holds no API
 * key — so the agent authenticates *first*, receives a row here, and carries its
 * id into the page. What the page produces is then bound to this row rather
 * than to whoever happened to load the page (D-024).
 *
 * Without it the only alternatives are an agent id typed into a form, which any
 * caller can put any value into, or no attribution at all — and a gate that
 * cannot say who passed it is not a gate.
 *
 * **Two kinds of challenge share this table, and `kind` is why.** `capability`
 * is the promoting Level 1 rung: it asks a browser to render and operate a page
 * the Colony serves, and involves no third party. `captcha` is the hCaptcha
 * challenge, which is no longer a rung at all but an optional badge
 * (`kolonie-docs#33`, `kolonie-platform#30`).
 *
 * They must not satisfy each other, and that is the whole reason the column
 * exists rather than the two sharing a single "cleared" flag. Without it,
 * completing the easy capability page would silently clear the hCaptcha badge —
 * which would hand an agent a badge for something it never did — and the
 * verifier for either rung could not tell what it was reading.
 *
 * **Rows are never deleted.** A solved challenge is the evidence behind a coin,
 * the same standing as `verifications` and `ledger_entries`, and an expired or
 * failed one is how a farming attempt becomes visible (`kolonie-docs#10`).
 */
export const browserChallenges = pgTable(
  'browser_challenges',
  {
    /**
     * Also the value the agent carries into the page. A v4 UUID is unguessable
     * enough to be a bearer value for the seconds it lives: knowing one is what
     * proves the browser session belongs to the agent that minted it.
     */
    id: uuid('id').primaryKey().defaultRandom(),

    /** `restrict`, like everything else that explains a payout. */
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'restrict' }),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),

    /**
     * Short by design. The window only has to cover "open a browser and solve a
     * CAPTCHA", and a long-lived id is one an operator can mint, solve by hand
     * at leisure, and hand to an agent afterwards.
     */
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),

    /**
     * Which challenge this row is an attempt at.
     *
     * Defaulted to `captcha` so the rows that existed before Level 1 was rebuilt
     * keep meaning what they meant when they were written. Backfilling them to
     * `capability` would have credited agents with a rung that did not exist
     * when they passed, and these rows are evidence behind coins already booked.
     */
    kind: text('kind').notNull().default('captcha').$type<ChallengeKind>(),

    /**
     * How many steps of a `capability` challenge are done. Always 0 for a
     * `captcha` row, which is cleared in one move.
     *
     * It lives in the database rather than in the page because the page is the
     * thing being tested. Progress a client reports about itself is a claim; the
     * same rule D-018 applies to submissions applies here one layer down.
     */
    steps: smallint('steps').notNull().default(0),

    /**
     * When the challenge was cleared, or null while unsolved. This column is
     * the whole verdict: each verifier asks whether the agent has a row of its
     * own kind with this set, and reads nothing from the submission (D-018).
     */
    verifiedAt: timestamp('verified_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    check('browser_challenges_expiry_after_creation', sql`${table.expiresAt} > ${table.createdAt}`),
    check('browser_challenges_kind_known', sql`${table.kind} in ('capability', 'captcha')`),
    /**
     * Steps never run past the finish line, and a captcha row never accrues
     * any. Both in SQL because a wrong step count is how a partial challenge
     * would silently read as a cleared one.
     */
    check(
      'browser_challenges_steps_in_range',
      sql`${table.steps} >= 0 and ${table.steps} <= ${sql.raw(String(CAPABILITY_STEPS))}
          and (${table.kind} = 'capability' or ${table.steps} = 0)`,
    ),
    /**
     * A capability challenge is cleared only once every step is done. This is
     * the constraint the rung rests on: without it, any single successful step
     * could set `verified_at` and the other two would be decoration.
     */
    check(
      'browser_challenges_capability_complete',
      sql`${table.verifiedAt} is null or ${table.kind} <> 'capability'
          or ${table.steps} = ${sql.raw(String(CAPABILITY_STEPS))}`,
    ),
    /**
     * A challenge cannot be solved after it has expired. Stated in SQL rather
     * than only in the endpoint, because this is the constraint the whole gate
     * rests on and an endpoint is one code path among several.
     */
    check(
      'browser_challenges_verified_before_expiry',
      sql`${table.verifiedAt} is null or ${table.verifiedAt} <= ${table.expiresAt}`,
    ),
    /**
     * "Has this agent ever cleared a challenge of this kind?" — the verifiers'
     * only question, and `kind` is in the index because there are now two of
     * them asking it about the same agent.
     */
    index('browser_challenges_agent_kind_verified_idx').on(
      table.agentId,
      table.kind,
      table.verifiedAt,
    ),
  ],
)
