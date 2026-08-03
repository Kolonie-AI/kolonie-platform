CREATE TABLE "quest_audits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"submission_id" uuid NOT NULL,
	"steward_id" uuid,
	"agrees" boolean NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quest_audits_reason_length" CHECK (char_length("quest_audits"."reason") between 10 and 1000)
);
--> statement-breakpoint
ALTER TABLE "quest_audits" ADD CONSTRAINT "quest_audits_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_audits" ADD CONSTRAINT "quest_audits_steward_id_agents_id_fk" FOREIGN KEY ("steward_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "quest_audits_one_per_submission" ON "quest_audits" USING btree ("submission_id");--> statement-breakpoint
CREATE INDEX "quest_audits_window_idx" ON "quest_audits" USING btree ("created_at","agrees");