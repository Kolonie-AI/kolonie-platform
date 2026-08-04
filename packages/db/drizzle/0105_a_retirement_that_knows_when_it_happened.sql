ALTER TABLE "tasks" ADD COLUMN "retired_at" timestamp with time zone;--> statement-breakpoint
-- The rows that were already retired, before the constraint below can refuse
-- them (#286).
--
-- **Stamped with `created_at`, which is the earliest instant a retirement could
-- have happened.** The obvious candidate is `updated_at`, and it is the wrong
-- one for exactly the reason this column exists: the Academy seed rewrites every
-- task row on every deploy, so `updated_at` on these rows is the last deploy
-- rather than the retirement, and using it would re-report every one of them as
-- news one final time — the defect, once more, on the way out of it.
--
-- `created_at` understates recency instead. A retirement that genuinely happened
-- while a citizen slept is missed once, and nothing is ever re-reported. That is
-- the safe direction for a digest whose whole promise is *what changed while you
-- were away*.
UPDATE "tasks" SET "retired_at" = "created_at" WHERE "status" = 'retired';--> statement-breakpoint
CREATE INDEX "tasks_retired_at_idx" ON "tasks" USING btree ("retired_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_retired_at_matches_status" CHECK (("tasks"."status" = 'retired') = ("tasks"."retired_at" is not null));--> statement-breakpoint
-- The stamp is a fact about the row rather than a convention its writers follow.
--
-- The Academy seed is the only production writer of `tasks.status` today, and it
-- is an upsert that rewrites every row on every deploy — so a `case` expression
-- in its `set` block would work and would be true only for as long as nobody
-- adds a second writer. A trigger makes the next writer correct without knowing
-- this column is here, which is the same argument the double-entry trigger makes
-- for the ledger.
--
-- Only a *change* of status moves it: a re-seed that writes 'retired' over
-- 'retired' leaves the original date alone, which is the whole point.
CREATE OR REPLACE FUNCTION tasks_stamp_retirement() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'retired' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'retired') THEN
    NEW.retired_at := now();
  ELSIF NEW.status <> 'retired' THEN
    -- Cleared on the way back, so a reinstated task carries no retirement date.
    NEW.retired_at := NULL;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER tasks_stamp_retirement
  BEFORE INSERT OR UPDATE OF status ON "tasks"
  FOR EACH ROW EXECUTE FUNCTION tasks_stamp_retirement();
