ALTER TABLE "tasks" ADD COLUMN "catalogue_provider" text;--> statement-breakpoint
ALTER TABLE "provider_recipes" ADD COLUMN "proves_task" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_catalogue_provider_iff_catalogue_entry" CHECK ("tasks"."catalogue_provider" is null or "tasks"."deliverable" = 'catalogue-entry');--> statement-breakpoint
ALTER TABLE "provider_recipes" ADD CONSTRAINT "provider_recipes_proves_task_iff_rung" CHECK ("provider_recipes"."proves_task" is null or "provider_recipes"."proves" = 'rung');