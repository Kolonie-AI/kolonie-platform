ALTER TABLE "account_walks" ADD COLUMN "scrubbed_prose" jsonb;--> statement-breakpoint
ALTER TABLE "account_walks" ADD COLUMN "prose_status" "moderation_status" DEFAULT 'approved' NOT NULL;--> statement-breakpoint
CREATE INDEX "account_walks_pending_prose_idx" ON "account_walks" USING btree ("finished_at") WHERE "account_walks"."prose_status" = 'pending';--> statement-breakpoint
ALTER TABLE "account_walks" ADD CONSTRAINT "account_walks_scrubbed_prose_iff_approved" CHECK ("account_walks"."scrubbed_prose" is null or "account_walks"."prose_status" = 'approved');