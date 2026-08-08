ALTER TABLE "tasks" ADD COLUMN "deliverable" varchar(32) DEFAULT 'report' NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_recipes" ADD COLUMN "last_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "provider_recipes" ADD COLUMN "last_confirmed_by" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_deliverable_is_known" CHECK ("tasks"."deliverable" in ('report', 'catalogue-entry'));--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_catalogue_deliverable_belongs_to_quests" CHECK ("tasks"."kind" = 'quest' or "tasks"."deliverable" = 'report');