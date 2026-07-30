ALTER TYPE "public"."role" ADD VALUE 'tester';--> statement-breakpoint
CREATE TABLE "task_resets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"superseded_submission_id" uuid NOT NULL,
	"reason" varchar(500) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "test_rerun" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "submission_id" uuid;--> statement-breakpoint
ALTER TABLE "task_resets" ADD CONSTRAINT "task_resets_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_resets" ADD CONSTRAINT "task_resets_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_resets" ADD CONSTRAINT "task_resets_superseded_submission_id_submissions_id_fk" FOREIGN KEY ("superseded_submission_id") REFERENCES "public"."submissions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_resets_agent_id_task_id_created_at_idx" ON "task_resets" USING btree ("agent_id","task_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "support_tickets_one_per_submission" ON "support_tickets" USING btree ("submission_id") WHERE "support_tickets"."submission_id" is not null;