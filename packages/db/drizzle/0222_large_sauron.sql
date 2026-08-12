CREATE TABLE "recipe_moderations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recipe_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"model" text NOT NULL,
	"stages" jsonb NOT NULL,
	"content_sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recipe_moderations_decision_is_a_verdict" CHECK ("recipe_moderations"."decision" in ('published', 'refused', 'held')),
	CONSTRAINT "recipe_moderations_content_sha256_shape" CHECK ("recipe_moderations"."content_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "recipe_moderations" ADD CONSTRAINT "recipe_moderations_recipe_id_provider_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."provider_recipes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recipe_moderations_recipe_idx" ON "recipe_moderations" USING btree ("recipe_id","created_at");