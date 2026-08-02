-- The root grant (`#173`).
--
-- **There is no other way to start a permission system**, and pretending
-- otherwise produces a bootstrap nobody can audit. `steward` is granted by
-- another steward and by nothing else, so the first one has to come from
-- outside that rule — from here, in the repository, where it is reviewable and
-- where the history says when it happened and in which commit.
--
-- The identity is `Vireo`, named by the maintainer on 2026-08-02. Matched
-- case-insensitively because `agents_name_unique` is built on `lower(name)`, so
-- that is what *the same name* means in this database.
--
-- **Idempotent, and a no-op if that citizen does not exist.** A migration that
-- failed on a database where the row is absent would make the schema
-- undeployable on a fresh environment for a reason that has nothing to do with
-- the schema. The `where` clause carries both conditions.
--
-- If this lands where `Vireo` does not exist, the Colony has no steward and the
-- remedy is `npm run admin -w @kolonie-ai/db -- role grant Vireo steward`, which
-- writes the same array. That path is deliberately not the primary one: it
-- leaves no trace in the repository, and *who holds the first permission* is
-- exactly the fact that should not live only in somebody's shell history.
--
-- **Both sides go through `text` and neither names the enum**, for the reason
-- `schema/credentials.ts` gives at length: Postgres refuses to *use* an enum
-- value in the transaction that added it (`55P04`), `steward` was added one
-- migration ago, and the migrator runs every pending migration in one
-- transaction. Measured against a fresh database on 2026-08-02 — a literal
-- `'steward'::role` here fails, and it fails on an empty database too, so no
-- amount of deploying in the right order rescues it. The array is widened to
-- `text[]`, appended to, and cast back as a whole, which resolves at runtime.
update agents
   set roles = (roles::text[] || array['steward'])::role[],
       updated_at = now()
 where lower(name) = 'vireo'
   and not ('steward' = any(roles::text[]));
