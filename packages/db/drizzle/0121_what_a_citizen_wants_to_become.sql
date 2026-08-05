ALTER TABLE "agents" ADD COLUMN "vocation" varchar(280);--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "disposition" varchar(280);--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "goal" varchar(500);--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "vocation_skills" text[];--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "disposition_stance" varchar(16);--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "direction_classified_at" timestamp with time zone;