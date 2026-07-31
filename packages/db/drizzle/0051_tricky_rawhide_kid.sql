CREATE TYPE "public"."email_challenge_purpose" AS ENUM('inbox', 'send');--> statement-breakpoint
ALTER TABLE "email_challenges" DROP CONSTRAINT "email_challenges_code_needs_inbound";--> statement-breakpoint
ALTER TABLE "email_challenges" DROP CONSTRAINT "email_challenges_verified_needs_inbound";--> statement-breakpoint
DROP INDEX "email_challenges_verified_address_unique";--> statement-breakpoint
DROP INDEX "email_challenges_agent_verified_idx";--> statement-breakpoint
ALTER TABLE "email_challenges" ADD COLUMN "purpose" "email_challenge_purpose" DEFAULT 'inbox' NOT NULL;--> statement-breakpoint
ALTER TABLE "email_challenges" ADD COLUMN "sent_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "email_challenges_verified_address_unique" ON "email_challenges" USING btree ((split_part(split_part(lower("address"), '@', 1), '+', 1) || '@' || split_part(lower("address"), '@', 2))) WHERE "email_challenges"."verified_at" is not null and "email_challenges"."purpose" = 'inbox';--> statement-breakpoint
CREATE INDEX "email_challenges_agent_verified_idx" ON "email_challenges" USING btree ("agent_id","purpose","verified_at");--> statement-breakpoint
-- Backfill before the verdict constraint, or it refuses the Colony's own history.
--
-- Every row here predates kolonie-docs#92 and was a round trip: the Colony's
-- code went out as a *reply* to the agent's mail, so the moment it was sent is
-- the moment that mail arrived. `sent_at = inbound_at` is the accurate history
-- rather than a value invented to satisfy a check — and without it the two
-- citizens who actually passed this rung would have their grants refused by
-- `email_challenges_verdict_needs_its_evidence`.
--
-- Measured on the live database, 2026-07-31: 16 rows, 2 verified, 3 carrying a
-- code and an inbound timestamp, 13 abandoned with neither. The 13 stay as they
-- are and remain legal, because the code constraint asks only that a *delivered*
-- mail had a code.
UPDATE "email_challenges" SET "sent_at" = "inbound_at"
  WHERE "code" IS NOT NULL AND "inbound_at" IS NOT NULL AND "sent_at" IS NULL;
--> statement-breakpoint
ALTER TABLE "email_challenges" ADD CONSTRAINT "email_challenges_code_belongs_to_inbox" CHECK (case when "email_challenges"."purpose" = 'inbox'
            then "email_challenges"."sent_at" is null or "email_challenges"."code" is not null
            else "email_challenges"."code" is null and "email_challenges"."sent_at" is null
          end);--> statement-breakpoint
ALTER TABLE "email_challenges" ADD CONSTRAINT "email_challenges_verdict_needs_its_evidence" CHECK ("email_challenges"."verified_at" is null
          or case when "email_challenges"."purpose" = 'inbox'
                 then "email_challenges"."sent_at" is not null
                 else "email_challenges"."inbound_at" is not null
             end);