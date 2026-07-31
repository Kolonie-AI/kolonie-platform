CREATE TABLE "report_feedback" (
	"report_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"helpful" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "report_feedback_report_id_agent_id_pk" PRIMARY KEY("report_id","agent_id")
);
--> statement-breakpoint
CREATE TABLE "task_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"content" text NOT NULL,
	"status" "moderation_status" DEFAULT 'pending' NOT NULL,
	"duplicate_of" uuid,
	"confirmations" integer DEFAULT 0 NOT NULL,
	"helpful_count" integer DEFAULT 0 NOT NULL,
	"unhelpful_count" integer DEFAULT 0 NOT NULL,
	"moderation_note" text,
	"confidential_spans" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"moderated_at" timestamp with time zone,
	CONSTRAINT "task_reports_content_length" CHECK (char_length("task_reports"."content") between 20 and 2000),
	CONSTRAINT "task_reports_confirmations_non_negative" CHECK ("task_reports"."confirmations" >= 0),
	CONSTRAINT "task_reports_counts_non_negative" CHECK ("task_reports"."helpful_count" >= 0 and "task_reports"."unhelpful_count" >= 0),
	CONSTRAINT "task_reports_confidential_spans_is_array" CHECK (jsonb_typeof("task_reports"."confidential_spans") = 'array'),
	CONSTRAINT "task_reports_note_length" CHECK ("task_reports"."moderation_note" is null or char_length("task_reports"."moderation_note") <= 500),
	CONSTRAINT "task_reports_moderated_at_matches_status" CHECK (("task_reports"."status" in ('approved', 'rejected', 'merged')) = ("task_reports"."moderated_at" is not null)),
	CONSTRAINT "task_reports_duplicate_iff_merged" CHECK (("task_reports"."status" = 'merged') = ("task_reports"."duplicate_of" is not null)),
	CONSTRAINT "task_reports_duplicate_not_self" CHECK ("task_reports"."duplicate_of" is distinct from "task_reports"."id")
);
--> statement-breakpoint
ALTER TABLE "email_challenges" DROP CONSTRAINT "email_challenges_mismatch_is_whole";--> statement-breakpoint
ALTER TABLE "email_challenges" DROP CONSTRAINT "email_challenges_mismatched_from_length";--> statement-breakpoint
ALTER TABLE "moderations" DROP CONSTRAINT "moderations_one_subject";--> statement-breakpoint
DROP INDEX "moderations_struggle_idx";--> statement-breakpoint
DROP INDEX "moderations_tip_idx";--> statement-breakpoint
ALTER TABLE "moderations" ALTER COLUMN "subject_kind" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "moderations" ADD COLUMN "report_id" uuid;--> statement-breakpoint
ALTER TABLE "report_feedback" ADD CONSTRAINT "report_feedback_report_id_task_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."task_reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_feedback" ADD CONSTRAINT "report_feedback_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_reports" ADD CONSTRAINT "task_reports_attempt_id_task_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."task_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_reports" ADD CONSTRAINT "task_reports_duplicate_of_task_reports_id_fk" FOREIGN KEY ("duplicate_of") REFERENCES "public"."task_reports"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "report_feedback_report_idx" ON "report_feedback" USING btree ("report_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_reports_attempt_unique" ON "task_reports" USING btree ("attempt_id");--> statement-breakpoint
CREATE INDEX "task_reports_approved_idx" ON "task_reports" USING btree ("confirmations" DESC NULLS LAST) WHERE "task_reports"."status" = 'approved';--> statement-breakpoint
CREATE INDEX "task_reports_pending_idx" ON "task_reports" USING btree ("created_at") WHERE "task_reports"."status" = 'pending';--> statement-breakpoint
ALTER TABLE "moderations" ADD CONSTRAINT "moderations_report_id_task_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."task_reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "moderations_report_idx" ON "moderations" USING btree ("report_id","created_at");--> statement-breakpoint
ALTER TABLE "email_challenges" DROP COLUMN "mismatched_at";--> statement-breakpoint
ALTER TABLE "email_challenges" DROP COLUMN "mismatched_from";