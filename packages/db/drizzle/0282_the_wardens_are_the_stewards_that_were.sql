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
-- ## Why this may name enum values, when the first version of it dared not
--
-- Every value here is written as a plain literal, which is only true because
-- `0281` recreates the type rather than extending it. Postgres refuses to *use*
-- a value added by `ALTER TYPE ... ADD VALUE` until the adding transaction
-- commits (`55P04`), and the migrator runs every pending migration in one
-- transaction — so with an `ADD VALUE` upstream there is no form of this
-- statement that works, and no deployment order that rescues it. A value from a
-- `CREATE TYPE` carries no such restriction, which is why `0281` reaches for one
-- and why `authority_action` below was never in question.
--
-- **What this file used to say, and it was wrong.** It widened both arrays to
-- `text[]`, edited them there and cast back, on `0073`'s claim that going
-- through `text` *"resolves at runtime"*. It does not — the cast calls the
-- enum's input function, which is precisely what the check guards — and this is
-- the migration that found out, on the deploy, on the one database that has a
-- `steward` to move.
--
-- `0073` reads as a demonstration and is not one, and the give-away is *which*
-- half of it was measured. It reports that a literal `'steward'::role` in its
-- `where` clause failed, and that is true — a constant cast there is folded at
-- planning time and raises whether or not a row matches. The `text` round-trip
-- it then adopted sits in the `set` clause, which is evaluated per matching row,
-- and its own `where` clause matches nothing on a fresh database. So the
-- workaround was never once evaluated, on any database, by anything. It has been
-- cited ever since as measured.
--
-- **`schema/credentials.ts` is not the same claim and is sound.** It casts the
-- column to `text` and compares against string literals, so the enum's input
-- function is never called and there is nothing for `55P04` to catch. That
-- direction works. This one — `text` into enum — is the direction that does not,
-- and the two being one paragraph apart in `0073` is how they got conflated.
--
-- Idempotent and a no-op on a database where nobody holds the old role, which
-- includes every fresh one.
with held as (
  select id, roles
    from agents
   where 'steward'::role = any(roles)
),
moved as (
  update agents a
     set roles = array_remove(a.roles, 'steward'::role) || array['warden'::role],
         updated_at = now()
    from held h
   where a.id = h.id
  returning a.id, a.roles as now_roles, h.roles as was_roles
)
insert into authority_events (actor_id, action, subject_agent_id, role)
select null::uuid, 'role-revoked'::authority_action, m.id, r
  from moved m, unnest(m.was_roles) as r
 where r = 'steward'::role
union all
select null::uuid, 'role-granted'::authority_action, m.id, r
  from moved m, unnest(m.now_roles) as r
 where r = 'warden'::role;
