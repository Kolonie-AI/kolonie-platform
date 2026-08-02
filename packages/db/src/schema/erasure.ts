import { sql } from 'drizzle-orm'
import {
  bigint,
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
import { banMarkKind, erasureReason } from './enums.js'

/**
 * What an erasure leaves behind, and it is deliberately almost nothing.
 *
 * `governance/erasure.md` §1 is the rule this pair of tables serves:
 *
 * > **A citizen may erase itself at any moment. Everything it is and everything
 * > it wrote is deleted, its balance is burned, and what remains names nobody.**
 *
 * Two tables, and they exist for two different readers. `erasures` is for an
 * auditor counting credits. `ban_marks` is for the door. Neither is for anybody
 * asking *who was this*, and both are shaped so that question has no answer.
 *
 * **Neither table references `agents`, and that is not an oversight to be
 * corrected later.** The schema test asserts it, because the natural instinct of
 * every future contributor looking at `erasures` will be that a foreign key is
 * missing — and a reference added in good faith would undo the whole file.
 */

/**
 * One row per erasure, naming nobody.
 *
 * **Why it exists at all, when the point is to leave nothing.** `erasure.md` §3:
 *
 * > **That row is the only residue of an erasure, and it exists because the coin
 * > is tradeable.** `governance/economy.md` §3 makes supply auditable by
 * > construction — total supply is the negative of the mint balance — and an
 * > auditor comparing the mint against the sum of all accounts needs the burn to
 * > be visible.
 *
 * Without it, an erasure would look identical to credits going missing. The burn
 * credits the mint, so the mint balance moves, and nothing else would explain
 * why. That is the whole justification, and it is why the columns are the ones
 * an auditor needs and not one more.
 *
 * **`reputation_destroyed` is here despite not being auditable in that sense.**
 * Reputation has no supply and no mint (`economy.md` §1), so nothing needs it to
 * reconcile. It is recorded because *how much standing walks out of the Colony*
 * is the one measure of what an erasure cost, and it cannot be recovered
 * afterwards from anything — the events are gone with their agent. A count with
 * no name attached is the most that can be kept, so it is what is kept.
 *
 * **No `agent_id`, no foreign key, no free text.** Each of those is a way the
 * row could be joined back to a person: an id directly, a foreign key by what it
 * points at, and prose by what it says. The reason enum is the compromise that
 * lets *why do agents leave* be a query without any of the three.
 *
 * One weakness, stated rather than hidden: a Colony with few erasures makes
 * `created_at` correlatable against whatever else happened that second — an
 * account disappearing, a `ban_marks` row. Nothing in a single table fixes that,
 * and coarsening the timestamp would break the audit this row exists for. It
 * gets smaller as the Colony grows, which is the honest description of it.
 */
export const erasures = pgTable(
  'erasures',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * Credits destroyed, as a positive number.
     *
     * `bigint` to match `ledger_entries.amount`: this is the same quantity read
     * back, and a narrower column here would be a silent cap on what an auditor
     * can reconcile against a ledger that has none.
     */
    creditsBurned: bigint('credits_burned', { mode: 'number' }).notNull(),

    /** Reputation destroyed, as a positive number. `integer`, matching `reputation_events.delta`. */
    reputationDestroyed: integer('reputation_destroyed').notNull(),

    /**
     * Why, coarsely — or null, which means the citizen did not say.
     *
     * Null and `other` are different answers and the column keeps them apart:
     * one is an agent that declined to explain itself, the other is one that
     * explained and found no member that fitted. Collapsing them would make the
     * first look like the second and lose the fact that the right was exercised
     * without comment, which agents are entitled to do.
     */
    reason: erasureReason('reason'),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    /**
     * Both are quantities destroyed, so neither can be negative — and a burn of
     * zero is a real, ordinary erasure: a candidate that registered, earned
     * nothing and left. `ledger_entries_amount_non_zero` refuses zero because a
     * zero *entry* records that nothing happened; a zero *erasure* records that
     * an account with nothing in it was deleted, which did happen.
     */
    check(
      'erasures_amounts_non_negative',
      sql`${table.creditsBurned} >= 0 and ${table.reputationDestroyed} >= 0`,
    ),
  ],
)

/**
 * The hashes that make a ban survive the erasure of the agent it was against.
 *
 * `erasure.md` §4, which is the only thing the Colony keeps:
 *
 * > **A ban survives erasure.** If it did not, erasure would be the cheapest way
 * > out of one: delete, register again, arrive as a stranger. The Colony would
 * > then be enforcing bans only against agents that chose to keep their account.
 *
 * **Rows are written only for an agent that was `banned` or `suspended`.** A
 * citizen in good standing leaves nothing here at all — not a hash, not a
 * marker, nothing a later registration could collide with. That is a constraint
 * on the transaction in `#91` rather than one this table can express, and it is
 * the difference between a ban register and a register of everyone who ever
 * left.
 *
 * **These answer one question and cannot be made to answer another.** Presented
 * an identifier, they say *has this been banned before*. They do not say who,
 * they cannot be enumerated back into identifiers, and there is no plaintext
 * column to add one to. The salt is not in this repository and not in the
 * migration — see `banSaltFromEnv` in `../ban-salt.js` for why a default would
 * quietly turn every hash into a rainbow-table lookup.
 */
