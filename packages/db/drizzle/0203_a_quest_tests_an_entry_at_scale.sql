ALTER TABLE "tasks" DROP CONSTRAINT "tasks_deliverable_is_known";--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_catalogue_provider_iff_catalogue_entry";--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "walks_asked" integer;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_walks_asked_belongs_to_its_deliverable" CHECK (("tasks"."deliverable" = 'entry-walks' and "tasks"."walks_asked" is not null
           and "tasks"."walks_asked" >= 1)
          or ("tasks"."deliverable" <> 'entry-walks' and "tasks"."walks_asked" is null));--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_entry_walks_names_its_entry" CHECK ("tasks"."deliverable" <> 'entry-walks' or "tasks"."catalogue_provider" is not null);--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_deliverable_is_known" CHECK ("tasks"."deliverable" in ('report', 'catalogue-entry', 'entry-walks'));--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_catalogue_provider_iff_catalogue_entry" CHECK ("tasks"."catalogue_provider" is null
          or "tasks"."deliverable" in ('catalogue-entry', 'entry-walks'));