ALTER TABLE "payout_obligations" ADD COLUMN "chain_minimum" bigint;--> statement-breakpoint
ALTER TABLE "payout_obligations" ADD COLUMN "accrual_hinted_at" timestamp with time zone;