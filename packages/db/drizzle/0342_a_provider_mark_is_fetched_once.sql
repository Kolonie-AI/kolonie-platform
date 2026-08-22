CREATE TABLE "provider_icons" (
	"provider" varchar(128) PRIMARY KEY NOT NULL,
	"bytes" "bytea",
	"format" varchar(8),
	"source_url" text,
	"refusal" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "provider_icons_expires_at_idx" ON "provider_icons" USING btree ("expires_at");