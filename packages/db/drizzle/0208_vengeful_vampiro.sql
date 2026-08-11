ALTER TABLE "provider_recipes" ADD COLUMN "reaches" jsonb;--> statement-breakpoint
ALTER TABLE "provider_recipes" ADD CONSTRAINT "provider_recipes_reach_follows_a_proof" CHECK ("provider_recipes"."reaches" is null
          or ("provider_recipes"."proves" is not null
              and "provider_recipes"."reaches" ? 'capability'
              and jsonb_array_length("provider_recipes"."reaches" -> 'steps') >= 1));--> statement-breakpoint
ALTER TABLE "provider_recipes" ADD CONSTRAINT "provider_recipes_reach_shares_the_step_budget" CHECK (jsonb_array_length("provider_recipes"."steps")
            + coalesce(jsonb_array_length("provider_recipes"."reaches" -> 'steps'), 0)
          <= 20);--> statement-breakpoint
ALTER TABLE "provider_recipes" ADD CONSTRAINT "provider_recipes_published_reach_is_written" CHECK ("provider_recipes"."status" in ('draft', 'retired')
          or "provider_recipes"."reaches" is null
          or not jsonb_path_exists("provider_recipes"."reaches" -> 'steps', '$[*] ? (!exists(@.instruction))'));--> statement-breakpoint
ALTER TABLE "provider_recipes" ADD CONSTRAINT "provider_recipes_reach_is_walked_by_the_agent" CHECK ("provider_recipes"."reaches" is null
          or not jsonb_path_exists("provider_recipes"."reaches" -> 'steps', '$[*] ? (@.actor <> "agent")'));