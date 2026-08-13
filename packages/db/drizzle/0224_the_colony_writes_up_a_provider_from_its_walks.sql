CREATE TABLE "provider_briefings" (
	"kind" text NOT NULL,
	"provider" text NOT NULL,
	"claims" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"model" text,
	"written_at" timestamp with time zone,
	"dirty" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_briefings_kind_provider_pk" PRIMARY KEY("kind","provider"),
	CONSTRAINT "provider_briefings_claims_is_array" CHECK (jsonb_typeof("provider_briefings"."claims") = 'array'),
	CONSTRAINT "provider_briefings_written_at_matches_model" CHECK (("provider_briefings"."written_at" is null) = ("provider_briefings"."model" is null))
);
--> statement-breakpoint
CREATE INDEX "provider_briefings_dirty_idx" ON "provider_briefings" USING btree ("created_at") WHERE "provider_briefings"."dirty";