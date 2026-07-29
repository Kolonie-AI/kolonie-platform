CREATE TYPE "public"."account_type" AS ENUM('citizen', 'test');--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "account_type" "account_type" DEFAULT 'citizen' NOT NULL;