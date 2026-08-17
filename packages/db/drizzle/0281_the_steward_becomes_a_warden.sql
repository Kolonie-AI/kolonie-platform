-- The shrunk role gets its own name (`#947`, part one of two).
--
-- `warden` is ADDED, and `steward` is not renamed. The issue was written
-- expecting `ALTER TYPE ... RENAME VALUE`, and that would have been wrong:
-- `authority_events.role` is this enum, so renaming the value in place rewrites
-- every historical `role-granted` and `role-revoked` row naming the old office.
-- A grant made in May would report as a grant of a role that did not exist until
-- August, silently, with nothing left to compare against — in the one table the
-- Colony keeps precisely so that *who let this happen* survives the actor.
--
-- So the old value is retired rather than reused: it stays in the type, nothing
-- grants it, no gate reads it, and `steward` stays in `RESERVED_HANDLE_FRAGMENTS`
-- forever because a retired privileged word that becomes claimable is a phishing
-- surface rather than a freed name.
--
-- ## Why the type is rebuilt rather than extended
--
-- `ALTER TYPE ... ADD VALUE 'warden'` is the obvious statement and it cannot
-- work here. Postgres refuses to *use* a value added that way until the adding
-- transaction has committed (`55P04`), the migrator runs every pending migration
-- in one transaction, and `0282` has to put `warden` into `agents.roles` in that
-- same transaction. Splitting into two files does not split the transaction.
--
-- **A value from `CREATE TYPE` carries no such restriction**, because the
-- blacklist Postgres consults is written by `ALTER TYPE ... ADD VALUE` and by
-- nothing else. So the type is renamed aside, recreated with the full membership
-- including `warden`, the two dependent columns are moved onto it through `text`,
-- and the old type is dropped. Everything `0282` then does is ordinary.
--
-- **Two columns and no other dependent**, measured against a database at `0280`
-- rather than assumed: `agents.roles` (`role[]`, `NOT NULL`, default `'{}'`) and
-- `authority_events.role` (`role`, nullable). The default has to come off before
-- the column moves and go back on after, because it is an expression in the type
-- being dropped. Membership and order are unchanged from what
-- `ALTER TYPE ... ADD VALUE 'warden' BEFORE 'judge'` would have produced, which
-- is what keeps `RoleSchema` and the `0281` snapshot true.
--
-- **The rewrite is the cost.** Moving a column's type rewrites its table under an
-- `ACCESS EXCLUSIVE` lock, so this is two table rewrites in the deploy's
-- transaction. `agents` and `authority_events` are small and this runs once; a
-- Colony large enough for that to matter should reach for a different shape and
-- not for a longer maintenance window.
--
-- **What went wrong before this, because it will be tempting again.** The first
-- version of these two migrations did use `ADD VALUE`, and `0282` widened the
-- array to `text[]` and cast it back, on the belief — stated at length in `0073`
-- and in `schema/credentials.ts` — that casting from `text` sidesteps `55P04`. It
-- does not: the cast calls the enum's input function, which is exactly what the
-- check guards. `0073` looked like proof only because its `where` clause matches
-- no rows on a fresh database, so the cast it demonstrates was never once
-- evaluated. It passed the suite, and it failed the deploy on the one database
-- that has a `steward` to move.
ALTER TYPE "public"."role" RENAME TO "role__pre_warden";--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('builder', 'reviewer', 'steward', 'warden', 'judge', 'governor', 'tester');--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "roles" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "roles" TYPE "public"."role"[] USING "roles"::text[]::"public"."role"[];--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "roles" SET DEFAULT '{}'::"public"."role"[];--> statement-breakpoint
ALTER TABLE "authority_events" ALTER COLUMN "role" TYPE "public"."role" USING "role"::text::"public"."role";--> statement-breakpoint
DROP TYPE "public"."role__pre_warden";
