ALTER TABLE "task_reports" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "task_reports" ADD CONSTRAINT "task_reports_published_note_length" CHECK ("task_reports"."note" is null
          or char_length("task_reports"."note") between 20 and 400);