-- The Atlas gains a third state (`#588`).
--
-- Two migrations and not one, deliberately: this adds the column and carries the
-- three existing rows over, and `0178` drops `joinable` once nothing reads it.
-- Splitting them means the backfill below runs while both columns exist, so the
-- new value is derived from the old one rather than from a default that happens
-- to be right for two rows out of three.
--
-- **Not reversible, and this says why rather than pretending.** Going back is
-- lossless only while no row is `unwritten` — that state has no boolean to
-- become, and `#590` exists to create a hundred of them. Down would have to
-- choose between deleting those rows and calling them refusals, and both are
-- worse than the migration staying forward-only.
ALTER TABLE "provider_recipes" ADD COLUMN "status" text DEFAULT 'joinable' NOT NULL;--> statement-breakpoint
-- The three seeded rows keep their meaning: `joinable = false` is a walked
-- refusal, and every one of them carries the reason that makes it one. Nothing
-- becomes `unwritten` here — no existing row means *nobody has looked*, because
-- the shape it was written in could not express that.
UPDATE "provider_recipes" SET "status" = CASE WHEN "joinable" THEN 'joinable' ELSE 'refused' END;
