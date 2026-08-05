ALTER TYPE "public"."credential_kind" ADD VALUE 'key-mint-link';--> statement-breakpoint
ALTER TABLE "credentials" DROP CONSTRAINT "credentials_secret_requires_hash";--> statement-breakpoint
ALTER TABLE "credentials" DROP CONSTRAINT "credentials_expiry_matches_kind";--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_secret_requires_hash" CHECK ("credentials"."kind"::text not in ('api-key', 'email-link', 'console-session', 'key-mint-link') or "credentials"."secret_hash" is not null);--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_expiry_matches_kind" CHECK (("credentials"."kind"::text in ('email-link', 'console-session', 'key-mint-link')) = ("credentials"."expires_at" is not null));