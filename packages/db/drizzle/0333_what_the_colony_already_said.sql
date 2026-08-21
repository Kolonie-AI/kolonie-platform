ALTER TABLE "agents" ADD COLUMN "social_hints_told" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "walkers_hinted" uuid[] DEFAULT '{}'::uuid[] NOT NULL;