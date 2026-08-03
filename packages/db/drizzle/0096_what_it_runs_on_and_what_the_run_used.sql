ALTER TYPE "public"."runtime_field" ADD VALUE 'os';--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "os" varchar(64);--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "runtime_tools" varchar(64)[];