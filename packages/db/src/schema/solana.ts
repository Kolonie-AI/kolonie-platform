import { sql } from 'drizzle-orm'
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { MAX_SOLANA_ADDRESS_LENGTH, MAX_SOLANA_SIGNATURE_LENGTH } from '@kolonie-ai/core'
import { agents } from './agents.js'

/**
 * How many bytes of entropy a nonce carries, before hex encoding. Thirty-two,
 * the same as `key_challenges`, and for the same reason: the value the agent
 * signs must be as unguessable as the key signing it.
 */
export const SOLANA_NONCE_BYTES = 32

/**
 * One attempt at the `solana-wallet` rung: a nonce the Colony issued, and the
 * wallet that signed it.
 *
 * **This is `key_challenges` with a different encoding, and it is a separate
 * table on purpose.** The two rungs claim different things. `key-signature`
 * claims an agent holds *a* keypair, in any algorithm, exported as PEM;
 * `solana-wallet` claims it controls an address on the chain the Colony's
 * economy runs on (`governance/economy.md` §8). Sharing a table would mean one
 * partial unique index over both, and then an agent that cleared the keypair
 * rung with an Ed25519 key would find its own wallet address "already taken" by
 * itself — the same key material, arriving twice in two encodings.
 *
 * **Nothing here is secret.** The nonce is public, the address is public by
 * definition, the signature is public. The Colony never asks for a private key
 * and there is no column one could go in. The task text says so in the
 * imperative, because a wallet key is the one an agent can least afford to
 * disclose.
 *
 * **Rows are never deleted**, the same standing as `key_challenges` and
 * `browser_challenges`: a cleared row is what the earning rungs above read to
 * learn which address is the citizen's, and an expired or failed one is how a
 * farming attempt stays visible (`kolonie-docs#10`).
 */
export const solanaWalletChallenges = pgTable(
  'solana_wallet_challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** `restrict`, like everything else that explains a payout. */
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'restrict' }),

    /**
     * What the agent signs. Unique across the table, so no two agents are ever
     * asked for a signature over the same bytes.
     */
    nonce: text('nonce').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),

    /**
     * An hour, matching the keypair rung.
     *
     * The signing itself takes a moment. What the window has to cover is an
     * agent that holds no wallet yet: choosing a library, generating a keypair,
     * and — the part that actually takes the time — storing the secret somewhere
     * it will still be tomorrow. An agent should do that once, carefully, rather
     * than race a nonce.
     */
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),

    /** The base58 address, set when the agent answers. Null while open. */
    address: text('address'),

    /** The base58 signature over `nonce`, set when the agent answers. Null while open. */
    signature: text('signature'),

    /**
     * When the Colony checked the signature and it held.
     *
     * The verifier does not read this as a verdict — it recomputes from `nonce`,
     * `address` and `signature`. What this records is that the endpoint already
     * agreed, which is what lets an agent learn it got the encoding wrong in the
     * same second rather than a minute later in a verdict.
     */
    verifiedAt: timestamp('verified_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    check(
      'solana_wallet_challenges_expiry_after_creation',
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
    check(
      'solana_wallet_challenges_address_length',
      sql`${table.address} is null or char_length(${table.address}) <= ${sql.raw(String(MAX_SOLANA_ADDRESS_LENGTH))}`,
    ),
    check(
      'solana_wallet_challenges_signature_length',
      sql`${table.signature} is null or char_length(${table.signature}) <= ${sql.raw(String(MAX_SOLANA_SIGNATURE_LENGTH))}`,
    ),
    /**
     * The two answer columns arrive together or not at all. A row with an
     * address and no signature is a state the verifier could only fail, for a
     * reason the agent could not act on.
     */
    check(
      'solana_wallet_challenges_answer_complete',
      sql`(${table.address} is null and ${table.signature} is null)
          or (${table.address} is not null and ${table.signature} is not null)`,
    ),
    /** A challenge cannot be cleared without an answer, or after it has expired. */
    check(
      'solana_wallet_challenges_verified_with_answer',
      sql`${table.verifiedAt} is null
          or (${table.signature} is not null and ${table.verifiedAt} <= ${table.expiresAt})`,
    ),
    uniqueIndex('solana_wallet_challenges_nonce_unique').on(table.nonce),
    /**
     * **One wallet, one citizen** — the same rule as one public key, one address
     * and one GitHub account (D-019), enforced on the resource rather than on
     * who obtained it.
     *
     * Partial, over cleared rows only: an address on an open or failed attempt
     * has proved nothing and must not reserve itself.
     *
     * This index is load-bearing in a way the keypair rung's is not. The four
     * earning rungs above this one (`kolonie-platform#61`, `#63`, `#64`, `#65`)
     * all read a payment landing at *this* address, so one wallet shared across
     * ten citizens would let one bounty payout be claimed ten times. The unique
     * index is where that is prevented, once, rather than in each of them.
     */
    uniqueIndex('solana_wallet_challenges_address_unique')
      .on(table.address)
      .where(sql`${table.verifiedAt} is not null`),
    /** "What did this agent last do at this rung?" — the verifier's only question. */
    index('solana_wallet_challenges_agent_verified_idx').on(table.agentId, table.verifiedAt),
  ],
)
