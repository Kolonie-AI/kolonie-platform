CREATE TYPE "public"."funding_source" AS ENUM('bootstrap', 'external', 'unclassified');--> statement-breakpoint
ALTER TYPE "public"."authority_action" ADD VALUE 'funding-source-set';--> statement-breakpoint
ALTER TYPE "public"."authority_action" ADD VALUE 'funding-source-overridden';--> statement-breakpoint
ALTER TYPE "public"."ledger_entry_type" ADD VALUE 'balance_credit' BEFORE 'transfer';--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "funding_source_default" "funding_source";--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD COLUMN "funding_source" "funding_source";--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_funding_source_iff_credit" CHECK (("ledger_entries"."type"::text = 'balance_credit') = ("ledger_entries"."funding_source" is not null));