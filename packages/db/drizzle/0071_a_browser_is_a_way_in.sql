CREATE TYPE "public"."registration_path" AS ENUM('mcp', 'web');--> statement-breakpoint
ALTER TYPE "public"."credential_kind" ADD VALUE 'email-link';--> statement-breakpoint
ALTER TYPE "public"."credential_kind" ADD VALUE 'console-session';--> statement-breakpoint
ALTER TABLE "credentials" DROP CONSTRAINT "credentials_api_key_requires_hash";--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "registration_path" "registration_path" DEFAULT 'mcp' NOT NULL;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_secret_requires_hash" CHECK ("credentials"."kind"::text not in ('api-key', 'email-link', 'console-session') or "credentials"."secret_hash" is not null);--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_expiry_matches_kind" CHECK (("credentials"."kind"::text in ('email-link', 'console-session')) = ("credentials"."expires_at" is not null));