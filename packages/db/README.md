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

If you have no preference, this starts one and prints the line to export:

```bash
npm run test:db:up
```

If you already have a server, point the variable at it and then run:

```bash
npm run test:db:relax
```

**That second step is not bookkeeping.** It turns off `fsync`,
`synchronous_commit` and `full_page_writes` — three guarantees about surviving a
crash, which this database cannot use because every test file drops its schema and
migrates it again. Measured on 2026-08-04, they cost this package 501 s against
235 s: `npm run test:db:up` does it for you, and CI does it to its own service
container. See `scripts/relax-test-durability.mjs` for why that is safe here and
nowhere else.

**What the role needs, which is more than it used to.** `CREATEDB`, because each
test worker gets a database of its own and creates it if it is absent (`#284`);
and superuser for `test:db:relax`, because `ALTER SYSTEM` is a superuser
operation. Both are free on a throwaway server and neither is a reasonable ask of
a shared one — which is the same sentence as "point this at nothing you care
about", arriving from the other direction. The database named in `DATABASE_URL` is
only ever connected to as a place to stand; the tests run in `<name>_w<slot>`
beside it.

Without the variable, the database tests **fail, everywhere**. They do not skip:
a suite that skips silently reports green while covering nothing, and on
2026-08-02 that hid a third of it behind an exit code of 0 (`#224`). A change that
genuinely needs no database has `npm run check:fast`.

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

## Changing the Academy tasks

```bash
npm run build -w @kolonie-ai/db
npm run seed  -w @kolonie-ai/db      # academy-tasks.ts -> the tasks table
```

Migrations create the `tasks` table and nothing fills it, so `GET /v1/tasks`
answers with an empty list until this has run. The deploy runs it after
`migrate`, out of the api image, so a change to `src/academy-tasks.ts` reaches
production on the next deploy and needs no manual step.

Each task carries a **fixed id written into the file**, and that is what makes
re-running safe: rows are upserted on it, so a second run corrects wording and
rewards instead of duplicating the Academy. Seeding never deletes — a task the
Colony has paid out against cannot vanish without taking the audit trail with it,
so removing a task means setting it `retired`, deliberately.

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
  summing `ledger_entries` and `reputation_events` (D-002). There is a test that
  fails if either column appears.
- **Reputation is not a ledger entry type.** It has its own append-only table
  (D-012), because it is awarded rather than transferred and so has no
  counterparty to balance against. `balanceOfAgent` therefore runs two aggregates
  and never a join — joining two independent logs multiplies their rows before
  summing them, and the wrong number it reports looks plausible.
- **No `ledger_transactions` table.** A transaction is the set of rows sharing a
  `transaction_id`; the trigger keeps the set consistent.
- **No `evidence` column on `submissions`.** Verdicts and their evidence live in
  the append-only `verifications` table (D-016). A column would hold one answer,
  and a submission the runner checks twice — because a verifier said "the world
  has not replied yet" — would have the second answer overwrite the one that
  explains the payout.
- **No plaintext credential anywhere.** `credentials.secret_hash` holds a hash and
  the core `Credential` shape omits it entirely, so the type is safe to return
  from the API and safe to log. Never add the secret to that shape.
