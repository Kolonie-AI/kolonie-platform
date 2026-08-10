CREATE TABLE "atlas_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"source" text NOT NULL,
	"why" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_reason" text,
	"merged_into" text,
	"proposed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "atlas_proposals_provider_length" CHECK (length("atlas_proposals"."provider") <= 128),
	CONSTRAINT "atlas_proposals_source_is_known" CHECK ("atlas_proposals"."source" in ('provider', 'citizen', 'operator')),
	CONSTRAINT "atlas_proposals_status_is_known" CHECK ("atlas_proposals"."status" in ('pending', 'accepted', 'refused', 'merged')),
	CONSTRAINT "atlas_proposals_why_length" CHECK ("atlas_proposals"."why" is null or length("atlas_proposals"."why") <= 500),
	CONSTRAINT "atlas_proposals_refusal_says_why" CHECK (("atlas_proposals"."status" = 'refused' and "atlas_proposals"."decided_reason" is not null
           and length("atlas_proposals"."decided_reason") <= 500)
          or ("atlas_proposals"."status" <> 'refused' and "atlas_proposals"."decided_reason" is null)),
	CONSTRAINT "atlas_proposals_merge_names_its_entry" CHECK (("atlas_proposals"."status" = 'merged' and "atlas_proposals"."merged_into" is not null)
          or ("atlas_proposals"."status" <> 'merged' and "atlas_proposals"."merged_into" is null)),
	CONSTRAINT "atlas_proposals_decided_has_a_date" CHECK (("atlas_proposals"."status" = 'pending' and "atlas_proposals"."decided_at" is null)
          or ("atlas_proposals"."status" <> 'pending' and "atlas_proposals"."decided_at" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "atlas_proposals_one_per_provider" ON "atlas_proposals" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "atlas_proposals_pending" ON "atlas_proposals" USING btree ("status","proposed_at");