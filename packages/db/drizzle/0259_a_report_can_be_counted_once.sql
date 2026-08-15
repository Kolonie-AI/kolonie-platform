ALTER TABLE "arrival_reports" ADD COLUMN "acted_on_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "arrival_reports" ADD COLUMN "issue_url" text;--> statement-breakpoint
CREATE INDEX "arrival_reports_acted_on_idx" ON "arrival_reports" USING btree ("acted_on_at","created_at");--> statement-breakpoint
ALTER TABLE "arrival_reports" ADD CONSTRAINT "arrival_reports_filed_is_acted_on" CHECK ("arrival_reports"."issue_url" is null or "arrival_reports"."acted_on_at" is not null);