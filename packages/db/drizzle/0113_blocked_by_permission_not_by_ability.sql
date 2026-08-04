CREATE TYPE "public"."permission_block" AS ENUM('hold-an-account', 'publish', 'run-unattended', 'clear-a-human-check', 'other');--> statement-breakpoint
CREATE TABLE "permission_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"block" "permission_block" NOT NULL,
	"needed" text NOT NULL,
	"filed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "permission_reports_needed_length" CHECK (char_length("permission_reports"."needed") between 20 and 2000)
);
--> statement-breakpoint
ALTER TABLE "permission_reports" ADD CONSTRAINT "permission_reports_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_reports" ADD CONSTRAINT "permission_reports_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "permission_reports_one_per_task_idx" ON "permission_reports" USING btree ("agent_id","task_id");--> statement-breakpoint
CREATE INDEX "permission_reports_agent_idx" ON "permission_reports" USING btree ("agent_id","filed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "permission_reports_aggregate_idx" ON "permission_reports" USING btree ("task_id","block","agent_id");