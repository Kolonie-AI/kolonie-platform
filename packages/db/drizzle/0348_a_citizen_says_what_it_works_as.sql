ALTER TYPE "public"."profile_review_field" ADD VALUE 'profession';--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "profession" varchar(280);