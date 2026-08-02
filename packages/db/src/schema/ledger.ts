import { sql } from 'drizzle-orm'
import {
  bigint,
  check,
  index,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { agents } from './agents.js'
import { fundingSource, ledgerAccountKind, ledgerEntryType, systemAccount } from './enums.js'

/**
 * The credit ledger. Double-entry, append-only, and the only source of truth for
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
     * `restrict`, and it is the only reference to `agents` that still is — but
     * it now states a **sequencing rule rather than a prohibition**, and the
     * difference is the whole of `erasure.md` §3.
     *
     * The old comment said an agent that has ever been paid cannot be deleted,
     * because minted credits have to remain accounted for or total supply stops
     * being auditable. The premise is right and the conclusion was too strong:
     *
     * > Double entry constrains **arithmetic**, not identity: a set of entries
     * > that sums to zero can be removed in full without changing any other
     * > account's balance, and without changing total supply by a single unit.
     *
     * So an agent with a balance cannot be deleted, and an agent whose entries
     * are gone can. Erasure books one last transaction to make the second state
     * reachable: the balance is debited to zero against the mint.
     *
     * **Three steps and not two, which `erasure.md` §3 does not say and the
     * tests in `#90` do.** The document reads *"the agent's entries now sum to
     * zero, so every one of them is deleted with the agent"*, and they are not
     * deleted *with* it: `restrict` refuses on the **existence** of a
     * referencing row and never looks at its sum, so a burned account still has
     * every entry it ever had and the delete is still refused. `#91` therefore
     * burns, deletes the entries, and only then deletes the agent.
     *
     * **And the entries go whole booking at a time.** Removing only the agent's
     * side of a transaction leaves the mint's counter-entry alone, and
     * `ledger_entries_balanced` refuses that at `COMMIT` — correctly, because a
     * booking that no longer sums to zero is exactly what makes supply
     * unauditable. Deleting both sides moves total supply by nothing, since the
     * booking summed to zero to begin with.
     *
     * **The unfinished part, stated here because it is not obvious from the
     * column.** Every booking today has the mint on the other side. One whose
     * other leg sits elsewhere — the Treasury on a purchase, another citizen on
     * a `transfer`, the faucet on a grant, none of which anything writes yet —
     * cannot be removed *whole*, because that would take the counterparty's
     * entry and change a balance that is not the leaving citizen's.
     *
     * It needs one more rule rather than a redesign: keep the counterparty's leg
     * and **substitute a mint leg** for the departing citizen's, same amount.
     * The citizen is then named nowhere, the counterparty is untouched, and
     * supply still reconciles — `erasure.md` §3 works the arithmetic through.
     * `eraseAgent` refuses such a booking today rather than guessing, which is
     * what will make the first one announce itself.
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

    /**
     * Whose money this was, on the entries that are money entering the Colony
     * (`#220`).
     *
     * **Not nullable where it applies and null everywhere else**, enforced by
     * `ledger_entries_funding_source_iff_credit` below rather than by a default.
     * A default is how a field like this ends up wrong at scale: whichever value
     * is the default becomes the value nobody thought about.
     *
     * It annotates the **whole booking**, both rows, because a booking is the
     * event and either row read alone should say where the money came from.
     *
     * **Nothing outside accounting reads it.** It is a fact about money, and a
     * quest funded from bootstrap is worth exactly as much to the citizen who
     * completes it. The moment it gates something a citizen can see, the
     * incentive to misclassify has been created — and there is a test asserting
     * no code path outside accounting touches it.
     */
    fundingSource: fundingSource('funding_source'),

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
    /**
     * Every balance credit records whose money it was, and nothing else does
     * (`#220`).
     *
     * Both directions, because both failures are real. A `balance_credit`
     * without a source is money whose origin nobody can reconstruct — chain data
     * shows an address and bank records show a transfer, neither of which says
     * whose money it was. A source on a task payout is an accounting fact
     * attached to an event it is not about.
     *
     * `::text` for the same reason `tasks_rejection_reason_iff_rejected` uses it:
     * `balance_credit` is added to `ledger_entry_type` by the same migration, and
     * Postgres refuses to use a new enum value in the transaction that created
     * it.
     */
    check(
      'ledger_entries_funding_source_iff_credit',
      sql`(${table.type}::text = 'balance_credit') = (${table.fundingSource} is not null)`,
    ),
    /** The trigger reads every entry of a transaction; so does any audit. */
    index('ledger_entries_transaction_id_idx').on(table.transactionId),
    /** An agent's credit balance is `sum(amount)` over this index. */
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
    /**
     * A task reward is booked **once** per submission, and this index is what
     * says so — not a check in TypeScript.
     *
     * The difference matters because the thing that would book twice is not a
     * careless caller, it is two runners deciding the same submission in the
     * same millisecond. A `select` that finds no prior booking followed by an
     * `insert` is a race with a window exactly as wide as the transaction, and
     * both sides would pass it. Postgres is the only participant that sees both
     * inserts, so Postgres has to be the one that refuses the second.
     *
     * `(reference, account_kind)` rather than `reference` alone: a booking is
     * two rows sharing one reference — the agent's credit and the mint's debit —
     * and they are told apart by exactly this column. Partial on
     * `type = 'task_reward'` so that a later booking of a different kind against
     * the same submission (a review reward, an adjustment) is still possible;
     * what may not happen twice is *this* payout.
     */
    uniqueIndex('ledger_entries_task_reward_unique')
      .on(table.reference, table.accountKind)
      .where(sql`${table.type} = 'task_reward'`),
    /**
     * A quest's money moves once per event, and these two indexes are what say
     * so (`#174`) — not a check in TypeScript.
     *
     * Same argument as `ledger_entries_task_reward_unique` above: the thing that
     * would book twice is two requests publishing the same quest in the same
     * millisecond, and a `select` that finds no prior booking followed by an
     * `insert` is a race exactly as wide as the transaction. Postgres is the only
     * participant that sees both inserts.
     *
     * **Three events, three references, one rule.** `quest:<id>:funding`,
     * `quest:<id>:refund` and `quest:<id>:payout:<submissionId>` are distinct, so
     * "one entry per account per reference" refuses a second publication, a
     * second refund and a second payout without any of them being able to block
     * another. Sharing one reference across funding and refund would have made
     * the index refuse the refund, which is why `questFundingReference` and its
     * neighbours are shaped the way they are.
     *
     * **Two indexes rather than one, because the key is the account and the
     * account lives in one of two columns.** The reward index above can key on
     * `account_kind`, since a reward is always one agent and the mint. A quest is
     * not: a refund on an ownerless quest is escrow → treasury, two `system` rows
     * that are identical under that key, and a single `account_kind` index
     * refused the very transaction writing them.
     *
     * `coalesce(system_account::text, agent_id::text)` was the next attempt and
     * Postgres refuses it — casting an enum to text is `STABLE`, not
     * `IMMUTABLE`, so it cannot appear in an index expression. `NULLS NOT
     * DISTINCT` was the third and this version of drizzle-kit does not emit it.
     * One partial index per side needs neither, and each is exactly readable as
     * what it enforces.
     */
    uniqueIndex('ledger_entries_quest_money_agent_unique')
      .on(table.reference, table.agentId)
      .where(
        sql`${table.type} in ('task_funding', 'task_payout') and ${table.agentId} is not null`,
      ),
    uniqueIndex('ledger_entries_quest_money_system_unique')
      .on(table.reference, table.systemAccount)
      .where(
        sql`${table.type} in ('task_funding', 'task_payout') and ${table.systemAccount} is not null`,
      ),
  ],
)
