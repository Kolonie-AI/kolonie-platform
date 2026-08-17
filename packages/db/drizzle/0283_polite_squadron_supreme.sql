CREATE TABLE "atlas_category_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"provider" text NOT NULL,
	"shape" text NOT NULL,
	"category_slug" text NOT NULL,
	"parent_slug" text,
	"title" text,
	"standfirst" text,
	"why" text NOT NULL,
	"walks" jsonb NOT NULL,
	"model" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"decided_reason" text,
	"proposed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "atlas_category_proposals_kind_length" CHECK (length("atlas_category_proposals"."kind") between 3 and 32),
	CONSTRAINT "atlas_category_proposals_provider_length" CHECK (length("atlas_category_proposals"."provider") <= 128),
	CONSTRAINT "atlas_category_proposals_slug_is_a_slug" CHECK ("atlas_category_proposals"."category_slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length("atlas_category_proposals"."category_slug") <= 64),
	CONSTRAINT "atlas_category_proposals_status_is_known" CHECK ("atlas_category_proposals"."status" in ('open', 'accepted', 'declined')),
	CONSTRAINT "atlas_category_proposals_why_says_something" CHECK (length("atlas_category_proposals"."why") between 1 and 500),
	CONSTRAINT "atlas_category_proposals_shape_is_whole" CHECK (("atlas_category_proposals"."shape" = 'existing' and "atlas_category_proposals"."parent_slug" is null
           and "atlas_category_proposals"."title" is null and "atlas_category_proposals"."standfirst" is null)
          or ("atlas_category_proposals"."shape" = 'new-sub' and "atlas_category_proposals"."parent_slug" is not null
              and length("atlas_category_proposals"."title") between 1 and 80
              and length("atlas_category_proposals"."standfirst") between 1 and 300)),
	CONSTRAINT "atlas_category_proposals_cites_a_walk" CHECK (jsonb_typeof("atlas_category_proposals"."walks") = 'array' and jsonb_array_length("atlas_category_proposals"."walks") >= 1),
	CONSTRAINT "atlas_category_proposals_decline_says_why" CHECK (("atlas_category_proposals"."status" = 'declined' and "atlas_category_proposals"."decided_reason" is not null
           and length("atlas_category_proposals"."decided_reason") between 1 and 500)
          or ("atlas_category_proposals"."status" <> 'declined' and "atlas_category_proposals"."decided_reason" is null)),
	CONSTRAINT "atlas_category_proposals_decided_has_a_date" CHECK (("atlas_category_proposals"."status" = 'open' and "atlas_category_proposals"."decided_at" is null)
          or ("atlas_category_proposals"."status" <> 'open' and "atlas_category_proposals"."decided_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "atlas_category_proposals" ADD CONSTRAINT "atlas_category_proposals_parent_slug_atlas_categories_slug_fk" FOREIGN KEY ("parent_slug") REFERENCES "public"."atlas_categories"("slug") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "atlas_category_proposals_one_open" ON "atlas_category_proposals" USING btree ("kind","provider") WHERE "atlas_category_proposals"."status" = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "atlas_category_proposals_once_per_pairing" ON "atlas_category_proposals" USING btree ("kind","provider","category_slug");--> statement-breakpoint
CREATE INDEX "atlas_category_proposals_open" ON "atlas_category_proposals" USING btree ("status","proposed_at");