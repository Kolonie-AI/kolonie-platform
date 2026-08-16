--> `#1104` needs `similarity()`, which is `pg_trgm`. Trusted on PostgreSQL 16,
--> so the database owner may create it without being a superuser. Not written by
--> drizzle-kit — the schema file has no way to say *this extension* — and safe
--> beside a generated migration because `check-migrations.sh` fails on schema and
--> migrations disagreeing, not on statements it did not write.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
ALTER TABLE "account_walks" ADD COLUMN "duplicate_of" uuid;--> statement-breakpoint
ALTER TABLE "account_walks" ADD CONSTRAINT "account_walks_duplicate_of_account_walks_id_fk" FOREIGN KEY ("duplicate_of") REFERENCES "public"."account_walks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_walks" ADD CONSTRAINT "account_walks_a_duplicate_is_not_published" CHECK ("account_walks"."duplicate_of" is null or "account_walks"."scrubbed_prose" is null);