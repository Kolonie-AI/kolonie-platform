ALTER TABLE "agent_runtime_declarations" ADD COLUMN "source" varchar(16);--> statement-breakpoint
-- Backfill only what can be proved, and leave the rest null (#278).
--
-- Until #228, `kolonie.tasks.runtime` also appended to this table, and it only
-- ever wrote `model`. So every row for the other three fields came from
-- `kolonie.profile.update` and can be said so; a `model` row from before that
-- fix could be either, and `null` — read as `unknown` — is the only true answer
-- for it. Filling those in would be the confident wrong label this column
-- exists to remove.
UPDATE "agent_runtime_declarations" SET "source" = 'profile' WHERE "field" <> 'model';
