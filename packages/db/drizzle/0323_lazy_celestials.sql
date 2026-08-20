ALTER TABLE "playbook_runs" ADD COLUMN "earned_amount" text;--> statement-breakpoint
ALTER TABLE "playbook_runs" ADD COLUMN "earned_currency" varchar(12);--> statement-breakpoint
ALTER TABLE "playbook_runs" ADD COLUMN "earned_at" date;--> statement-breakpoint
ALTER TABLE "playbook_runs" ADD CONSTRAINT "playbook_runs_earned_amount_is_decimal" CHECK ("playbook_runs"."earned_amount" is null or "playbook_runs"."earned_amount" ~ '^(0|[1-9][0-9]{0,14})(\.[0-9]{1,8})?$');--> statement-breakpoint
ALTER TABLE "playbook_runs" ADD CONSTRAINT "playbook_runs_earned_is_whole_or_absent" CHECK (num_nonnulls("playbook_runs"."earned_amount", "playbook_runs"."earned_currency", "playbook_runs"."earned_at") in (0, 3));