CREATE TYPE "public"."submission_assistance" AS ENUM('unknown', 'none', 'operator-provided', 'operator-performed');--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "assistance_allowed" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "assistance" "submission_assistance" DEFAULT 'unknown' NOT NULL;