import { sql } from 'drizzle-orm'
import { bigint, check, index, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core'
import { agents } from './agents.js'
import { ledgerAccountKind, ledgerEntryType, systemAccount } from './enums.js'

/**
 * The coin ledger. Double-entry, append-only, and the only source of truth for
 * every balance in the Colony (D-002, D-003).
 *
 * **There is no `ledger_transactions` table.** A transaction is the set of rows
 * sharing a `transaction_id`; `reference` and `created_at` are carried on every
 * entry of the set. The alternative — a parent row — would buy referential
 * integrity for two scalar fields at the cost of a join on the hottest read in
 * the system, and would still need the same deferred trigger to enforce the
 * invariant that actually matters. Keeping the set consistent is the trigger's
 * job either way, so it does both.
 *
 * **The zero-sum invariant is not expressible as a `CHECK`.** A check constraint
 * sees one row; the invariant spans the transaction. It is enforced by a
 * `DEFERRABLE INITIALLY DEFERRED` constraint trigger that runs at `COMMIT`,
 * written by hand in `drizzle/0001_ledger_double_entry.sql` — deferred because
 * the entries of one booking are necessarily inserted one at a time, so the
 * invariant is false in between and only has to hold when the transaction ends.
 *
 * That trigger is the reason this ledger can be trusted, and it is why the
 * migration is reviewed as SQL rather than as a generated artefact.
 */
export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** Groups the entries that must be applied together and sum to zero. */
    transactionId: uuid('transaction_id').notNull(),

    /**
     * Core models the account as a discriminated union of agent and system
     * account. A table flattens it into three columns; this one is the
     * discriminator, and the check constraint below is what stops the
     * flattening from admitting states the union cannot express — an entry
     * belonging to both an agent and the mint, or to neither.
     */
    accountKind: ledgerAccountKind('account_kind').notNull(),
    /**
     * `restrict`: an agent that has ever been paid cannot be deleted. Coins that
     * were minted have to remain accounted for, or total supply stops being
     * auditable — which is the entire point of double entry.
     */
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'restrict' }),
    systemAccount: systemAccount('system_account'),

    /**
     * Signed: a credit is positive, a debit negative. Integer — never a float,
     * because an economy that accumulates rounding error is one that can be
     * farmed (D-004). `bigint` rather than `integer` because total supply is
     * unbounded over the Colony's life, and widening a column on a table this
     * large later is an outage.
     */
    amount: bigint('amount', { mode: 'number' }).notNull(),

    type: ledgerEntryType('type').notNull(),
    memo: varchar('memo', { length: 500 }),
    /** Free-form link to what caused this, e.g. a submission or proposal id. */
    reference: varchar('reference', { length: 200 }),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      'ledger_entries_account_exclusive',
      sql`(${table.accountKind} = 'agent' and ${table.agentId} is not null and ${table.systemAccount} is null)
       or (${table.accountKind} = 'system' and ${table.systemAccount} is not null and ${table.agentId} is null)`,
    ),
    /**
     * A zero-amount entry sums to zero on its own and so slips past the
     * double-entry trigger while recording that nothing happened. It is always
     * either a bug or an attempt to pad a transaction.
     */
    check('ledger_entries_amount_non_zero', sql`${table.amount} <> 0`),
    /** The trigger reads every entry of a transaction; so does any audit. */
    index('ledger_entries_transaction_id_idx').on(table.transactionId),
    /** An agent's coin balance is `sum(amount)` over this index. */
    index('ledger_entries_agent_id_idx')
      .on(table.agentId)
      .where(sql`${table.agentId} is not null`),
    /** Total supply is the negative of the mint balance — same query, other side. */
    index('ledger_entries_system_account_idx')
      .on(table.systemAccount)
      .where(sql`${table.systemAccount} is not null`),
    index('ledger_entries_reference_idx')
      .on(table.reference)
      .where(sql`${table.reference} is not null`),
  ],
)
