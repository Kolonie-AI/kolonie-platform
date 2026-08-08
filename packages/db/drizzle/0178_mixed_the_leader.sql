ALTER TABLE "provider_recipes" DROP CONSTRAINT "provider_recipes_refusal_is_empty";--> statement-breakpoint
ALTER TABLE "provider_recipes" DROP CONSTRAINT "provider_recipes_refusal_says_why";--> statement-breakpoint
ALTER TABLE "provider_recipes" DROP CONSTRAINT "provider_recipes_joinable_has_steps";--> statement-breakpoint
ALTER TABLE "provider_recipes" DROP COLUMN "joinable";--> statement-breakpoint
ALTER TABLE "provider_recipes" ADD CONSTRAINT "provider_recipes_status_is_known" CHECK ("provider_recipes"."status" in ('joinable', 'refused', 'unwritten'));--> statement-breakpoint
ALTER TABLE "provider_recipes" ADD CONSTRAINT "provider_recipes_unjoinable_is_empty" CHECK ("provider_recipes"."status" = 'joinable'
          or (jsonb_array_length("provider_recipes"."steps") = 0 and "provider_recipes"."proves" is null));--> statement-breakpoint
ALTER TABLE "provider_recipes" ADD CONSTRAINT "provider_recipes_refusal_says_why" CHECK (("provider_recipes"."status" = 'refused' and "provider_recipes"."refusal" is not null)
          or ("provider_recipes"."status" <> 'refused' and "provider_recipes"."refusal" is null));--> statement-breakpoint
ALTER TABLE "provider_recipes" ADD CONSTRAINT "provider_recipes_joinable_has_steps" CHECK ("provider_recipes"."status" <> 'joinable'
          or (jsonb_array_length("provider_recipes"."steps") between 1 and 20
              and "provider_recipes"."proves" is not null));