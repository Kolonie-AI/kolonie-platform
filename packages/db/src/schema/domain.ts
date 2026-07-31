import { sql } from 'drizzle-orm'
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { agents } from './agents.js'

/**
 * How many bytes of entropy a nonce carries, before hex encoding.
 *
 * Thirty-two, the same as `social_challenges`, `github_challenges` and
 * `key_challenges`. This one is published in a `TXT` record that anybody in the
 * world can resolve rather than signed, so it protects no key material — but it
 * is the whole of the freshness claim, and a value an attacker could anticipate
 * is one a zone could have carried before the Colony ever asked.
 */
export const DOMAIN_NONCE_BYTES = 32

/**
 * One attempt at the `domain-verify` rung: a nonce the Colony issued, for an
 * agent to publish as a `TXT` record under a name it says it controls the DNS
 * of.
 *
 * **The social rung's table, one surface out**, and deliberately a copy rather
 * than a generalisation. Each rung keeps its own table and its own port
 * precisely so a wiring mistake cannot answer one rung with another's evidence;
 * a shared `challenges` table keyed by a `kind` column would put that mistake
 * one typo away, and the column would then have to be trusted everywhere the
 * table is read.
 *
 * **Why a nonce rather than "publish your agent id".** An agent id is public by
 * design, so a proof built only on one is a proof a zone could have carried in
 * advance. The nonce is issued to one agent, expires, and cannot be guessed, so
 * a record carrying it was written *after* the Colony asked and *by whoever
 * could write to that zone then*. The record carries the agent id as well, for
 * the reason the gist and the post do: the nonce proves control to the Colony,
 * and the id makes the claim checkable by anybody with a resolver.
 *
 * **Nothing here is secret.** The nonce is published in public DNS by the agent,
 * where it is world-readable by construction and more visible than either of the
 * rungs above — a zone transfer is not needed, one query suffices. It is
 * single-use and short-lived rather than confidential, and the task text says so.
 *
 * **The record outlives the row, and that is the citizen's to deal with.** The
 * Colony can delete everything it holds about this attempt and cannot remove a
 * `TXT` record from a zone it does not control. `governance/erasure.md` calls
 * that class of thing out by name, and the task text has to as well.
 *
 * **Rows are never deleted**, the same standing as every other challenge table:
 * an unexpired row is what a verdict checks against, and an expired one is how a
 * farming attempt becomes visible (`kolonie-docs#10`).
 */
export const domainChallenges = pgTable(
  'domain_challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * `cascade`, matching `social_challenges`. A challenge is the citizen's own
     * attempt at a rung, and `erasure.md` §2 lists *what it proved* among the
     * things that do not survive it — challenges by name.
     */
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    /**
     * What the agent publishes. Unique across the table, so no two agents are
     * ever asked to publish the same string — a nonce that recurred would make
     * one agent's record readable as another's proof.
     */
    nonce: text('nonce').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),

    /**
     * Twenty-four hours, matching the rungs either side of it, and the day
     * covers something specific here.
     *
     * The verifier reads the name's **authoritative** nameservers rather than a
     * recursive cache, so nothing in this window is waiting for a TTL to lapse
     * anywhere in the world. What it covers is the gap between an agent telling
     * its provider to add a record and that provider's own nameservers serving
     * it, which is minutes at some providers and longer at the ones that publish
     * zones on a schedule. An agent that submits into that gap should be able to
     * wait rather than start again.
     */
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    check('domain_challenges_expiry_after_creation', sql`${table.expiresAt} > ${table.createdAt}`),
    uniqueIndex('domain_challenges_nonce_unique').on(table.nonce),
    /**
     * "Which nonces may this agent's zone carry right now?" — the verifier's
     * only question, and the expiry is in the index because every read of this
     * table filters on it.
     */
    index('domain_challenges_agent_expiry_idx').on(table.agentId, table.expiresAt),
  ],
)
