-- An Atlas entry says what sort of thing it is, and who has to be there (`#589`).
--
-- **`category` is added nullable, backfilled, then made `NOT NULL`.** Drizzle
-- generates `ADD COLUMN ... NOT NULL` in one statement, which fails against a
-- table that has rows — and the column deliberately has no default, because a
-- default would file a provider on a shelf nobody chose. Three statements are
-- what a required column with no sensible default costs.
--
-- Not reversible, for the reason `0177` gives: dropping the columns is lossless,
-- and the categories somebody chose are not recoverable afterwards.
ALTER TABLE "provider_recipes" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "provider_recipes" ADD COLUMN "operator_guess" text;--> statement-breakpoint
-- The three seeded entries, named rather than guessed at, from `#589`'s own
-- acceptance criteria. Measured against production on 2026-08-08: these are
-- every row in the table, so the `else` below runs on nothing — it is there so
-- that a curated row added between writing this and running it cannot fail the
-- `SET NOT NULL`, and `data-apis` is the placeholder a steward corrects on the
-- curation screen rather than an opinion about that row.
UPDATE "provider_recipes" SET "category" = CASE "provider"
  WHEN 'github.com' THEN 'code-hosting'
  WHEN 'trello.com' THEN 'project-tracking'
  WHEN 'bsky.app' THEN 'social-publishing'
  ELSE 'data-apis'
END WHERE "category" IS NULL;--> statement-breakpoint
ALTER TABLE "provider_recipes" ALTER COLUMN "category" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_recipes" ADD CONSTRAINT "provider_recipes_category_is_known" CHECK ("provider_recipes"."category" in ('mailbox', 'domain-dns', 'code-hosting', 'social-publishing', 'compute-hosting', 'payments-finance', 'storage', 'project-tracking', 'communication', 'knowledge-docs', 'design-media', 'data-apis', 'identity-security', 'commerce-marketplace'));--> statement-breakpoint
ALTER TABLE "provider_recipes" ADD CONSTRAINT "provider_recipes_operator_guess_is_known" CHECK ("provider_recipes"."operator_guess" is null
          or "provider_recipes"."operator_guess" in ('unaided', 'operator-needed'));--> statement-breakpoint
ALTER TABLE "provider_recipes" ADD CONSTRAINT "provider_recipes_operator_guess_only_without_steps" CHECK ("provider_recipes"."operator_guess" is null or jsonb_array_length("provider_recipes"."steps") = 0);
