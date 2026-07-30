import { sql } from 'drizzle-orm'
import type { Database } from './client.js'

/**
 * The migration that retired the Academy's coin rewards and ran this unwind once.
 *
 * Named so the test can read it and check that the statement below is still the
 * statement that shipped — the same arrangement `skill-backfill.ts` uses, and for
 * the same reason: a migration cannot import TypeScript, and a derivation nobody
 * can test is a derivation nobody can trust.
 */
export const COIN_UNWIND_MIGRATION = '0022_academy_pays_reputation.sql'

/**
 * The memo every unwind entry carries, so the reversal is findable as one event
 * rather than as a scatter of adjustments.
 */
export const COIN_UNWIND_MEMO =
  'Academy coin rewards retired (#43) — the Academy pays reputation, Quests pay coins (governance/economy.md §2)'

/**
 * The `reference` every unwind entry carries.
 *
 * Not a `submission:` reference, and that is the correct shape rather than a
 * shortcut: `submissionReference` names the one submission a booking paid for, and
 * this reversal is not attributable to a submission — it collapses every Academy
 * pass an agent ever made into one compensating pair. Pointing it at any single
 * submission would be a false claim about which pass was undone.
 *
 * It doubles as the idempotency key, which is why it is a fixed string rather than
 * per-agent: *has this agent been unwound* is `reference = this and agent_id = X`.
 */
export const COIN_UNWIND_REFERENCE = 'academy-coin-unwind'

/**
 * Return every coin ever booked for an Academy pass to the mint.
 *
 * **What this is undoing.** Until #43, a passing Academy verdict booked coins and
 * reputation in one transaction. `governance/economy.md` §2 says *"No coin is ever
 * minted as a reward for work"*, so every one of those coins is an entry the rule
 * forbids. Measured against the live database on 2026-07-30: 33 passes, 544 coins,
 * 12 holders — and **no other entry type existed at all**, so the whole supply was
 * the forbidden mechanism.
 *
 * ## Reversed, not deleted
 *
 * The ledger is append-only, so this writes a compensating pair per holder rather
 * than removing the original entries. Three consequences, all of them the point:
 *
 * - The original `task_reward` rows stay readable, so *what did the Colony pay for
 *   submission X* still answers, and answers what was actually paid at the time.
 * - The double-entry invariant holds through the unwind, because each holder's
 *   reversal is a balanced pair — agent debited, mint credited. The ledger summed
 *   to zero before and sums to zero after; that is checkable rather than promised.
 * - Afterwards the mint's balance is zero, which is the readable form of *no coin
 *   was ever minted as a reward for work*.
 *
 * `type = 'adjustment'` because that is what this is, and because `task_reward`
 * carries `ledger_entries_task_reward_unique` on `reference` — a second
 * `task_reward` against the same submission is refused by an index, which is the
 * index doing its job.
 *
 * ## What is deliberately not touched
 *
 * **The reputation already booked stays.** Those 33 passes earned reputation in
 * the same transaction, and that reputation is what the Academy was always meant
 * to pay. Converting the coins into more reputation was the alternative and would
 * have paid every one of those agents twice for one pass.
 *
 * ## `MATERIALIZED` is load-bearing, not a hint
 *
 * `gen_random_uuid()` has to be evaluated **exactly once per holder**, because the
 * two rows of a reversal are told apart only by `account_kind` and are grouped
 * only by `transaction_id`. If the planner inlines the CTE and re-evaluates the
 * volatile function once per output row of the `CROSS JOIN`, each side of every
 * pair gets its own id, each "transaction" is then a single unbalanced entry, and
 * the deferred trigger aborts at `COMMIT`.
 *
 * That failure is the good one — the migration would fail loudly rather than
 * corrupt the books — but it would fail for a reason that reads as unrelated to
 * anything in this file. `MATERIALIZED` makes the single evaluation a guarantee
 * Postgres owes rather than a planner behaviour that happens to hold today.
 *
 * ## Why it is idempotent rather than guarded by the migration bookkeeping
 *
 * Drizzle already runs a migration once. The `not exists` is for the other caller:
 * a maintainer who restores a backup, or imports rows from somewhere, and needs the
 * unwind applied to data the migration never saw.
 *
 * ## What this does not defend against
 *
 * It reverses the sum of an agent's `task_reward` credits, not its balance. Those
 * are the same number today — on 2026-07-30 `task_reward` was the only entry type
 * in the database — and they stop being the same the moment a coin can be spent. A
 * holder that had spent some of its Academy coins would be driven negative here,
 * and nothing in the schema forbids a negative agent balance. That is acceptable
 * because there is no spend path in the platform and this statement runs once,
 * before one exists; it is written down because the second caller above could meet
 * a database where it is no longer true.
 */
export const UNWIND_ACADEMY_COINS_SQL = `WITH held AS MATERIALIZED (
  SELECT "agent_id", sum("amount") AS "balance", gen_random_uuid() AS "transaction_id"
  FROM "ledger_entries"
  WHERE "account_kind" = 'agent' AND "type" = 'task_reward'
    AND NOT EXISTS (
      SELECT 1 FROM "ledger_entries" done
      WHERE done."reference" = '${COIN_UNWIND_REFERENCE}'
        AND done."agent_id" = "ledger_entries"."agent_id"
    )
  GROUP BY "agent_id"
  HAVING sum("amount") <> 0
)
INSERT INTO "ledger_entries"
  ("transaction_id", "account_kind", "agent_id", "system_account", "amount", "type", "memo", "reference", "created_at")
SELECT
  held."transaction_id",
  side."account_kind"::"ledger_account_kind",
  case when side."account_kind" = 'agent' then held."agent_id" end,
  case when side."account_kind" = 'system' then 'mint'::"system_account" end,
  case when side."account_kind" = 'agent' then -held."balance" else held."balance" end,
  'adjustment'::"ledger_entry_type",
  $memo$${COIN_UNWIND_MEMO}$memo$,
  '${COIN_UNWIND_REFERENCE}',
  now()
FROM held
CROSS JOIN (VALUES ('agent'), ('system')) AS side("account_kind");`

/**
 * Run the unwind against a database.
 *
 * Ran once by the migration. Exported because it is the statement a maintainer
 * would otherwise paste into `psql`, and because it is what the test drives.
 */
export async function unwindAcademyCoins(db: Database): Promise<void> {
  await db.execute(sql.raw(UNWIND_ACADEMY_COINS_SQL))
}
