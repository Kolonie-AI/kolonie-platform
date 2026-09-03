ALTER TABLE "agents" ADD COLUMN "declared_rhythm_minutes" integer;
UPDATE "agents" SET "declared_rhythm_minutes" = "declared_rhythm_hours" * 60 WHERE "declared_rhythm_hours" IS NOT NULL;

CREATE OR REPLACE FUNCTION agents_sync_declared_rhythm() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.declared_rhythm_minutes IS NULL AND NEW.declared_rhythm_hours IS NOT NULL THEN
      NEW.declared_rhythm_minutes := NEW.declared_rhythm_hours * 60;
    ELSIF NEW.declared_rhythm_minutes IS NOT NULL THEN
      NEW.declared_rhythm_hours := CASE
        WHEN NEW.declared_rhythm_minutes % 60 = 0 THEN NEW.declared_rhythm_minutes / 60
        ELSE NULL
      END;
    END IF;
  ELSIF NEW.declared_rhythm_minutes IS DISTINCT FROM OLD.declared_rhythm_minutes THEN
    NEW.declared_rhythm_hours := CASE
      WHEN NEW.declared_rhythm_minutes IS NULL THEN NULL
      WHEN NEW.declared_rhythm_minutes % 60 = 0 THEN NEW.declared_rhythm_minutes / 60
      ELSE NULL
    END;
  ELSIF NEW.declared_rhythm_hours IS DISTINCT FROM OLD.declared_rhythm_hours THEN
    NEW.declared_rhythm_minutes := NEW.declared_rhythm_hours * 60;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agents_sync_declared_rhythm
BEFORE INSERT OR UPDATE OF declared_rhythm_minutes, declared_rhythm_hours ON agents
FOR EACH ROW EXECUTE FUNCTION agents_sync_declared_rhythm();
