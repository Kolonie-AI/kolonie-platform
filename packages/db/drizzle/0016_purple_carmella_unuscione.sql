CREATE TYPE "public"."moderation_status" AS ENUM('pending', 'approved', 'rejected', 'merged');--> statement-breakpoint
CREATE TABLE "task_hints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"content" text NOT NULL,
	"sort_order" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_hints_content_length" CHECK (char_length("task_hints"."content") between 1 and 2000),
	CONSTRAINT "task_hints_sort_order_range" CHECK ("task_hints"."sort_order" between 0 and 999)
);
--> statement-breakpoint
CREATE TABLE "task_struggles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"content" text NOT NULL,
	"status" "moderation_status" DEFAULT 'pending' NOT NULL,
	"duplicate_of" uuid,
	"confirmations" integer DEFAULT 0 NOT NULL,
	"moderation_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"moderated_at" timestamp with time zone,
	CONSTRAINT "task_struggles_content_length" CHECK (char_length("task_struggles"."content") between 20 and 2000),
	CONSTRAINT "task_struggles_confirmations_non_negative" CHECK ("task_struggles"."confirmations" >= 0),
	CONSTRAINT "task_struggles_note_length" CHECK ("task_struggles"."moderation_note" is null or char_length("task_struggles"."moderation_note") <= 500),
	CONSTRAINT "task_struggles_moderated_at_matches_status" CHECK (("task_struggles"."status" in ('approved', 'rejected', 'merged')) = ("task_struggles"."moderated_at" is not null)),
	CONSTRAINT "task_struggles_duplicate_iff_merged" CHECK (("task_struggles"."status" = 'merged') = ("task_struggles"."duplicate_of" is not null)),
	CONSTRAINT "task_struggles_duplicate_not_self" CHECK ("task_struggles"."duplicate_of" is distinct from "task_struggles"."id")
);
--> statement-breakpoint
CREATE TABLE "task_tips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"content" text NOT NULL,
	"status" "moderation_status" DEFAULT 'pending' NOT NULL,
	"duplicate_of" uuid,
	"helpful_count" integer DEFAULT 0 NOT NULL,
	"unhelpful_count" integer DEFAULT 0 NOT NULL,
	"moderation_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"moderated_at" timestamp with time zone,
	CONSTRAINT "task_tips_content_length" CHECK (char_length("task_tips"."content") between 20 and 2000),
	CONSTRAINT "task_tips_counts_non_negative" CHECK ("task_tips"."helpful_count" >= 0 and "task_tips"."unhelpful_count" >= 0),
	CONSTRAINT "task_tips_note_length" CHECK ("task_tips"."moderation_note" is null or char_length("task_tips"."moderation_note") <= 500),
	CONSTRAINT "task_tips_moderated_at_matches_status" CHECK (("task_tips"."status" in ('approved', 'rejected', 'merged')) = ("task_tips"."moderated_at" is not null)),
	CONSTRAINT "task_tips_duplicate_iff_merged" CHECK (("task_tips"."status" = 'merged') = ("task_tips"."duplicate_of" is not null)),
	CONSTRAINT "task_tips_duplicate_not_self" CHECK ("task_tips"."duplicate_of" is distinct from "task_tips"."id")
);
--> statement-breakpoint
CREATE TABLE "tip_feedback" (
	"tip_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"helpful" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tip_feedback_tip_id_agent_id_pk" PRIMARY KEY("tip_id","agent_id")
);
--> statement-breakpoint
ALTER TABLE "task_hints" ADD CONSTRAINT "task_hints_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_struggles" ADD CONSTRAINT "task_struggles_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_struggles" ADD CONSTRAINT "task_struggles_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_struggles" ADD CONSTRAINT "task_struggles_duplicate_of_task_struggles_id_fk" FOREIGN KEY ("duplicate_of") REFERENCES "public"."task_struggles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_tips" ADD CONSTRAINT "task_tips_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_tips" ADD CONSTRAINT "task_tips_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_tips" ADD CONSTRAINT "task_tips_duplicate_of_task_tips_id_fk" FOREIGN KEY ("duplicate_of") REFERENCES "public"."task_tips"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_feedback" ADD CONSTRAINT "tip_feedback_tip_id_task_tips_id_fk" FOREIGN KEY ("tip_id") REFERENCES "public"."task_tips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_feedback" ADD CONSTRAINT "tip_feedback_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "task_hints_task_order_unique" ON "task_hints" USING btree ("task_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "task_struggles_task_agent_unique" ON "task_struggles" USING btree ("task_id","agent_id");--> statement-breakpoint
CREATE INDEX "task_struggles_approved_idx" ON "task_struggles" USING btree ("task_id","confirmations" DESC NULLS LAST) WHERE "task_struggles"."status" = 'approved';--> statement-breakpoint
CREATE INDEX "task_struggles_pending_idx" ON "task_struggles" USING btree ("created_at") WHERE "task_struggles"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "task_tips_task_agent_unique" ON "task_tips" USING btree ("task_id","agent_id");--> statement-breakpoint
CREATE INDEX "task_tips_approved_idx" ON "task_tips" USING btree ("task_id",("helpful_count" - "unhelpful_count") desc) WHERE "task_tips"."status" = 'approved';--> statement-breakpoint
CREATE INDEX "task_tips_pending_idx" ON "task_tips" USING btree ("created_at") WHERE "task_tips"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "tip_feedback_tip_idx" ON "tip_feedback" USING btree ("tip_id");