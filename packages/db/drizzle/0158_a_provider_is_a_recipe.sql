CREATE TABLE "provider_recipes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"provider" text NOT NULL,
	"title" text NOT NULL,
	"joinable" boolean DEFAULT true NOT NULL,
	"refusal" text,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"proves" text,
	"caution" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_recipes_refusal_says_why" CHECK (("provider_recipes"."joinable" = true and "provider_recipes"."refusal" is null)
          or ("provider_recipes"."joinable" = false and "provider_recipes"."refusal" is not null)),
	CONSTRAINT "provider_recipes_joinable_has_steps" CHECK ("provider_recipes"."joinable" = false
          or (jsonb_array_length("provider_recipes"."steps") between 1 and 20
              and "provider_recipes"."proves" is not null)),
	CONSTRAINT "provider_recipes_refusal_is_empty" CHECK ("provider_recipes"."joinable" = true
          or (jsonb_array_length("provider_recipes"."steps") = 0 and "provider_recipes"."proves" is null)),
	CONSTRAINT "provider_recipes_proves_is_known" CHECK ("provider_recipes"."proves" is null
          or "provider_recipes"."proves" in ('rung', 'provider-mail', 'provider-post'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "provider_recipes_kind_provider_unique" ON "provider_recipes" USING btree ("kind","provider");