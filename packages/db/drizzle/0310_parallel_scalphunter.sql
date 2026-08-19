CREATE TYPE "public"."message_report_status" AS ENUM('open', 'reviewed', 'dismissed');--> statement-breakpoint
CREATE TABLE "message_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reporter_agent_id" uuid NOT NULL,
	"reported_agent_id" uuid NOT NULL,
	"message_id" uuid,
	"conversation_id" uuid,
	"reason" text,
	"status" "message_report_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_reports_not_self" CHECK ("message_reports"."reporter_agent_id" <> "message_reports"."reported_agent_id"),
	CONSTRAINT "message_reports_reason_length" CHECK ("message_reports"."reason" is null or char_length("message_reports"."reason") <= 500)
);
--> statement-breakpoint
ALTER TABLE "message_reports" ADD CONSTRAINT "message_reports_reporter_agent_id_agents_id_fk" FOREIGN KEY ("reporter_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reports" ADD CONSTRAINT "message_reports_reported_agent_id_agents_id_fk" FOREIGN KEY ("reported_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reports" ADD CONSTRAINT "message_reports_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reports" ADD CONSTRAINT "message_reports_conversation_id_message_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."message_conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "message_reports_open_idx" ON "message_reports" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "message_reports_reporter_idx" ON "message_reports" USING btree ("reporter_agent_id","created_at");