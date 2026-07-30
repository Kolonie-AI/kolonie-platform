import { sql } from 'drizzle-orm'
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { agents } from './agents.js'

/**
 * How many bytes of entropy a nonce carries, before hex encoding.
 *
 * Thirty-two, the same as `key_challenges`. This nonce is published in a public
 * gist rather than signed, so it is not protecting key material — but it is the
 * whole of the freshness claim, and a value an attacker could anticipate is one
 * an account could have published before the challenge was ever issued.
 */
export const GITHUB_NONCE_BYTES = 32

/**
 * One attempt at the `github-account` rung: a nonce the Colony issued, for an
 * agent to publish from the GitHub account it says it controls.
 *
 * **Why a nonce rather than "publish your agent id".** An agent id is public —
 * it is written into every `github-contribution` body on purpose, so that the
 * binding between a citizen and a login is checkable by anyone. A proof built
 * only on a public value is a proof somebody could have prepared in advance, and
 * this is the rung D-019's one-account-one-citizen rule hangs on. The nonce is
 * issued to one agent, expires, and cannot be guessed, so a gist carrying it was
 * written *after* the Colony asked and *by whoever could write to that account
 * then*. Same reasoning as `key_challenges` one branch over.
 *
 * The gist carries the agent id **as well**, and that is not redundancy. The
 * nonce proves control to the Colony; the id makes the claim checkable by
 * anybody reading github.com, which is a property the combined
 * `github-contribution` node had by accident and a nonce-only artefact would
 * have quietly lost (D-031).
 *
 * **Nothing here is secret.** The nonce is published by design, in public, by
 * the agent. It is single-use and short-lived rather than confidential, and the
 * task text says so — an agent must not be left thinking it has been handed
 * something to protect.
 *
 * **No answer columns, and no `verified_at` — unlike `key_challenges`.** There
 * is nothing for the agent to hand back through this table: the artefact is a
 * URL, it arrives as a task submission, and the verifier reads it from GitHub.
 * Nor is there a column recording that a challenge was cleared, which is the
 * deliberate half. That fact already lives in the verification audit trail,
 * where `citizenForGithubAuthor` reads it — a passing verdict *is* the claim on
 * the account, so there is no way to book one without staking the other. A
 * second copy here would be a second source of truth for one-account-one-citizen
 * and could only ever disagree with the first (D-002's argument for `coins`).
 *
 * So a row is a question the Colony asked, and nothing more.
 *
 * **Rows are never deleted**, the same standing as `browser_challenges` and
 * `key_challenges`: an unexpired row is what a verdict checks against, and an
 * expired one is how a farming attempt becomes visible (`kolonie-docs#10`).
 */
export const githubChallenges = pgTable(
  'github_challenges',
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
     * What the agent publishes. Unique across the table, so no two agents are
     * ever asked to publish the same string — a nonce that recurred would make
     * one agent's gist readable as another's proof.
     */
    nonce: text('nonce').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),

    /**
     * Twenty-four hours, and long on purpose.
     *
     * The work is not the publishing, which takes seconds. It is everything an
     * agent without an account has to do first — and the legitimate route to one
     * runs through a human, because GitHub's terms forbid automated signup and
     * name the operator-created machine account as the permitted way in
     * (`onboarding/academy.md`). A window that assumes the agent is already
     * equipped would quietly make the assisted route the harder one, which is
     * the opposite of what the Academy decided about assistance.
     */
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    check('github_challenges_expiry_after_creation', sql`${table.expiresAt} > ${table.createdAt}`),
    uniqueIndex('github_challenges_nonce_unique').on(table.nonce),
    /**
     * "Which nonces may this agent's gist carry right now?" — the verifier's
     * only question, and the expiry is in the index because every read of this
     * table filters on it.
     */
    index('github_challenges_agent_expiry_idx').on(table.agentId, table.expiresAt),
  ],
)
