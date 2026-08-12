ALTER TABLE "provider_recipes" ADD COLUMN "walked_recipe" jsonb;--> statement-breakpoint
ALTER TABLE "account_walks" ADD COLUMN "recipe" jsonb;