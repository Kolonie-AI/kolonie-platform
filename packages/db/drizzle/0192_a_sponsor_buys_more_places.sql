ALTER TABLE "tasks" ADD COLUMN "pending_slots" integer;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_pending_slots_bought_on_a_quest" CHECK ("tasks"."pending_slots" is null or ("tasks"."pending_slots" > 0 and "tasks"."kind" = 'quest'));--> statement-breakpoint
-- `#629`. The frozen-terms trigger compares `slots` among the seventeen columns
-- a published quest may not change, and it was right to: capacity was part of
-- what the sponsor committed and the escrow was sized against it.
--
-- **Buying more places is a purchase and not an edit**, and the difference is a
-- direction. Nothing an answerer relied on moves — the price, the questions, the
-- criteria, the tier and the expiry are all still in the tuple below — and no
-- citizen is worse off for there being more places. Reducing capacity *is* an
-- edit: it takes back an offer citizens can see, so the trigger now refuses that
-- explicitly rather than by including `slots` in the comparison.
--
-- The rule lives here rather than only in `topUpQuest` for the reason every
-- other constraint on this table does: a write path that has not been thought of
-- yet cannot get round it.
CREATE OR REPLACE FUNCTION tasks_assert_published_quest_frozen() RETURNS trigger AS $$
BEGIN
  IF OLD.kind <> 'quest' OR OLD.status <> 'active' THEN
    RETURN NEW;
  END IF;

  -- Capacity may grow and may never shrink (`#629`). `null` means unlimited,
  -- which a quest never carries, and moving to or from it is a change of kind
  -- rather than of size — so it is refused.
  IF NEW.slots IS DISTINCT FROM OLD.slots
     AND (NEW.slots IS NULL OR OLD.slots IS NULL OR NEW.slots < OLD.slots)
  THEN
    RAISE EXCEPTION 'tasks_published_quest_frozen: quest % is active and its capacity cannot be reduced', OLD.id;
  END IF;

  IF (NEW.type, NEW.title, NEW.description, NEW.instructions,
      NEW.reward_lamports, NEW.reward_reputation, NEW.expires_at,
      NEW.audience, NEW.requires_skills, NEW.grants_skills, NEW.grants_roles,
      NEW.account_kinds, NEW.min_reputation, NEW.assistance_allowed,
      NEW.timeout_hours, NEW.prerequisite_task_ids)
     IS DISTINCT FROM
     (OLD.type, OLD.title, OLD.description, OLD.instructions,
      OLD.reward_lamports, OLD.reward_reputation, OLD.expires_at,
      OLD.audience, OLD.requires_skills, OLD.grants_skills, OLD.grants_roles,
      OLD.account_kinds, OLD.min_reputation, OLD.assistance_allowed,
      OLD.timeout_hours, OLD.prerequisite_task_ids)
  THEN
    RAISE EXCEPTION 'tasks_published_quest_frozen: quest % is active and its terms cannot change; a change is a new quest', OLD.id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
