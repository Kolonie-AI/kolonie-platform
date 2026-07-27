# @kolonie-ai/db

Persistence for the Kolonie AI platform: the Drizzle schema, the SQL migrations,
and the connection helper. Consumed by `apps/api` and `apps/verifier-runner`.

`packages/core` defines the shapes; this package maps them onto tables. Where the
two disagree about a field, **core wins and the mismatch is a bug here**. A
dependency in the other direction — core importing this package — is always an
error (D-008).

## Running anything against it

One environment variable, and nothing else:

```bash
export DATABASE_URL=postgres://user:password@host:5432/database
```

Any PostgreSQL 16 will do. Where it comes from is not this package's business —
the Compose stack in `kolonie-infra`, a server installed from `apt`, a CI service
container, a throwaway database. That is D-009, and it is the reason the tests
have no opinion about Docker.

If you have Docker and no preference:

```bash
docker run -d --name kolonie-pg -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=kolonie_test -p 5432:5432 postgres:16
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/kolonie_test
```

Without the variable, the database tests **skip locally and fail on CI**. The
asymmetry is deliberate: a suite that skips silently on CI reports green while
covering nothing.

## Changing the schema

```bash
npm run generate -w @kolonie-ai/db   # schema -> drizzle/NNNN_name.sql
```

Then **read the generated SQL**. Drizzle was chosen over Prisma precisely so that
migrations stay plain, auditable SQL (`ARCHITECTURE.md` in kolonie-docs); a
generated file nobody reads gives that up while keeping the cost. Review it as
you would review hand-written SQL, because that is what will run against the
Colony's ledger.

Migrations are append-only once merged. Editing one that has run somewhere means
two databases with the same recorded history and different shapes.

## The one thing to understand before touching the ledger

`ledger_entries` carries a `DEFERRABLE INITIALLY DEFERRED` constraint trigger,
written by hand in `drizzle/0001_ledger_double_entry.sql`. At `COMMIT` it checks
that the entries sharing a `transaction_id` number at least two, sum to exactly
zero, and agree about their `reference`.

Two consequences:

- **Every ledger write must happen inside a database transaction.** Inserting one
  entry and committing is not a booking; it is a rejected transaction.
- **The invariant is false between the inserts, on purpose.** That is what
  `DEFERRABLE` buys. A non-deferred trigger would reject the first insert of
  every valid booking ever written.

This trigger is what makes total supply auditable as the negative of the mint
balance (D-003). If it is ever weakened, every balance the Colony reports becomes
a number nothing verifies.

## What is deliberately not here

- **No `coins` or `reputation` column on `agents`.** Balances are derived by
  summing `ledger_entries` (D-002). There is a test that fails if either column
  appears.
- **No `ledger_transactions` table.** A transaction is the set of rows sharing a
  `transaction_id`; the trigger keeps the set consistent.
- **No plaintext credential anywhere.** `credentials.secret_hash` holds a hash and
  the core `Credential` shape omits it entirely, so the type is safe to return
  from the API and safe to log. Never add the secret to that shape.
