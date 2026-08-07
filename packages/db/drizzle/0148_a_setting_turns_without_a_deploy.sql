ALTER TYPE "public"."authority_action" ADD VALUE 'setting-changed';--> statement-breakpoint
ALTER TYPE "public"."authority_action" ADD VALUE 'setting-cleared';--> statement-breakpoint
CREATE TABLE "settings" (
	"name" varchar(128) PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
