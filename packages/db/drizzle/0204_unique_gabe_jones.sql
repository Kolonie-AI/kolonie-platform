ALTER TABLE "provider_recipes" ADD COLUMN "after_proof" jsonb;--> statement-breakpoint
ALTER TABLE "provider_recipes" ADD CONSTRAINT "provider_recipes_after_proof_is_a_route" CHECK ("provider_recipes"."after_proof" is null
          or ("provider_recipes"."status" in ('joinable', 'retired')
              and jsonb_typeof("provider_recipes"."after_proof") = 'object'
              and jsonb_typeof("provider_recipes"."after_proof" -> 'capability') = 'string'
              and length("provider_recipes"."after_proof" ->> 'capability') between 3 and 32
              and ("provider_recipes"."after_proof" ->> 'capability') ~ '^[a-z][a-z0-9-]*$'
              and jsonb_typeof("provider_recipes"."after_proof" -> 'steps') = 'array'
              and jsonb_array_length("provider_recipes"."after_proof" -> 'steps') between 1 and 20
              and not jsonb_path_exists(
                "provider_recipes"."after_proof",
                '$.steps[*] ? (@.actor != "agent" || !exists(@.instruction))'
              )));