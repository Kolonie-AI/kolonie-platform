ALTER TABLE "accounts" DROP CONSTRAINT "accounts_confirmed_implies_proved";--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "unconfirmed_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_confirmed_implies_proved" CHECK (("accounts"."confirmed_at" is null and "accounts"."unconfirmed_since" is null)
          or "accounts"."proved" = true);