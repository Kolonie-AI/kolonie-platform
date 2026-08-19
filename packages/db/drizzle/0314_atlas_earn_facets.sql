CREATE TABLE "provider_recipe_facets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recipe_id" uuid NOT NULL,
	"axis" text NOT NULL,
	"slug" text NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_recipe_facets_axis_is_known" CHECK ("provider_recipe_facets"."axis" in ('earn')),
	CONSTRAINT "provider_recipe_facets_slug_is_known" CHECK ("provider_recipe_facets"."axis" <> 'earn' or "provider_recipe_facets"."slug" in (
            'affiliate-referral', 'bounty-board', 'gig-marketplace', 'creator-payout', 'grant-quest'
          ))
);
--> statement-breakpoint
ALTER TABLE "provider_recipe_facets" ADD CONSTRAINT "provider_recipe_facets_recipe_id_provider_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."provider_recipes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_recipe_facets_once" ON "provider_recipe_facets" USING btree ("recipe_id","axis","slug");--> statement-breakpoint
CREATE INDEX "provider_recipe_facets_by_facet" ON "provider_recipe_facets" USING btree ("axis","slug","recipe_id");