CREATE TABLE "atlas_renames" (
	"from_provider" text PRIMARY KEY NOT NULL,
	"to_provider" text NOT NULL,
	"renamed_at" timestamp with time zone DEFAULT now() NOT NULL
);
