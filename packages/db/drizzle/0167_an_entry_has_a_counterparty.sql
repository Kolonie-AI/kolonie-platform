CREATE TABLE "entry_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"provider" text NOT NULL,
	"author" text NOT NULL,
	"proposed" jsonb NOT NULL,
	"note" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"proposed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "entry_proposals_author_is_known" CHECK ("entry_proposals"."author" in ('citizen', 'claimed-provider')),
	CONSTRAINT "entry_proposals_status_is_known" CHECK ("entry_proposals"."status" in ('pending', 'accepted', 'refused')),
	CONSTRAINT "entry_proposals_decided_has_a_date" CHECK (("entry_proposals"."status" = 'pending' and "entry_proposals"."decided_at" is null)
          or ("entry_proposals"."status" <> 'pending' and "entry_proposals"."decided_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "provider_claims" (
	"provider" text PRIMARY KEY NOT NULL,
	"method" text NOT NULL,
	"contact" text NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "provider_recipes" ADD COLUMN "referral" jsonb;--> statement-breakpoint
ALTER TABLE "provider_recipes" ADD COLUMN "contact" text;--> statement-breakpoint
ALTER TABLE "provider_recipes" ADD CONSTRAINT "provider_recipes_referral_records_its_check" CHECK ("provider_recipes"."referral" is null
          or ("provider_recipes"."referral" ? 'url'
              and "provider_recipes"."referral" ? 'termsNote'
              and "provider_recipes"."referral" ? 'checkedBy'
              and "provider_recipes"."referral" ? 'checkedAt'
              and length("provider_recipes"."referral" ->> 'termsNote') > 0));