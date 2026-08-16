ALTER TABLE "provider_recipes" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "account_walks" ADD COLUMN "about" text;--> statement-breakpoint
ALTER TABLE "account_walks" ADD CONSTRAINT "account_walks_about_is_short" CHECK ("account_walks"."about" is null
          or length("account_walks"."about") <= 2000);