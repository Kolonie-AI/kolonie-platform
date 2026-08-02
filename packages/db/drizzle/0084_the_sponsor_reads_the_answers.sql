ALTER TABLE "quest_answers" DROP CONSTRAINT "quest_answers_submission_id_submissions_id_fk";
--> statement-breakpoint
ALTER TABLE "quest_answers" ALTER COLUMN "submission_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "quest_answers" ADD COLUMN "report_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "quest_answers" ADD COLUMN "accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "quest_answers" ADD COLUMN "runtime" text;--> statement-breakpoint
ALTER TABLE "quest_answers" ADD CONSTRAINT "quest_answers_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "quest_answers_report_idx" ON "quest_answers" USING btree ("report_id");--> statement-breakpoint
CREATE INDEX "quest_answers_accepted_idx" ON "quest_answers" USING btree ("task_id","accepted_at") WHERE "quest_answers"."accepted_at" is not null;