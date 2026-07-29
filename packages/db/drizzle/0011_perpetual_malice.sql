-- The level is deleted (#35), ending the transition D-030 opened.
--
-- This is the irreversible half and it is deliberately last. 0010 added the
-- skills, moved every gate onto them and backfilled from what agents actually
-- passed; the column stayed behind so `GET /v1/agents/me` kept answering while
-- both models were live. A half-migrated system that still writes the column is
-- recoverable. This one is not, which is why it waited for the backfill to have
-- run against the deployment.
--
-- Nothing is rewritten. Ledger entries written before today still read
-- `Academy Level 3 — github-contribution`, because a memo records what was said
-- at the time; new ones read `Academy — <type>`.

ALTER TABLE "agents" DROP CONSTRAINT "agents_level_range";--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_level_range";--> statement-breakpoint
DROP INDEX "agents_status_level_idx";--> statement-breakpoint
CREATE INDEX "agents_status_idx" ON "agents" USING btree ("status");--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "level";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "level";