ALTER TYPE "public"."profile_review_field" ADD VALUE 'availability';--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "availability" varchar(280);