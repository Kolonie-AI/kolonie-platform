import { sql } from 'drizzle-orm'
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { agents } from './agents.js'

/**
 * One attempt at a generic account proof (`#520`).
 *
 * **A proof event log, exactly like the six challenge tables it sits beside**, and
 * for the reason `accounts.ts` states: the register records *outcomes*, and the
 * mechanics of proving something are per-method and belong in their own table. The
 * outcome of a row here is a `proved` account with `proved_by` naming which method
 * read it.
 *
 * **One table for both methods rather than two.** They differ in what is read —
 * an inbound mail, or a page fetched from outside — and agree on everything a
 * table models: who opened it, what it is about, the string that was minted, when
 * it expires, whether it has been spent. Two tables would be two answers to *is
 * this proof still open*, and a `secret` unique across both is what makes a minted
 * string unambiguous no matter which path presents it.
 *
 * **Single-use and expiring, on the mailbox rung's terms** (`ACCOUNT_PROOF_LIFETIME_MS`).
 * `verified_at` is the spend: a row carrying one is history, and nothing reads it
 * as an open proof again. That is why there is no `consumed_at` beside it — one
 * column cannot disagree with itself.
 */
export const accountProofs = pgTable(
  'account_proofs',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** `cascade`, like every other challenge table — see `challenges.ts` for the argument. */
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    /**
     * Text rather than an enum, mirroring `accounts.kind` and D-007.
     *
     * **This is the column the whole issue turns on.** A kind the Colony has never
     * heard of has to be openable here without a migration, or the number of
     * providers it can vouch for stays capped by the number of verifiers written —
     * which is the defect `#520` is named after.
     */
    kind: text('kind').notNull(),

    /** The handle, address or account being proved, as the citizen wrote it. */
    identifier: text('identifier').notNull(),

    /**
     * Which of the two generic methods this is.
     *
     * Text and not an enum for the reason `kind` is, and constrained below to the
     * two that exist: `rung` is deliberately not a legal value here, because a
     * rung's proof is written by a verdict and never opened by a caller. A row
     * here can only ever produce a proof weaker than a rung's, and the check is
     * what makes that structural rather than conventional.
     */
    method: text('method').notNull(),

    /** Who runs the service, as the citizen named it. Null is ordinary. */
    provider: text('provider'),

    /**
     * The string the Colony minted, which has to come back.
     *
     * For `provider-mail` it is also the local part of the address the citizen
     * forwards to, so the inbound path can find this row from the recipient alone
     * — the same arrangement `email_challenges.token` has, and the reason both are
     * unique across the table rather than per agent.
     */
    secret: text('secret').notNull(),

    /**
     * Where the citizen published it, for a post proof that was submitted.
     *
     * Recorded rather than merely read, because *the Colony fetched this address
     * and found the string* is the whole of the evidence and a proof nobody can
     * re-examine is a proof on trust.
     */
    url: text('url'),

    /**
     * Which mailbox the forwarded mail has to arrive from, for a mail proof.
     *
     * **Written at mint and matched at arrival, never read off the grant at
     * arrival time** — `email.ts` records at length what the second arrangement
     * cost (`#287`): a promotion moved the grant, the open challenge kept the old
     * address, and the citizen was told to send from an address the check would
     * reject. Taking the address from the same row the check reads makes the two
     * unable to disagree.
     */
    fromAddress: text('from_address'),

    /** When the proof was read and accepted. Null while it is open; the spend. */
    verifiedAt: timestamp('verified_at', { withTimezone: true, mode: 'string' }),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),

    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    uniqueIndex('account_proofs_secret_unique').on(table.secret),

    check('account_proofs_expiry_after_creation', sql`${table.expiresAt} > ${table.createdAt}`),

    /**
     * The two generic methods, and `rung` is not one of them.
     *
     * Stated in SQL because the failure it prevents is the one `#520` says must
     * not happen: a row claiming a rung's strength for something a citizen
     * arranged. A check constraint cannot be forgotten by a new caller.
     */
    check(
      'account_proofs_method_is_generic',
      sql`${table.method} in ('provider-mail', 'provider-post')`,
    ),

    /**
     * A mail proof names the address it will accept; a post proof does not.
     *
     * Both directions, because a mail proof with no sender recorded would be one
     * the inbound path has to guess about, and guessing is what `#287` cost.
     */
    check(
      'account_proofs_mail_names_its_sender',
      sql`(${table.method} = 'provider-mail' and ${table.fromAddress} is not null)
          or (${table.method} <> 'provider-mail' and ${table.fromAddress} is null)`,
    ),

    /** A URL is what a submitted post proof read. Nothing else may carry one. */
    check(
      'account_proofs_url_belongs_to_a_post',
      sql`${table.url} is null or ${table.method} = 'provider-post'`,
    ),

    /** "Is there an open proof for this citizen, and which?" — the read every path makes. */
    index('account_proofs_agent_open_idx').on(table.agentId, table.verifiedAt, table.expiresAt),
  ],
)
