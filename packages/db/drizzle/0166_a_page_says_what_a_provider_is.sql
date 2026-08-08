ALTER TABLE "provider_recipes" ADD COLUMN "about" text;--> statement-breakpoint
ALTER TABLE "provider_recipes" ADD COLUMN "runtimes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_recipes" ADD COLUMN "paid" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_recipes" ADD CONSTRAINT "provider_recipes_runtime_notes_bounded" CHECK (jsonb_array_length("provider_recipes"."runtimes") <= 8);