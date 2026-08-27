-- A completed recovery cannot be changed after it is written, by anybody,
-- including the citizen it is about (#1721).
--
-- `#1684` exposed no storage operation that updates or deletes one of these
-- rows, which made the history append-only **through the application surface**
-- and left PostgreSQL accepting a direct `UPDATE` from anywhere else — a later
-- storage path, a maintenance statement, a psql prompt. A trace of a recovery
-- that could be rewritten is worth what the writer's discipline is worth, and
-- the whole reason this record exists is that the citizen it concerns may be
-- the one person who cannot see what else was done with its key.
--
-- **`UPDATE` only, and `DELETE` deliberately left alone.** Erasure takes
-- everything a citizen ever wrote — that is what erasure means — and it reaches
-- these rows by cascade from `agents`. A trigger that refused deletes would
-- refuse `kolonie.account.erase` itself, which is a worse failure than the one
-- it prevents: a citizen's right to leave, withdrawn to protect a record about
-- it. So the guarantee is held two ways, and only one of them is a constraint.
-- The database refuses to change a row; the storage surface exposes no path
-- that removes a single one.
--
-- `account_entries_are_append_only` in `0242` is this exact pair, for this
-- exact reason, and this is deliberately its twin rather than a second
-- mechanism invented for the same shape.
--
-- There is nothing to replace editing with here. An entry has a correction — a
-- further entry — because it is somebody's words. A recovery is a thing that
-- happened, and a second recovery does not make the first one unhappen: it is
-- another row.
CREATE OR REPLACE FUNCTION credential_recoveries_are_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'credential_recoveries is append-only: a completed recovery cannot be changed'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER credential_recoveries_are_append_only
  BEFORE UPDATE ON "credential_recoveries"
  FOR EACH ROW EXECUTE FUNCTION credential_recoveries_are_append_only();