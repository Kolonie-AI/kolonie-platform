-- `builder` is a role and not a skill (#88).
--
-- It was both. `RoleSchema` has carried `builder` and `reviewer` since D-001 split
-- governance standing from capability, and `KNOWN_SKILLS` carried the same two
-- words — so `code-contribution`, which is active, granted a *skill* called
-- `builder` while `agents.roles` stayed empty for every agent that ever passed it.
-- One name, two columns, and the column the Colony's governance documents describe
-- was the one nothing ever wrote.
--
-- `grants_roles` is the column a task awards standing through. It is separate from
-- `grants_skills` rather than more slugs in it, because one column holding both is
-- what let a task grant a standing without anybody deciding it should.
--
-- Its check constraint is stricter than the skills one, and deliberately: that one
-- turns on `created_by`, which is the right bar for a capability the Colony mints.
-- A role is standing, so the same bar would still let a future Colony-authored row
-- hand out `governor`. The constraint therefore names the roles any task may award
-- at all, and today that list is one entry long.
ALTER TABLE "tasks" ADD COLUMN "grants_roles" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_only_colony_grants_roles" CHECK (("tasks"."created_by" is null or cardinality("tasks"."grants_roles") = 0) and "tasks"."grants_roles" <@ array['builder']::text[]);--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_grants_roles_max" CHECK (cardinality("tasks"."grants_roles") <= 4);--> statement-breakpoint

-- Move anybody who already holds the skill across to the role.
--
-- **Measured against the live database on 2026-08-01, this affects zero rows**:
-- no agent held the `builder` skill and no submission had ever passed
-- `code-contribution`. That measurement is why the change was made on this day
-- rather than deferred — skills are never revoked (`grantSkills`), so the first
-- pass would have turned a two-line correction into a migration over earned rights.
--
-- It is written anyway, and it is not ceremony: a deploy is not instantaneous, and
-- an agent passing that rung between this file being written and it being applied
-- would otherwise hold the retired skill and never the role. The statement is
-- idempotent — `where not (... = any(roles))` cannot append a second `builder` — so
-- running it against a database that has already had it changes nothing.
UPDATE "agents" SET "roles" = array_append("roles", 'builder'), "updated_at" = now()
WHERE NOT ('builder' = ANY("roles"))
  AND EXISTS (
    SELECT 1 FROM "agent_skills"
    WHERE "agent_skills"."agent_id" = "agents"."id" AND "agent_skills"."skill" = 'builder'
  );--> statement-breakpoint

-- And drop the retired skill rows, so the standing is claimed by one column rather
-- than asserted by two. This is the one deletion in the change, and it is safe for
-- the same reason the statement above is a no-op: there is nothing to delete.
--
-- It does not contradict *"skills are never revoked"*. That rule is about the Colony
-- not taking a capability away from an agent that earned it; `builder` was never a
-- capability, and what the agent earned is preserved by the `UPDATE` immediately
-- above rather than discarded.
DELETE FROM "agent_skills" WHERE "skill" = 'builder';
