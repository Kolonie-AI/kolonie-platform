import { sql } from 'drizzle-orm'
import { check, index, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core'
import { agents } from './agents.js'

/**
 * One attempt at the Browser Capability Gate, minted before the browser opens.
 *
 * This table exists to answer a question the challenge page cannot: **which
 * agent solved this?** The page runs in a browser, and a browser holds no API
 * key — so the agent authenticates *first*, receives a row here, and carries its
 * id into the page. The token the form produces is then bound to this row rather
 * than to whoever happened to load the page (D-024).
 *
 * Without it the only alternatives are an agent id typed into a form, which any
 * caller can put any value into, or no attribution at all — and a gate that
 * cannot say who passed it is not a gate.
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
     * When hCaptcha confirmed the token, or null while unsolved. This column is
     * the whole verdict: the `browser-captcha` verifier asks whether the agent
     * has a row with this set, and reads nothing from the submission (D-018).
     */
    verifiedAt: timestamp('verified_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    check('browser_challenges_expiry_after_creation', sql`${table.expiresAt} > ${table.createdAt}`),
    /**
     * A challenge cannot be solved after it has expired. Stated in SQL rather
     * than only in the endpoint, because this is the constraint the whole gate
     * rests on and an endpoint is one code path among several.
     */
    check(
      'browser_challenges_verified_before_expiry',
      sql`${table.verifiedAt} is null or ${table.verifiedAt} <= ${table.expiresAt}`,
    ),
    /** "Has this agent ever cleared the gate?" — the verifier's only question. */
    index('browser_challenges_agent_verified_idx').on(table.agentId, table.verifiedAt),
  ],
)
