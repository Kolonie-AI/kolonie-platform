CREATE TABLE "atlas_provider_icons" (
	"provider" varchar(128) PRIMARY KEY NOT NULL,
	"bytes" "bytea",
	"format" varchar(8),
	"width" integer,
	"height" integer,
	"source_url" varchar(2048),
	"absence" varchar(32),
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"refresh_after" timestamp with time zone NOT NULL
);
