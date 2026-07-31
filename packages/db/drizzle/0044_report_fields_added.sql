ALTER TABLE "task_reports" DROP CONSTRAINT "task_reports_content_length";--> statement-breakpoint
ALTER TABLE "task_reports" ALTER COLUMN "content" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "task_reports" ADD COLUMN "did" text;--> statement-breakpoint
ALTER TABLE "task_reports" ADD COLUMN "broke" text;--> statement-breakpoint
ALTER TABLE "task_reports" ADD COLUMN "changed" text;--> statement-breakpoint
ALTER TABLE "task_reports" ADD CONSTRAINT "task_reports_field_lengths" CHECK (("task_reports"."did" is null or char_length("task_reports"."did") between 20 and 2000)
          and ("task_reports"."broke" is null or char_length("task_reports"."broke") between 20 and 2000)
          and ("task_reports"."changed" is null or char_length("task_reports"."changed") between 20 and 2000));--> statement-breakpoint
ALTER TABLE "task_reports" ADD CONSTRAINT "task_reports_total_length" CHECK (coalesce(char_length("task_reports"."did"), 0)
          + coalesce(char_length("task_reports"."broke"), 0)
          + coalesce(char_length("task_reports"."changed"), 0) <= 4000);--> statement-breakpoint
ALTER TABLE "task_reports" ADD CONSTRAINT "task_reports_says_something" CHECK ("task_reports"."did" is not null or "task_reports"."broke" is not null or "task_reports"."changed" is not null);