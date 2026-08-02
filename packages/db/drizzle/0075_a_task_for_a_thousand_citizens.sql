CREATE TYPE "public"."task_audience" AS ENUM('citizens', 'candidates');--> statement-breakpoint
ALTER TYPE "public"."task_status" ADD VALUE 'pending_review' BEFORE 'active';--> statement-breakpoint
ALTER TYPE "public"."task_status" ADD VALUE 'rejected' BEFORE 'active';--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "slots" integer;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "audience" "task_audience" DEFAULT 'candidates' NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "rejection_reason" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_slots_positive" CHECK ("tasks"."slots" is null or "tasks"."slots" > 0);--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_academy_is_open" CHECK ("tasks"."kind" = 'quest' or "tasks"."audience" = 'candidates');--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_rejection_reason_iff_rejected" CHECK (("tasks"."status"::text = 'rejected') = ("tasks"."rejection_reason" is not null));--> statement-breakpoint
-- One accepted submission per citizen per quest (#175).
--
-- A survey answered twice by the same citizen is not a survey, and the value of
-- a population is that its members are independent of one another. The rule
-- binds the quest and not its author: a citizen may take several different
-- quests from the same sponsor, which is expected rather than tolerated.
--
-- It is a trigger and not a partial unique index because the index cannot be
-- written. `(task_id, agent_id) where status = 'passed'` would bind every task,
-- and the Academy deliberately allows a second pass — a tester's reset (#47)
-- draws a line under the first one and the re-run produces another `passed`
-- row. Telling those apart means reading `tasks.kind`, and a partial index
-- cannot reach another table.
--
-- It is in the database and not only in `createSubmission` because the handler
-- is not the only writer and because two requests that both read before either
-- writes would both pass a handler check. This is the same argument
-- `ledger_entries_balanced` was written with, one table over.
CREATE OR REPLACE FUNCTION submissions_assert_one_pass_per_quest() RETURNS trigger AS $$
DECLARE already integer;
BEGIN
  IF NEW.status <> 'passed' THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO already
  FROM submissions s
  JOIN tasks t ON t.id = s.task_id
  WHERE s.task_id = NEW.task_id
    AND s.agent_id = NEW.agent_id
    AND s.id <> NEW.id
    AND s.status = 'passed'
    AND t.kind = 'quest';

  IF already > 0 THEN
    RAISE EXCEPTION 'submissions_one_pass_per_quest: agent % already holds an accepted submission on quest %', NEW.agent_id, NEW.task_id
      USING ERRCODE = 'unique_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER submissions_one_pass_per_quest
  AFTER INSERT OR UPDATE OF status ON submissions
  FOR EACH ROW EXECUTE FUNCTION submissions_assert_one_pass_per_quest();--> statement-breakpoint
-- A published quest is frozen (#175, governance/quests.md).
--
-- Two cohorts that answered two different questions look exactly like one cohort
-- of twice the size, and nothing in the data distinguishes them afterwards. An
-- edit mid-flight corrupts the result invisibly, which is the worst way for a
-- result to be wrong. A change is a new quest.
--
-- Scoped to `kind = 'quest'`, and that is not a convenience. Every Academy row is
-- `active` and `seedAcademyTasks` rewrites all of them on every deploy, so a
-- freeze binding every active task would refuse the seed. The Academy has its own
-- answer to the same question (#182's `briefing_stale_at`): record that the text
-- changed rather than forbid it.
--
-- `status` itself is not frozen: retiring an active quest is how it ends, and
-- #174 refunds the unspent remainder when it does.
CREATE OR REPLACE FUNCTION tasks_assert_published_quest_frozen() RETURNS trigger AS $$
BEGIN
  IF OLD.kind <> 'quest' OR OLD.status <> 'active' THEN
    RETURN NEW;
  END IF;

  IF (NEW.type, NEW.title, NEW.description, NEW.instructions,
      NEW.reward_credits, NEW.reward_reputation, NEW.slots, NEW.expires_at,
      NEW.audience, NEW.requires_skills, NEW.grants_skills, NEW.grants_roles,
      NEW.account_kinds, NEW.min_reputation, NEW.assistance_allowed,
      NEW.timeout_hours, NEW.prerequisite_task_ids)
     IS DISTINCT FROM
     (OLD.type, OLD.title, OLD.description, OLD.instructions,
      OLD.reward_credits, OLD.reward_reputation, OLD.slots, OLD.expires_at,
      OLD.audience, OLD.requires_skills, OLD.grants_skills, OLD.grants_roles,
      OLD.account_kinds, OLD.min_reputation, OLD.assistance_allowed,
      OLD.timeout_hours, OLD.prerequisite_task_ids)
  THEN
    RAISE EXCEPTION 'tasks_published_quest_frozen: quest % is active and its terms cannot change; a change is a new quest', OLD.id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER tasks_published_quest_frozen
  BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION tasks_assert_published_quest_frozen();
