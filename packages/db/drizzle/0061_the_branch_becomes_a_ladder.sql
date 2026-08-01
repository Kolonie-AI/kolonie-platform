-- `#160`: the browser branch becomes a staged ladder.
--
-- `kind` stops being a two-value check constraint and becomes a registry
-- (`packages/core/src/browser/stage.ts`), because a new stage must not be a
-- migration. What replaces the constraint is the mint surface, which refuses an
-- unknown stage and can say which ones exist — the same trade `SkillSchema` and
-- `TaskTypeSchema` already made.
ALTER TABLE "browser_challenges" DROP CONSTRAINT "browser_challenges_kind_known";--> statement-breakpoint

-- The two step constraints are rebuilt below against `steps_required` instead of
-- a literal, so they hold for every stage without naming any of them.
ALTER TABLE "browser_challenges" DROP CONSTRAINT "browser_challenges_capability_complete";--> statement-breakpoint
ALTER TABLE "browser_challenges" DROP CONSTRAINT "browser_challenges_steps_in_range";--> statement-breakpoint

ALTER TABLE "browser_challenges" ADD COLUMN "steps_required" smallint DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "browser_challenges" ADD COLUMN "variant" text;--> statement-breakpoint
ALTER TABLE "browser_challenges" ADD COLUMN "observation" jsonb;--> statement-breakpoint

-- **This backfill has to run before the constraints, and without it the
-- migration fails on production data.** Proved rather than reasoned: against a
-- database migrated to 0058 and seeded with a cleared row of the retired stage,
-- omitting this line makes Postgres refuse with
-- `browser_challenges_complete_when_verified is violated by some row`.
--
-- The retired third-party stage was never cleared by reporting steps — it was
-- cleared by a token redemption, which set `verified_at` and left `steps` at 0.
-- Measured on the live shape 2026-08-01: every `captcha` row carries `steps = 0`,
-- including the cleared ones.
--
-- The new completeness constraint reads *cleared implies steps = steps_required*.
-- With the column defaulted to the entry rung's 3, every historical row of that
-- stage would violate it the moment the constraint is added. Rewriting their
-- `steps` to 3 instead would be rewriting the record of what a citizen actually
-- did, which this repository does not do to evidence behind a paid reward.
--
-- So the required count follows the rows rather than the rows following the
-- count. The registry says the same thing — that stage is declared with 0 steps —
-- and its comment carries this argument so the number is not later "tidied" to 1.
UPDATE "browser_challenges" SET "steps_required" = 0 WHERE "kind" = 'captcha';--> statement-breakpoint

ALTER TABLE "browser_challenges" ADD CONSTRAINT "browser_challenges_complete_when_verified" CHECK ("browser_challenges"."verified_at" is null or "browser_challenges"."steps" = "browser_challenges"."steps_required");--> statement-breakpoint
ALTER TABLE "browser_challenges" ADD CONSTRAINT "browser_challenges_steps_in_range" CHECK ("browser_challenges"."steps" >= 0 and "browser_challenges"."steps" <= "browser_challenges"."steps_required");
