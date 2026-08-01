-- Exactly one address per citizen is the one the Colony reaches it at (D-047, #136).
--
-- D-044 kept one address from naming two citizens. The other direction was never
-- decided and the code answered it by accident: `provedMailbox` read
-- `order by verified_at desc limit 1`, so a citizen that proved a second mailbox
-- moved the Colony's reach address without anybody deciding it should — and took
-- the `email-send` badge's subject with it, to an address it had never
-- demonstrated it could send from.
ALTER TABLE "email_challenges" ADD COLUMN "primary_at" timestamp with time zone;--> statement-breakpoint

-- **The backfill is the load-bearing statement in this file, not the column.**
-- `provedMailbox` now reads the stamp instead of the ordering, so every citizen
-- that already holds a mailbox would read back as holding none the moment the
-- column exists — no reach address, and `email-send` refusing a badge to citizens
-- that earned their grant weeks ago. The column and the rows have to arrive
-- together.
--
-- **The earliest verified row per citizen**, which is the same rule the code now
-- applies going forward: the first address proved is the primary, and a later one
-- does not take over. `distinct on` with the matching `order by` is Postgres's
-- first-row-per-group, and it cannot select two rows for one agent — which is
-- what the unique index created below would refuse anyway.
--
-- `verified_at` rather than `now()` as the value: the stamp says when the address
-- became the reach address, and for these rows that was when they were proved.
-- Writing `now()` would date every historical grant to this deploy.
UPDATE "email_challenges" SET "primary_at" = "verified_at"
WHERE "id" IN (
  SELECT DISTINCT ON ("agent_id") "id"
    FROM "email_challenges"
   WHERE "purpose" = 'inbox' AND "verified_at" IS NOT NULL
   ORDER BY "agent_id", "verified_at" ASC, "created_at" ASC
);--> statement-breakpoint

-- Created after the backfill rather than before it, so the statement above is
-- checked by the constraint it has to satisfy rather than racing it.
CREATE UNIQUE INDEX "email_challenges_primary_mailbox_unique" ON "email_challenges" USING btree ("agent_id") WHERE "email_challenges"."primary_at" is not null and "email_challenges"."verified_at" is not null and "email_challenges"."purpose" = 'inbox';--> statement-breakpoint
ALTER TABLE "email_challenges" ADD CONSTRAINT "email_challenges_primary_is_a_verified_inbox" CHECK ("email_challenges"."primary_at" is null
          or ("email_challenges"."verified_at" is not null and "email_challenges"."purpose" = 'inbox'));
