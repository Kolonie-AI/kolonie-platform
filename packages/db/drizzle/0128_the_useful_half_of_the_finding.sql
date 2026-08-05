ALTER TABLE "provider_reports" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "provider_reports" ADD COLUMN "scrubbed_reason" text;--> statement-breakpoint
ALTER TABLE "provider_reports" ADD COLUMN "reason_status" "moderation_status" DEFAULT 'approved' NOT NULL;--> statement-breakpoint
CREATE INDEX "provider_reports_pending_reason_idx" ON "provider_reports" USING btree ("noted_at") WHERE "provider_reports"."reason_status" = 'pending';--> statement-breakpoint
ALTER TABLE "provider_reports" ADD CONSTRAINT "provider_reports_scrubbed_iff_approved" CHECK ("provider_reports"."scrubbed_reason" is null or ("provider_reports"."reason_status" = 'approved' and "provider_reports"."reason" is not null));--> statement-breakpoint
ALTER TABLE "provider_reports" ADD CONSTRAINT "provider_reports_reason_length" CHECK ("provider_reports"."reason" is null
          or char_length(btrim("provider_reports"."reason")) between 1 and 300);