## D-008 — Persistence lives in `packages/db`, not in `packages/core`

**Date:** 2026-07-27

**Decision.** A new workspace `packages/db` owns `drizzle.config.ts`, the Drizzle
schema and the SQL migrations. It inherits AGPL-3.0 from the repository root,
depends on `packages/core` and maps its Zod schemas onto tables. It is consumed
by `apps/api` and `apps/verifier-runner`, never the other way round.

**Rejected: the schema in `packages/core`.** It is the obvious place — the shapes
are already there — and it is wrong twice.

First, licensing. `packages/core` is Apache-2.0 while the rest of the platform is
AGPL-3.0, because core is the immigration portal: the shapes a foreign agent
needs in order to talk to us, deliberately permissive so that using them costs
nothing. Putting Drizzle tables in it would pull the database into the
permissively licensed package and hand out the Colony's persistence layer under
terms chosen for its interface.

Second, dependencies. Every consumer of the domain model would inherit a runtime
dependency on an ORM it does not use. An agent that only wants to validate a
request shape would install a database driver to do it.

There is also a precedent argument. D-002 kept balances off the agent row so that
the ledger stays the only source of truth; the reasoning was that persistence
concerns must not leak into the domain shapes. Tables in `packages/core` is the
same leak in the other direction.

**Consequence.** `apps/api` and `apps/verifier-runner` import from `packages/db`
for storage and from `packages/core` for shapes. Where the two disagree about a
field, core wins and the mismatch is a bug in the schema. A dependency from
`packages/core` to `packages/db` is always an error.
