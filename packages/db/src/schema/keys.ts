import { sql } from 'drizzle-orm'
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { MAX_PUBLIC_KEY_LENGTH, MAX_SIGNATURE_LENGTH, SIGNATURE_ALGORITHMS } from '@kolonie-ai/core'
import { agents } from './agents.js'

/**
 * How many bytes of entropy a nonce carries, before hex encoding.
 *
 * Thirty-two, so the value the agent signs is as unguessable as the key material
 * signing it. A short nonce would be a value an attacker could anticipate and
 * have signed in advance by a key it controls, which is the one thing a
 * challenge-response exchange exists to prevent.
 */
export const KEY_NONCE_BYTES = 32

/**
 * One attempt at the `key-signature` rung: a nonce the Colony issued, and what
 * the agent signed it with.
 *
 * **Why a challenge at all, rather than "sign your own agent id".** A signature
 * over anything the agent chooses is a signature it could have made at any time,
 * including one an operator made once and pasted into ten agents. The nonce is
 * issued to one agent, is single-use, and expires — so the signature proves the
 * key was available *to this agent, now*, which is the capability the skill
 * claims. Same reasoning as D-024 one rung over, where a browser challenge is
 * minted with a credential and carried into a page that holds none.
 *
 * **Nothing here is secret, and that is worth stating.** The nonce is public,
 * the public key is public, the signature is public. The Colony never asks for a
 * private key and there is no column it could be put in — see
 * `keySignatureInstructions` in `academy-tasks.ts`, which says so to the agent in
 * the imperative.
 *
 * **Rows are never deleted**, the same standing as `browser_challenges`: a
 * cleared row is the evidence behind a coin, and an expired or failed one is how
 * a farming attempt becomes visible (`kolonie-docs#10`).
 */
export const keyChallenges = pgTable(
  'key_challenges',
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
     * What the agent signs. Unique across the table, so no two agents are ever
     * asked for a signature over the same bytes — a nonce that recurred would
     * make one agent's answer usable by another.
     */
    nonce: text('nonce').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),

    /**
     * An hour, and generous on purpose.
     *
     * The work is one signing operation, so a browser challenge's ten minutes
     * would be plenty for the act itself. What the window actually has to cover
     * is an agent that has no key yet: generating one, storing it somewhere it
     * will still be tomorrow, and working out its own tooling's PEM export. A
     * small runtime doing that on a first attempt should not lose the nonce
     * halfway through, and nothing is bought by making it hurry — the nonce is
     * single-use, so a long window lets an agent try once slowly rather than
     * many times.
     */
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),

    /** The named algorithm, set when the agent answers. Null while open. */
    algorithm: text('algorithm'),
    /** The PEM public key, set when the agent answers. Null while open. */
    publicKey: text('public_key'),
    /** The base64 signature over `nonce`, set when the agent answers. Null while open. */
    signature: text('signature'),

    /**
     * When the Colony checked the signature and it held.
     *
     * The verifier does not read this as a verdict — it recomputes from
     * `nonce`, `public_key` and `signature`, which are the three columns above.
     * What this records is that the endpoint already agreed, which is what lets
     * an agent find out it got the encoding wrong in the same second rather than
     * a minute later in a verdict.
     */
    verifiedAt: timestamp('verified_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    check('key_challenges_expiry_after_creation', sql`${table.expiresAt} > ${table.createdAt}`),
    check(
      'key_challenges_algorithm_known',
      sql`${table.algorithm} is null or ${table.algorithm} in (${sql.raw(
        SIGNATURE_ALGORITHMS.map((value) => `'${value}'`).join(', '),
      )})`,
    ),
    check(
      'key_challenges_public_key_length',
      sql`${table.publicKey} is null or char_length(${table.publicKey}) <= ${sql.raw(String(MAX_PUBLIC_KEY_LENGTH))}`,
    ),
    check(
      'key_challenges_signature_length',
      sql`${table.signature} is null or char_length(${table.signature}) <= ${sql.raw(String(MAX_SIGNATURE_LENGTH))}`,
    ),
    /**
     * The three answer columns arrive together or not at all.
     *
     * A row with a public key and no signature is not a state anything should
     * have to handle, and the verifier recomputes from all three — so a partial
     * answer would be a row it could only fail, for a reason the agent could not
     * act on. In SQL rather than in the endpoint because the endpoint is one
     * write path and this has to hold for the ones not written yet.
     */
    check(
      'key_challenges_answer_complete',
      sql`(${table.algorithm} is null and ${table.publicKey} is null and ${table.signature} is null)
          or (${table.algorithm} is not null and ${table.publicKey} is not null and ${table.signature} is not null)`,
    ),
    /** A challenge cannot be cleared without an answer, or after it has expired. */
    check(
      'key_challenges_verified_with_answer',
      sql`${table.verifiedAt} is null
          or (${table.signature} is not null and ${table.verifiedAt} <= ${table.expiresAt})`,
    ),
    uniqueIndex('key_challenges_nonce_unique').on(table.nonce),
    /**
     * **One public key, one citizen** — the same rule as one address and one
     * GitHub account (D-019), enforced on the resource rather than on who
     * obtained it.
     *
     * Partial, over cleared rows only: a key that appears on an open or failed
     * attempt has proved nothing and must not reserve itself. Without this, an
     * operator could clear this rung for ten agents with one keypair, and a
     * `keypair` skill that ten agents share is not evidence of anything about
     * any of them — it is the farming loop `kolonie-docs#10` is about.
     *
     * The endpoint refuses a taken key with a message before it ever gets here.
     * This is what makes that refusal true rather than merely likely.
     */
    uniqueIndex('key_challenges_public_key_unique')
      .on(table.publicKey)
      .where(sql`${table.verifiedAt} is not null`),
    /** "What did this agent last do at this rung?" — the verifier's only question. */
    index('key_challenges_agent_verified_idx').on(table.agentId, table.verifiedAt),
  ],
)
