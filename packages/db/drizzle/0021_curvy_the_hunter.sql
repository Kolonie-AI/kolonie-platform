CREATE TYPE "public"."report_outcome" AS ENUM('stored', 'replaced', 'superseded');--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "report" text;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "report_outcome" "report_outcome";--> statement-breakpoint
ALTER TABLE "task_struggles" ADD COLUMN "submission_id" uuid;--> statement-breakpoint
ALTER TABLE "task_tips" ADD COLUMN "submission_id" uuid;--> statement-breakpoint
ALTER TABLE "task_struggles" ADD CONSTRAINT "task_struggles_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_tips" ADD CONSTRAINT "task_tips_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_report_length" CHECK ("submissions"."report" is null or char_length("submissions"."report") between 20 and 2000);--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_report_outcome_needs_report" CHECK ("submissions"."report_outcome" is null or "submissions"."report" is not null);