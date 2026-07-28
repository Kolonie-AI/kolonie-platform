CREATE TYPE "public"."reputation_reason" AS ENUM('task_passed', 'review_accepted', 'contribution_merged', 'red_line_violation', 'adjustment');--> statement-breakpoint
CREATE TABLE "reputation_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"delta" integer NOT NULL,
	"reason" "reputation_reason" NOT NULL,
	"submission_id" uuid,
	"memo" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reputation_events_delta_non_zero" CHECK ("reputation_events"."delta" <> 0),
	CONSTRAINT "reputation_events_negative_reasons" CHECK ("reputation_events"."delta" > 0 or "reputation_events"."reason" in ('red_line_violation', 'adjustment'))
);
--> statement-breakpoint
ALTER TABLE "reputation_events" ADD CONSTRAINT "reputation_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reputation_events" ADD CONSTRAINT "reputation_events_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reputation_events_agent_id_idx" ON "reputation_events" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "reputation_events_submission_id_idx" ON "reputation_events" USING btree ("submission_id") WHERE "reputation_events"."submission_id" is not null;