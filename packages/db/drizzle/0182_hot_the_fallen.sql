ALTER TYPE "public"."payout_obligation_kind" ADD VALUE 'obstacle-bonus';--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_academy_pays_no_credits";--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_reward_non_negative";--> statement-breakpoint
DROP INDEX "payout_obligations_review_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "payout_obligations_unsubmitted_unique" ON "payout_obligations" USING btree ("task_id","agent_id","kind") WHERE "payout_obligations"."submission_id" is null;--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "reward_credits";--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_academy_pays_nothing_convertible" CHECK ("tasks"."kind" = 'quest'
          or "tasks"."reward_lamports" is null
          or "tasks"."reward_lamports" = 0);--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_reward_non_negative" CHECK ("tasks"."reward_reputation" >= 0);--> statement-breakpoint
-- `#553` phase C. The frozen-terms trigger compares seventeen columns of a
-- published quest, and `reward_credits` was one of them. Dropping the column
-- above leaves the function referencing a field the record no longer has, so
-- **every** UPDATE on `tasks` fails with `record "new" has no field
-- "reward_credits"` — not only an edit to a published quest. Caught by the test
-- suite against the local database rather than in production.
--
-- `reward_lamports` takes its place rather than simply going: the price is one
-- of the terms a citizen answered on, and it is exactly what must not change
-- under a quest that is already running.
CREATE OR REPLACE FUNCTION tasks_assert_published_quest_frozen() RETURNS trigger AS $$
BEGIN
  IF OLD.kind <> 'quest' OR OLD.status <> 'active' THEN
    RETURN NEW;
  END IF;

  IF (NEW.type, NEW.title, NEW.description, NEW.instructions,
      NEW.reward_lamports, NEW.reward_reputation, NEW.slots, NEW.expires_at,
      NEW.audience, NEW.requires_skills, NEW.grants_skills, NEW.grants_roles,
      NEW.account_kinds, NEW.min_reputation, NEW.assistance_allowed,
      NEW.timeout_hours, NEW.prerequisite_task_ids)
     IS DISTINCT FROM
     (OLD.type, OLD.title, OLD.description, OLD.instructions,
      OLD.reward_lamports, OLD.reward_reputation, OLD.slots, OLD.expires_at,
      OLD.audience, OLD.requires_skills, OLD.grants_skills, OLD.grants_roles,
      OLD.account_kinds, OLD.min_reputation, OLD.assistance_allowed,
      OLD.timeout_hours, OLD.prerequisite_task_ids)
  THEN
    RAISE EXCEPTION 'tasks_published_quest_frozen: quest % is active and its terms cannot change; a change is a new quest', OLD.id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
