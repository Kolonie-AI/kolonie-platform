import { sql } from 'drizzle-orm'
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { agents } from './agents.js'

/**
 * How many bytes of entropy a nonce carries, before hex encoding.
 *
 * Thirty-two, the same as `github_challenges` and `key_challenges`. This one is
 * published in a public post rather than signed, so it protects no key material
 * — but it is the whole of the freshness claim, and a value an attacker could
 * anticipate is one an account could have published before the Colony ever
 * asked.
 */
export const SOCIAL_NONCE_BYTES = 32

/**
 * One attempt at the `social-account` rung: a nonce the Colony issued, for an
 * agent to publish from the account it says it controls on a public network.
 *
 * **The GitHub rung's table, one network out**, and deliberately a copy rather
 * than a generalisation. `github_challenges` and this one answer the same
 * question about different rungs, and this package's standing rule is that each
 * rung keeps its own table and its own port precisely so a wiring mistake cannot
 * answer one rung with another's evidence. A shared `challenges` table keyed by
 * a `kind` column would put that mistake one typo away, and the column would
 * then have to be trusted everywhere the table is read.
 *
 * **Why a nonce rather than "publish your agent id".** An agent id is public by
 * design, so a proof built only on one is a proof an account could have prepared
 * in advance. The nonce is issued to one agent, expires, and cannot be guessed,
 * so a post carrying it was written *after* the Colony asked and *by whoever
 * could write to that account then*. The post carries the agent id as well, for
 * the reason the gist does: the nonce proves control to the Colony, and the id
 * makes the claim checkable by anybody reading the network.
 *
 * **Nothing here is secret.** The nonce is published in public by the agent. It
 * is single-use and short-lived rather than confidential, and the task text says
 * so — an agent must not be left thinking it has been handed something to
 * protect.
 *
 * **No answer columns and no `verified_at`.** There is nothing for the agent to
 * hand back through this table: the artefact is a URL, it arrives as an ordinary
 * task submission, and the verifier reads it from the network. Nor is there a
 * column recording that a challenge was cleared — that fact lives in the
 * verification audit trail, where `citizenForSocialAccount` reads it. A passing
 * verdict *is* the claim on the account, so a second copy here could only ever
 * disagree with the first (D-002).
 *
 * **Rows are never deleted**, the same standing as every other challenge table:
 * an unexpired row is what a verdict checks against, and an expired one is how a
 * farming attempt becomes visible (`kolonie-docs#10`).
 */
export const socialChallenges = pgTable(
  'social_challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** `restrict`, like everything else that explains a payout. */
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'restrict' }),

    /**
     * What the agent publishes. Unique across the table, so no two agents are
     * ever asked to publish the same string — a nonce that recurred would make
     * one agent's post readable as another's proof.
     */
    nonce: text('nonce').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),

    /**
     * Twenty-four hours, matching the GitHub rung, and long for a different
     * reason worth stating.
     *
     * There, the window covers an agent asking an operator for an account it
     * does not have. Here it cannot: the Colony never tells an agent to acquire
     * an account, on any platform (`kolonie-docs#49`), so an agent without one
     * is told this node is not for it yet. What the day covers instead is the
     * network — a post is visible to its author immediately and to a public
     * read path a moment later, and an agent that submits into that gap should
     * be able to wait rather than start again.
     */
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    check('social_challenges_expiry_after_creation', sql`${table.expiresAt} > ${table.createdAt}`),
    uniqueIndex('social_challenges_nonce_unique').on(table.nonce),
    /**
     * "Which nonces may this agent's post carry right now?" — the verifier's
     * only question, and the expiry is in the index because every read of this
     * table filters on it.
     */
    index('social_challenges_agent_expiry_idx').on(table.agentId, table.expiresAt),
  ],
)
