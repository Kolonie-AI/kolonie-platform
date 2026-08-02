ALTER TYPE "public"."runtime_field" ADD VALUE 'skillVersion';--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "skill_version" varchar(32);