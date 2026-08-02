import { sql } from 'drizzle-orm'
import type { Database } from './client.js'

/**
 * The migration that renamed the ledger's unit from a coin to a Quest Credit.
 *
 * Named so the test can read it and check that the guard below is still the
 * guard that shipped — the same arrangement `coin-unwind.ts` and
 * `skill-backfill.ts` use, and for the same reason: a migration cannot import
 * TypeScript, and a statement nobody can test is a statement nobody can trust.
 */
export const CREDIT_RENAME_MIGRATION = '0074_the_ledger_holds_credits_not_coins.sql'

/**
 * Refuse the rename if any task carries a reward the rename would misinterpret.
 *
 * **`kolonie-platform#218` renames and deliberately converts nothing**, and the
 * argument for that is entirely about the data: every `reward_coins` in the table
 * was `0` when the issue was written, because `tasks_academy_pays_no_coins`
 * forbade anything else on an Academy row and the quest pilot had not started. A
 * rename of a column whose every value is zero has no data semantics to preserve.
 *
 * That is a *measurement*, not a property of the schema, and it is the kind of
 * measurement that quietly stops being true. If a quest row with a non-zero
 * reward exists by the time this runs, the old unit was a whole coin and the new
 * one is a cent — the same integer means a hundred times less money, and renaming
 * it silently would be the most expensive kind of correct-looking migration.
 *
 * So the assumption is enforced here rather than asserted in a comment. If it
 * does not hold, the migration aborts and somebody owes a conversion decision.
 * The alternative — writing a conversion path for values that do not exist — is
 * untested code that looks tested, which `#218` refused for exactly that reason.
 *
 * It takes the column name because the test has to drive it *after* the rename
 * has happened, when the column it guards is called `reward_credits`. The
 * migration passes the pre-rename name; the test passes the post-rename one and
 * gets the same statement.
 */
export function rewardRenameGuardSql(column: 'reward_coins' | 'reward_credits'): string {
  return `DO $$
DECLARE offending bigint;
BEGIN
  SELECT count(*) INTO offending FROM "tasks" WHERE "${column}" <> 0;
  IF offending > 0 THEN
    RAISE EXCEPTION 'kolonie-platform#218 renames the reward column and converts nothing, because every value was 0 when it was written. % row(s) are non-zero, so a coin is being reinterpreted as a cent and a conversion decision is owed before this migration may run.', offending;
  END IF;
END $$;`
}

/** The guard exactly as the migration carries it. */
export const REWARD_RENAME_GUARD_SQL = rewardRenameGuardSql('reward_coins')

/**
 * Run the guard against a database.
 *
 * Exported because it is what the test drives, and because it is the statement a
 * maintainer restoring a backup would want to run before applying the rename to
 * data the migration never saw.
 */
export async function assertNoRewardToConvert(
  db: Database,
  column: 'reward_coins' | 'reward_credits',
): Promise<void> {
  await db.execute(sql.raw(rewardRenameGuardSql(column)))
}
