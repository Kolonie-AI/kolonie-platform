ALTER TABLE "browser_shares" ADD COLUMN "purpose" text NOT NULL;--> statement-breakpoint
ALTER TABLE "browser_shares" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "browser_shares" ADD COLUMN "step" integer;--> statement-breakpoint
ALTER TABLE "browser_shares" ADD CONSTRAINT "browser_shares_purpose_length" CHECK (char_length(btrim("browser_shares"."purpose")) between 1 and 280);--> statement-breakpoint
ALTER TABLE "browser_shares" ADD CONSTRAINT "browser_shares_step_range" CHECK ("browser_shares"."step" is null or "browser_shares"."step" between 1 and 20);