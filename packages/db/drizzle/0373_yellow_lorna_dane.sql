-- Exactly one persisted message state (kolonie-platform#1961, after #1958,
-- #1959 and #1960 are deployed together).
--
-- `messages.body` and `messages.retracted_at` were both made nullable in
-- `0370` deliberately, with no exclusive-state CHECK, so the tombstone-aware
-- readers and the retraction writers could deploy as one expand release. That
-- release is live, so the contract can land.
--
-- The block below is the preflight: an existing row in neither legal state
-- blocks this migration and must be diagnosed, because "repairing" one would
-- mean either inventing a retraction timestamp or rewriting a body — either
-- silently changes what a message meant. It is duplicated in
-- `src/message-state-contract.ts` as `MESSAGE_STATE_PREFLIGHT_SQL`, where its
-- reasoning lives and which is what the test drives;
-- `message-state-contract.test.ts` reads this file and fails if the two drift
-- apart. Nothing is backfilled: every legal row already satisfies the CHECK.
DO $$
DECLARE offending bigint;
BEGIN
  SELECT count(*) INTO offending
  FROM "messages"
  WHERE NOT (("body" IS NOT NULL AND "retracted_at" IS NULL) OR ("body" IS NULL AND "retracted_at" IS NOT NULL));
  IF offending > 0 THEN
    RAISE EXCEPTION 'kolonie-platform#1961 cannot enforce messages_active_or_retracted: % message row(s) are neither exactly active nor exactly retracted; diagnose them rather than rewriting bodies, timestamps, or message ids.', offending;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_active_or_retracted" CHECK (("body" IS NOT NULL AND "retracted_at" IS NULL) OR ("body" IS NULL AND "retracted_at" IS NOT NULL));