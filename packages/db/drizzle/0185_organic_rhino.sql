ALTER TABLE "tasks" ADD COLUMN "ended_by" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "ended_reason" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_ended_by_agents_id_fk" FOREIGN KEY ("ended_by") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_ended_only_when_retired" CHECK (("tasks"."ended_reason" is null and "tasks"."ended_by" is null)
          or "tasks"."status"::text = 'retired');--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_ended_by_needs_reason" CHECK ("tasks"."ended_by" is null or "tasks"."ended_reason" is not null);--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_ended_reason_length" CHECK ("tasks"."ended_reason" is null or char_length("tasks"."ended_reason") between 1 and 500);--> statement-breakpoint
-- The two quests that were ended by a direct `UPDATE` against production, named
-- by id because a title is not unique here (`#619`).
--
-- `ended_by` stays null on purpose. Both were ended by a person with a database
-- console rather than by a citizen acting through the Colony, and naming an
-- agent that did not do it would be the record lying about who is accountable —
-- `tasks_ended_by_needs_reason` allows a reason without an actor for exactly
-- this case.
--
-- Idempotent by the `ended_reason is null` guard, so re-running it changes
-- nothing, and scoped to `retired` so it cannot resurrect anything.
UPDATE "tasks"
   SET "ended_reason" = 'Ended by a direct database write on 2026-08-09, before there was a route that could end a quest. Recorded here rather than left blank so the record says what happened; no citizen ended it.'
 WHERE "id" IN (
         '767f79cd-e1d0-459b-abed-d6990420f162',
         '674fb6f5-fbb6-4002-b81c-111ac6c38911'
       )
   AND "status" = 'retired'
   AND "ended_reason" IS NULL;
