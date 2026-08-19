ALTER TABLE "account_walks" DROP CONSTRAINT "account_walks_outcome_is_known";--> statement-breakpoint
ALTER TABLE "provider_recipes" ADD COLUMN "homepage" text;--> statement-breakpoint
ALTER TABLE "account_walks" ADD COLUMN "homepage" text;--> statement-breakpoint
ALTER TABLE "provider_recipes" ADD CONSTRAINT "provider_recipes_homepage_is_https" CHECK ("provider_recipes"."homepage" is null
          or ("provider_recipes"."homepage" like 'https://%'
              and length("provider_recipes"."homepage") <= 2048));--> statement-breakpoint
ALTER TABLE "account_walks" ADD CONSTRAINT "account_walks_homepage_is_https" CHECK ("account_walks"."homepage" is null
          or ("account_walks"."homepage" like 'https://%'
              and length("account_walks"."homepage") <= 2048));--> statement-breakpoint
ALTER TABLE "account_walks" ADD CONSTRAINT "account_walks_outcome_is_known" CHECK ("account_walks"."outcome" is null
          or "account_walks"."outcome" in ('proved', 'refused', 'abandoned', 'sighted'));