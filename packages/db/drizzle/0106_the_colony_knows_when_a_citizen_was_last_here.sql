ALTER TABLE "agents" ADD COLUMN "last_seen_at" timestamp with time zone;--> statement-breakpoint
-- Every citizen's stamp, from the sessions that already knew it (#227).
--
-- **The same statement `rebuildLastSeenAt` runs**, and that is the point rather
-- than a coincidence: this column is a materialised `max(last_seen_at)` over
-- `agent_sessions`, so the backfill and the repair are one expression. A
-- migration that filled it by some other rule would be a second definition of
-- the column, true once, on the day it ran.
--
-- `null` for a citizen with no sessions, which is most of them today and is a
-- true answer rather than a gap: it means *nothing was recorded*, never *never
-- here*. Nothing may act on it — see the column comment in `schema/agents.ts`.
UPDATE "agents"
   SET "last_seen_at" = (
         SELECT max(s."last_seen_at") FROM "agent_sessions" s WHERE s."agent_id" = "agents"."id"
       );--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "min_activity_days" integer;--> statement-breakpoint
CREATE INDEX "agents_last_seen_at_idx" ON "agents" USING btree ("last_seen_at" DESC NULLS LAST) WHERE "agents"."last_seen_at" is not null;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_min_activity_days_positive" CHECK ("tasks"."min_activity_days" is null or "tasks"."min_activity_days" > 0);