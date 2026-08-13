ALTER TABLE "accounts" ADD COLUMN "shown_on_profile" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_shown_is_proved_and_attestable" CHECK ("accounts"."shown_on_profile" = false
          or ("accounts"."proved" = true and "accounts"."attestable" = true));