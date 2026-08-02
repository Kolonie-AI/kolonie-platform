-- One Quest Credit is one US cent (kolonie-platform#218). The ledger's unit was
-- called a coin, and `governance/economy.md` §1 puts the coin ($KOL, on Solana)
-- and the credit (here, in Postgres) in different layers on purpose.
--
-- This renames and converts nothing. That is only safe because every reward in
-- the table is 0 — the Academy constraint forbids anything else and the quest
-- pilot has not started — and the block below is what makes that a checked
-- precondition rather than a remembered one. It is duplicated in
-- `src/credit-rename.ts` as `REWARD_RENAME_GUARD_SQL`, where its reasoning
-- lives and which is what the test drives; `credit-rename.test.ts` reads this
-- file and fails if the two drift apart.
DO $$
DECLARE offending bigint;
BEGIN
  SELECT count(*) INTO offending FROM "tasks" WHERE "reward_coins" <> 0;
  IF offending > 0 THEN
    RAISE EXCEPTION 'kolonie-platform#218 renames the reward column and converts nothing, because every value was 0 when it was written. % row(s) are non-zero, so a coin is being reinterpreted as a cent and a conversion decision is owed before this migration may run.', offending;
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "tasks" RENAME COLUMN "reward_coins" TO "reward_credits";--> statement-breakpoint
ALTER TABLE "erasures" RENAME COLUMN "coins_burned" TO "credits_burned";--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_academy_pays_no_coins";--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_reward_non_negative";--> statement-breakpoint
ALTER TABLE "erasures" DROP CONSTRAINT "erasures_amounts_non_negative";--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_academy_pays_no_credits" CHECK ("tasks"."kind" = 'quest' or "tasks"."reward_credits" = 0);--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_reward_non_negative" CHECK ("tasks"."reward_credits" >= 0 and "tasks"."reward_reputation" >= 0);--> statement-breakpoint
ALTER TABLE "erasures" ADD CONSTRAINT "erasures_amounts_non_negative" CHECK ("erasures"."credits_burned" >= 0 and "erasures"."reputation_destroyed" >= 0);