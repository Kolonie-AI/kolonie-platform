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
  varchar,
} from 'drizzle-orm/pg-core'
import { agents } from './agents.js'

/**
 * One deposit address per identity that funds a quest (`#219`).
 *
 * **A keypair per sponsor, and not one shared address plus a memo.** The memo
 * version was considered and rejected: attribution would depend on an agent
 * remembering to attach one, and a deposit that arrives without a memo is money
 * the Colony holds and cannot attribute, with no good way to resolve it
 * afterwards — the sender has to be believed. A keypair costs a row and removes
 * the failure entirely.
 *
 * **There is no separate sponsor account type**, and this table must not become
 * one: `#176` decided that any authenticated identity may write a quest, so a
 * citizen is a sponsor when it funds one. The address hangs off the identity
 * that already exists.
 */
export const depositAddresses = pgTable(
  'deposit_addresses',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * Whose address this is.
     *
     * `cascade`: the address is a fact about a citizen and nothing else reads
     * it once the citizen is gone. What the deposits *bought* is in the ledger,
     * and erasure settles that on its own terms.
     */
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    /** The public key, base58, exactly as a sender would type it. */
    address: varchar('address', { length: 64 }).notNull(),

    /**
     * The secret, sealed with the Colony's own key.
     *
     * **Held rather than discarded, because a sweep that needs a key nobody
     * kept is the one mistake here that cannot be repaired.** Sweeping to the
     * Treasury is not in `#219`; keeping the key is what leaves it possible.
     *
     * Sealed with `sealVaultValue`, the same envelope a citizen's vault uses —
     * the crypto is identical and only the key source differs: a citizen's vault
     * is opened by the citizen's API key, and this by a secret only the process
     * holds. An operator with the database has neither.
     */
    secretSealed: text('secret_sealed').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    /** One address per identity: a second would split one sponsor's deposits in two. */
    uniqueIndex('deposit_addresses_agent_unique').on(table.agentId),
    /**
     * And one identity per address. A collision is a generated keypair repeating
     * itself, which does not happen — and if it ever did, crediting the wrong
     * account is not a failure to discover afterwards.
     */
    uniqueIndex('deposit_addresses_address_unique').on(table.address),
  ],
)

/**
 * Every USDC transfer the Colony has observed at one of its deposit addresses,
 * credited or not (`#219`).
 *
 * **The uncredited ones are here too, with a reason.** A sponsor whose money
 * vanished into a correct system with no visible record is a sponsor lost for a
 * reason nobody can explain afterwards.
 */
export const deposits = pgTable(
  'deposits',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * The transaction signature, and the whole of the idempotency.
     *
     * **A unique constraint and not a check in code.** Webhook redelivery is
     * normal operation rather than an incident, and the reconciliation job reads
     * the same transfers the webhook did — so the second write is the expected
     * case, not the exceptional one. A `select` followed by an `insert` is a race
     * exactly as wide as the transaction, and Postgres is the only participant
     * that sees both.
     */
    signature: varchar('signature', { length: 120 }).notNull(),

    /** Whose deposit. `set null` keeps the arrival on record when a citizen leaves. */
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),

    /** The address it arrived at, kept as text so the row survives the address row. */
    address: varchar('address', { length: 64 }).notNull(),

    /** What arrived, in USDC base units. `bigint` for the reason the ledger uses one. */
    baseUnits: bigint('base_units', { mode: 'number' }).notNull(),

    /** What it was worth, floored to whole cents. Zero on anything uncredited. */
    credits: integer('credits').notNull().default(0),

    /**
     * The sub-cent part, recorded so that the deposit total and the credit total
     * can be reconciled to each other rather than merely believed.
     */
    remainder: integer('remainder').notNull().default(0),

    observedAt: timestamp('observed_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    creditedAt: timestamp('credited_at', { withTimezone: true, mode: 'string' }),

    /** Why nothing was credited. Exactly one of this and `credited_at` is set. */
    rejection: text('rejection'),
  },
  (table) => [
    uniqueIndex('deposits_signature_unique').on(table.signature),
    /**
     * Credited or refused, never both and never neither. A row with neither is a
     * deposit nobody decided about, which is the state this table exists to make
     * impossible.
     */
    check(
      'deposits_credited_xor_rejected',
      sql`(${table.creditedAt} is null) <> (${table.rejection} is null)`,
    ),
    check(
      'deposits_credited_amounts',
      sql`(${table.creditedAt} is not null) or (${table.credits} = 0)`,
    ),
    check(
      'deposits_amounts_non_negative',
      sql`${table.baseUnits} >= 0 and ${table.credits} >= 0 and ${table.remainder} >= 0`,
    ),
    /** The sponsor's own history, newest first. */
    index('deposits_agent_idx').on(table.agentId, table.observedAt),
  ],
)
