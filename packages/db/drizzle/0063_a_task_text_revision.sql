ALTER TABLE "tasks" ADD COLUMN "text_revised_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
-- Backfilled from `created_at`, never left at the `now()` the default would give.
--
-- This column demotes every briefing claim not confirmed since it, so a backfill
-- of `now()` would demote the Colony's entire published corpus at the moment the
-- migration ran — every claim on every task, silently, because none of them can
-- have been confirmed after a timestamp written during the deploy.
--
-- `created_at` is the earliest honest answer: the Colony has no record of the
-- text having been revised, so it says the text is as old as the task. Nothing is
-- demoted that was not already out of the recency bounds, which is correct —
-- until a revision actually happens, this column must change nothing.
UPDATE "tasks" SET "text_revised_at" = "created_at";