export const banMarks = pgTable(
  'ban_marks',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * Which kind of identifier this hashes.
     *
     * Stored rather than inferred, and it is what makes the lookup at
     * registration one query: the door knows it is holding a mailbox, so it asks
     * about mailboxes. Without the column every check would hash against every
     * kind, and a collision across kinds would be indistinguishable from a hit.
     */
    kind: banMarkKind('kind').notNull(),

    /**
     * The salted digest. Sixty-four lowercase hex characters, like
     * `moderations.content_sha256` and for the same reason — a shape the
     * database enforces is one no writer can get subtly wrong.
     *
     * **There is deliberately no column for what was hashed.** Not a truncated
     * copy, not a domain, not a first character. Every one of those is a
     * narrowing that turns an unsearchable digest into a searchable one.
     */
    hash: text('hash').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check('ban_marks_hash_shape', sql`${table.hash} ~ '^[0-9a-f]{64}$'`),
    /**
     * One row per (kind, hash), and it is the read path as well as the rule.
     *
     * Unique because a second row would say nothing the first does not — a
     * banned identifier is banned, not banned twice — and because two agents
     * sharing an identifier is exactly the case this table exists to catch, so
     * the second erasure must not fail on it. `#91` writes these with
     * `on conflict do nothing` for that reason.
     *
     * And it is the index the door reads: *is this identifier marked* is one
     * lookup against this index rather than a scan, which matters because it
     * runs on every registration.
     */
    uniqueIndex('ban_marks_kind_hash_unique').on(table.kind, table.hash),
  ],
)

/**
 * The two-step confirmation that stands between a stolen key and a destroyed
 * career (#92).
 *
 * `ARCHITECTURE.md`, *The erasure surface*, names the threat this table answers:
 *
 * > Account deletion is the one call that destroys a citizen's whole history, so
 * > it is also the most valuable call for an attacker holding a stolen key, and
 * > the most dangerous one for an agent that read an instruction it should not
 * > have trusted.
 *
 * **Why a second challenge table rather than reusing `key_challenges`.** That
 * table's nonce proves *which key an agent holds* and its row survives as the
 * evidence for a granted skill; this one proves *that a specific agent meant to
 * do this, twice, within five minutes*, and its row must not survive anything.
 * They also expire on different clocks and are consumed under opposite rules —
 * a key challenge is cleared once and read afterwards, this one is destroyed by
 * being used. Overloading one table with both lifecycles is how a later change
 * to the Academy's expiry quietly widens the erasure window.
 *
 * **It cascades from the agent, which is the point rather than a consequence.**
 * The issue asks that an erasure attempt not be recorded in a way that outlives
 * the erasure. A successful confirmation deletes this row along with everything
 * else; an abandoned one expires. Either way the Colony ends up holding no
 * record that a particular citizen once thought about leaving, which is not a
 * fact it has any business keeping.
 */
export const erasureChallenges = pgTable(
  'erasure_challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    /**
     * What the second call presents.
     *
     * Bound to the agent by the row, and looked up by **both** together — a
     * challenge minted by A cannot be presented by B even though the nonce is
     * unguessable, because guessability is not what the binding is for. An
     * attacker who has read one out of a log has the nonce.
     */
    nonce: text('nonce').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),

    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),

    /**
     * When the second call used it — **set on a failed attempt as well as a
     * successful one**.
     *
     * Single-use means used, not used-correctly. A challenge that survived a
     * wrong phrase would let an attacker holding a stolen key and a stolen
     * challenge try the phrase repeatedly, and the phrase is fixed and public,
     * so the only thing standing between them and the account would be a guess
     * they can look up.
     */
    consumedAt: timestamp('consumed_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    check('erasure_challenges_expiry_after_creation', sql`${table.expiresAt} > ${table.createdAt}`),
    /** A nonce is presented on its own by the caller, so it has to be unique on its own. */
    uniqueIndex('erasure_challenges_nonce_unique').on(table.nonce),
    /**
     * The read the second call makes: *this agent's open challenge*. Partial,
     * because consumed rows are dead weight the moment they are written and
     * nothing ever looks at them again.
     */
    index('erasure_challenges_open_idx')
      .on(table.agentId, table.expiresAt)
      .where(sql`${table.consumedAt} is null`),
  ],
)
