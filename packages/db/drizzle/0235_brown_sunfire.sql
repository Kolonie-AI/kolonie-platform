ALTER TYPE "public"."reputation_reason" ADD VALUE 'walk_published';--> statement-breakpoint
ALTER TABLE "account_walks" ADD COLUMN "proposed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "account_walks" ADD COLUMN "rewarded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "account_walks" ADD COLUMN "reward_told_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "account_walks_rewarded_provider_unique" ON "account_walks" USING btree ("kind","provider") WHERE "account_walks"."rewarded_at" is not null;--> statement-breakpoint
ALTER TABLE "account_walks" ADD CONSTRAINT "account_walks_reward_follows_a_proposal" CHECK (("account_walks"."rewarded_at" is null or "account_walks"."proposed_at" is not null)
          and ("account_walks"."reward_told_at" is null or "account_walks"."rewarded_at" is not null));