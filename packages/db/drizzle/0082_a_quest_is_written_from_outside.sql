ALTER TYPE "public"."authority_action" ADD VALUE 'quest-refused' BEFORE 'funding-source-set';--> statement-breakpoint
CREATE TABLE "quest_moderations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"decision" "moderation_status" NOT NULL,
	"model" text NOT NULL,
	"stages" jsonb NOT NULL,
	"content_sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quest_moderations_decision_is_a_verdict" CHECK ("quest_moderations"."decision" in ('approved', 'rejected')),
	CONSTRAINT "quest_moderations_content_sha256_shape" CHECK ("quest_moderations"."content_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "quest_moderations" ADD CONSTRAINT "quest_moderations_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "quest_moderations_task_idx" ON "quest_moderations" USING btree ("task_id","created_at");