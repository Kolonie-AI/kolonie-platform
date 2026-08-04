CREATE TYPE "public"."quest_report_kind" AS ENUM('unclear', 'feedback', 'declined');--> statement-breakpoint
CREATE TABLE "quest_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"kind" "quest_report_kind" NOT NULL,
	"text" text NOT NULL,
	"scrubbed" text,
	"status" "moderation_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quest_reports_text_present" CHECK (char_length(btrim("quest_reports"."text")) between 1 and 2000),
	CONSTRAINT "quest_reports_declined_is_never_scrubbed" CHECK ("quest_reports"."kind" <> 'declined' or "quest_reports"."scrubbed" is null)
);
--> statement-breakpoint
ALTER TABLE "quest_reports" ADD CONSTRAINT "quest_reports_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_reports" ADD CONSTRAINT "quest_reports_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "quest_reports_one_per_citizen" ON "quest_reports" USING btree ("task_id","agent_id");--> statement-breakpoint
CREATE INDEX "quest_reports_task_kind_idx" ON "quest_reports" USING btree ("task_id","kind");