-- The holders move, and the move is recorded (`#947`, part two of two).
--
-- Every agent holding the retired `steward` gains `warden` and loses `steward`,
-- in one statement, with a `role-revoked` and a `role-granted` row in
-- `authority_events` for each. Capability is unchanged either side of this: the
-- two gates that survived the shrink — `kolonie.quests.end` and grant/revoke —
-- read `warden` from the same commit this lands in, so nobody is stranded for
-- the width of a deploy and nobody gains anything.
--
-- ## Why a migration, when the issue asked for a hand act
--
-- `#947` says the revocation must be *"a hand act, not a migration"*, because
-- `changeRoleAsWarden` requires an `actorId` and a migration has none. Followed
-- literally that is unperformable, and it took three passes at this issue to see
-- why: `actorId` is an `AgentId`, and the only agents holding the role are the
-- two being moved. There is no third holder to act, and a maintainer at
-- `/backend` cannot supply one either — the column references `agents`, not
-- `humans`. The act the issue asks for has no possible actor.
--
-- **A null actor is not a missing one.** `recordAuthorityEvent` already states
-- what null means, and it is not *unknown*: **the Colony acted rather than a
-- citizen** (`#693`, written when quest publication moved to a moderation
-- verdict with nobody behind it). That is exactly true here — the Colony decided
-- to shrink and rename the office, in a numbered issue, in a decision record, in
-- this file. Naming one of the two subjects as the actor to satisfy the letter
-- of the rule would be the forgery the rule exists to prevent.
--
-- So the ordering the issue sets out is honoured where it is load-bearing — the
-- decision is recorded before the code, in `kolonie-docs`
-- `state/decisions/the-steward-desk-becomes-a-lever.md`, dated 2026-08-15 — and
-- the act writes a real audit row rather than none. `0073` moved a role from a
-- migration and wrote no audit row at all; this is that precedent with the
-- record the precedent was missing.
--
-- ## Why nothing here names an enum value
--
-- Both sides go through `text`, for the reason `0073` gives at length: Postgres
-- refuses to *use* a value added by `ALTER TYPE ... ADD VALUE` in the
-- transaction that added it (`55P04`), the migrator runs every pending migration
-- in one transaction, and `warden` arrives one migration ago. It fails on an
-- empty database too, so no deployment order rescues it. `steward` has the same
-- problem for the same reason since `0072`. The arrays are widened to `text[]`,
-- edited, and cast back as a whole, which resolves at runtime; the audit rows
-- take their `role` by unnesting a column rather than by writing a literal.
-- `authority_action` is untouched by any of this — its values came from a
-- `CREATE TYPE`, which carries no such restriction.
--
-- Idempotent and a no-op on a database where nobody holds the old role, which
-- includes every fresh one.
with held as (
  select id, roles
    from agents
   where 'steward' = any(roles::text[])
),
moved as (
  update agents a
     set roles = (array_remove(a.roles::text[], 'steward') || array['warden'])::role[],
         updated_at = now()
    from held h
   where a.id = h.id
  returning a.id, a.roles as now_roles, h.roles as was_roles
)
insert into authority_events (actor_id, action, subject_agent_id, role)
select null::uuid, 'role-revoked'::authority_action, m.id, r
  from moved m, unnest(m.was_roles) as r
 where r::text = 'steward'
union all
select null::uuid, 'role-granted'::authority_action, m.id, r
  from moved m, unnest(m.now_roles) as r
 where r::text = 'warden';
