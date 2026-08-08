CREATE TABLE "provider_bundle_entries" (
	"bundle_slug" text NOT NULL,
	"kind" text NOT NULL,
	"provider" text NOT NULL,
	CONSTRAINT "provider_bundle_entries_bundle_slug_kind_provider_pk" PRIMARY KEY("bundle_slug","kind","provider")
);
--> statement-breakpoint
CREATE TABLE "provider_bundles" (
	"slug" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"reason" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "provider_bundle_entries" ADD CONSTRAINT "provider_bundle_entries_bundle_slug_provider_bundles_slug_fk" FOREIGN KEY ("bundle_slug") REFERENCES "public"."provider_bundles"("slug") ON DELETE cascade ON UPDATE no action;