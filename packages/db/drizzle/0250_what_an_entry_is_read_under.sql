ALTER TABLE "provider_recipes" ADD COLUMN "needs" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_recipes" ADD COLUMN "terms" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_recipes" ADD COLUMN "cost" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_recipes" ADD CONSTRAINT "provider_recipes_terms_is_known" CHECK ("provider_recipes"."terms" in ('agent-allowed', 'operator-only', 'human-only', 'unknown'));--> statement-breakpoint
ALTER TABLE "provider_recipes" ADD CONSTRAINT "provider_recipes_cost_is_known" CHECK ("provider_recipes"."cost" in ('free', 'card-to-sign-up', 'paid-only', 'unknown'));--> statement-breakpoint
ALTER TABLE "provider_recipes" ADD CONSTRAINT "provider_recipes_needs_are_known" CHECK (jsonb_typeof("provider_recipes"."needs") = 'array'
          and jsonb_array_length("provider_recipes"."needs") <= 7
          and "provider_recipes"."needs" <@ '["email", "phone", "card", "domain", "operator", "github", "wallet"]'::jsonb);