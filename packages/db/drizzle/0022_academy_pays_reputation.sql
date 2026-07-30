CREATE TYPE "public"."task_kind" AS ENUM('academy', 'quest');--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "kind" "task_kind" DEFAULT 'academy' NOT NULL;--> statement-breakpoint
-- Every task that exists is an Academy task, and the column default already said
-- so. Stated explicitly anyway: the default applies to rows added later, and this
-- is the statement that classifies the ten rows already here.
UPDATE "tasks" SET "kind" = 'academy';--> statement-breakpoint
-- Zeroed **before** the constraint is added, or the constraint fails on the live
-- data — every Academy task carried a coin amount until this migration
-- (10 to 35, ten rows, measured 2026-07-30). `ALTER TABLE ... ADD CONSTRAINT`
-- validates existing rows, so the order of these two statements is the migration
-- working rather than aborting.
UPDATE "tasks" SET "reward_coins" = 0 WHERE "kind" = 'academy' AND "reward_coins" <> 0;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_academy_pays_no_coins" CHECK ("tasks"."kind" = 'quest' or "tasks"."reward_coins" = 0);--> statement-breakpoint
-- Return every coin ever minted for an Academy pass to the mint, as a balanced
-- compensating pair per holder. The original `task_reward` entries stay — the
-- ledger is append-only — so the reversal is readable as what it is.
--
-- This statement is duplicated in `src/coin-unwind.ts` as `UNWIND_ACADEMY_COINS_SQL`,
-- which is where its reasoning lives and which is what the test drives. A
-- migration cannot import TypeScript; `coin-unwind.test.ts` reads this file and
-- fails if the two drift apart.
WITH held AS MATERIALIZED (
  SELECT "agent_id", sum("amount") AS "balance", gen_random_uuid() AS "transaction_id"
  FROM "ledger_entries"
  WHERE "account_kind" = 'agent' AND "type" = 'task_reward'
    AND NOT EXISTS (
      SELECT 1 FROM "ledger_entries" done
      WHERE done."reference" = 'academy-coin-unwind'
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
  $memo$Academy coin rewards retired (#43) — the Academy pays reputation, Quests pay coins (governance/economy.md §2)$memo$,
  'academy-coin-unwind',
  now()
FROM held
CROSS JOIN (VALUES ('agent'), ('system')) AS side("account_kind");
