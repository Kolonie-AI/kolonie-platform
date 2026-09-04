import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { sql } from 'drizzle-orm'
import { ATLAS_SEEDED_CATEGORIES } from '@kolonie-ai/core'
import { assertNoBareOuterReference } from './bare-identifiers.js'
import { createDatabase, databaseUrlFromEnv, DATABASE_URL_VAR, type Database } from './client.js'
import { MIGRATIONS_FOLDER, MIGRATIONS_SCHEMA } from './migrations.js'
import { atlasCategories } from './schema/atlas-categories.js'

// Re-exported so test files keep importing everything they need from one place.
export { MIGRATIONS_FOLDER, MIGRATIONS_SCHEMA }

const HOW_TO_PROVIDE_ONE = `Provide a PostgreSQL 16 server and set ${DATABASE_URL_VAR}.

If you have no server yet, this starts one and prints the URL to export:

  npm run test:db:up

If you already have one — the Compose stack in kolonie-infra, an installed
server, a hosted throwaway database — point the variable at it and run:

  npm run test:db:relax

That second step is not optional bookkeeping. It turns off three durability
guarantees this database cannot use, and it is worth roughly half the wall clock
of packages/db (#283). Any PostgreSQL 16 will do; see operations/testing.md in
kolonie-docs for why the variable is the whole interface.`

/**
 * The database-backed tests in this package refuse to be skipped (`#224`).
 *
 * This function is where D-009's second half lives, and it is the part that is
 * easy to get wrong. Integration tests that quietly pass when their variable is
 * unset report green while covering nothing, nobody notices, and within a month
 * the suite has stopped testing the database without a single failure to
 * announce it. That is the same class of defect as a deploy pipeline that had
 * never once succeeded while every failure was read as a known problem.
 *
 * **It used to make that argument and then apply it to CI alone**, skipping
 * locally on the grounds that the returned reason would teach. It did not. On
 * 2026-08-02 a full `npm run check` exited **0** with `84 passed | 938 skipped`
 * — a third of the suite — and the only announcement was one `console.warn`
 * near the top of a log thousands of lines long. *A skip that does not teach is
 * a skip that becomes permanent*, said the comment that then wrote one.
 *
 * **One rule now, not two, and the local half is the half that matters.** A
 * push to `main` bypasses the required status check, so CI runs *after* the
 * decision to push has already been made on a local exit code. The throw on CI
 * was guarding a checkpoint that is routinely walked past.
 *
 * **There is deliberately no way to switch this off.** An environment variable
 * that silences a safety check ends up in a shell profile, and is then permanent
 * and invisible — this defect again, with one more step in front of it. A change
 * that genuinely needs no database has `npm run check:fast`, which says in its
 * own name that it checked less.
 *
 * This is not the *degrade rather than fail fast* rule from
 * `operations/incidents.md`, and the difference is who is being served. That
 * rule protects citizens using a running Colony, for whom a degraded answer
 * still beats no answer. A test suite serves nobody — it tells one maintainer
 * whether to push, and degrading gracefully there means lying to its only
 * reader.
 *
 * **What comes back is not the URL that went in** (`#284`). The caller supplies
 * one server; this hands the calling test file the database belonging to *its*
 * worker, so that files running at the same time cannot see each other's rows.
 * See {@link workerDatabaseUrl}. Everything a test file needs is derived from
 * this one value, which is why the rewrite belongs here and not in
 * {@link connectForTests}.
 */
export function databaseTestTarget(env: NodeJS.ProcessEnv = process.env): {
  available: true
  url: string
} {
  const url = env[DATABASE_URL_VAR]
  if (url !== undefined && url.trim() !== '')
    return { available: true, url: workerDatabaseUrl(url, testWorkerSlot(env)) }

  throw new Error(
    `${DATABASE_URL_VAR} is not set, so the database tests cannot run — and a suite that ` +
      `skips them silently reports green while covering nothing.\n\n${HOW_TO_PROVIDE_ONE}\n\n` +
      `If this change genuinely needs no database, run \`npm run check:fast\`, which runs ` +
      `everything except the tests and says so.`,
  )
}

/**
 * The environment variable naming the slot a vitest worker occupies.
 *
 * **`VITEST_POOL_ID` and deliberately not `VITEST_WORKER_ID`** (`#284`). They
 * read like synonyms and are not: measured on 2026-08-04 with vitest 4.1.10,
 * running 24 files across 4 workers gave `VITEST_WORKER_ID` the values 0..23 —
 * one per *file* — while `VITEST_POOL_ID` stayed in 1..4, one per *slot*.
 *
 * The slot is the number worth keying on, because it is the one with the
 * property this arrangement needs: a slot runs one file at a time, so two files
 * that share a slot never overlap, and one database per slot is enough to make
 * them independent. Keying on the worker id would have created one database per
 * test file — seventy of them, each needing its own migration run.
 */
const WORKER_SLOT_VAR = 'VITEST_POOL_ID'

/**
 * Which slot this process is, or 1 when nothing says.
 *
 * Defaulting rather than throwing is what lets a test file be run directly —
 * `npx vitest run src/storage/tasks.test.ts` sets the variable, a debugger
 * attached to a bare `node` does not, and both should reach a database.
 */
export function testWorkerSlot(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[WORKER_SLOT_VAR]
  if (raw === undefined) return 1

  const slot = Number(raw)
  if (!Number.isInteger(slot) || slot < 1) {
    throw new Error(
      `${WORKER_SLOT_VAR} is ${JSON.stringify(raw)}, which is not a slot number. ` +
        `It names which of the test runner's workers this process is, and the database ` +
        `this worker may touch is derived from it.`,
    )
  }
  return slot
}

/**
 * The URL of the database belonging to one worker slot.
 *
 * The caller supplies **one** server through **one** variable, exactly as
 * `operations/testing.md` requires; the split into per-worker databases happens
 * here, below that interface, because it is an implementation detail of how these
 * tests stay independent rather than something a caller should have to arrange.
 *
 * Everything else in a test file is derived from what this returns, which is why
 * it is the *URL* that is rewritten and not merely the connection
 * {@link connectForTests} opens: `rewards.test.ts` and `tasks.test.ts` open a
 * second pool from `target.url` to make two sessions contend, and `migrate.test.ts`
 * never calls `connectForTests` at all. Rewriting one connection and not the URL
 * would have sent those to a different database than the test they belong to —
 * silently, and only sometimes.
 */
export function workerDatabaseUrl(baseUrl: string, slot: number): string {
  // Checked here and not only in `testWorkerSlot`, because this number is
  // interpolated into an identifier that `ensureWorkerDatabase` then creates. It
  // has one caller today and that caller validates; a guard on the function that
  // does the interpolating survives a second caller that does not.
  if (!Number.isInteger(slot) || slot < 1) {
    throw new Error(`${slot} is not a worker slot, so no database name follows from it`)
  }

  const url = new URL(baseUrl)
  const name = url.pathname.replace(/^\//, '')

  if (name === '') {
    throw new Error(
      `${DATABASE_URL_VAR} names no database (${baseUrl}), so there is nothing to derive ` +
        `a per-worker name from. It should end in a database name, e.g. .../kolonie_test`,
    )
  }

  url.pathname = `/${name}_w${slot}`
  return url.toString()
}

/**
 * The URL of the one database every worker's is copied from (`#296`).
 *
 * Derived from the same base URL the worker databases are, so the caller still
 * supplies one server through one variable. `_template` rather than a slot
 * number because there is exactly one of it, which is the property that let this
 * live in `globalSetup` where `#284` could not put the per-worker databases:
 * that decision turned on a count in one file having to match a count in
 * another, and a fixed name has nothing to keep in step with.
 */
export function templateDatabaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl)
  const name = url.pathname.replace(/^\//, '')

  if (name === '') {
    throw new Error(
      `${DATABASE_URL_VAR} names no database (${baseUrl}), so there is nothing to derive ` +
        `a template name from. It should end in a database name, e.g. .../kolonie_test`,
    )
  }

  url.pathname = `/${name}_template`
  return url.toString()
}

/** The database name out of a URL, which is what DDL needs and a URL is not. */
function databaseNameOf(url: string): string {
  return new URL(url).pathname.replace(/^\//, '')
}

/**
 * Somewhere to stand while dropping or creating a database.
 *
 * `postgres` rather than the base database from `DATABASE_URL`: a `create
 * database` cannot run from inside the database it is replacing, and the one
 * database guaranteed to exist on any server is the one every client connects to
 * before it knows anything else.
 */
function adminUrl(url: string): string {
  const admin = new URL(url)
  admin.pathname = '/postgres'
  return admin.toString()
}

/**
 * Build the template: one database, migrated once, that every test file's is
 * copied from (`#296`).
 *
 * **Dropped and rebuilt on every run rather than reused.** A template that
 * survived a run would be a second, invisible answer to *what does the schema
 * look like* — and the failure would be a suite passing against migrations that
 * are no longer what the repository says. Rebuilding costs 656 ms once, measured
 * on CLAUDE002 on 2026-08-04, against the 811 ms per file it replaces.
 *
 * **It is sealed when it is finished, and that is not tidiness.** PostgreSQL
 * refuses `create database … template t` while *any* session is connected to
 * `t` — one stray connection anywhere breaks every copy in every worker for as
 * long as it is held. This was not a hypothesis: the first version of
 * `template-database.test.ts` opened the template to assert nothing had been
 * written to it, and two other tests failed with *source database is being
 * accessed by other users*.
 *
 * A comment asking future readers not to connect would not have survived. So the
 * database says it instead: `allow_connections false` makes connecting
 * impossible rather than inadvisable, and `is_template true` says what it is.
 * That is how `template0` is protected, and it is copied from here for the same
 * reason.
 */
export async function buildTemplateDatabase(baseUrl: string): Promise<void> {
  const template = templateDatabaseUrl(baseUrl)
  const name = databaseNameOf(template)
  const admin = createDatabase(adminUrl(baseUrl), { max: 1, onnotice: () => {} })

  try {
    // A database marked `is_template` cannot be dropped while it says so, and
    // the previous run left it marked. Unmarking a database that is not there is
    // an error, so this asks first.
    const [existing] = await admin.execute(sql`select 1 from pg_database where datname = ${name}`)
    if (existing !== undefined) {
      await admin.execute(sql.raw(`alter database "${name}" is_template false`))
    }

    // `with (force)` because a worker that died mid-run leaves a connection
    // behind, and a template nobody can drop would fail every run afterwards
    // until somebody restarted the server by hand.
    await admin.execute(sql.raw(`drop database if exists "${name}" with (force)`))
    await admin.execute(sql.raw(`create database "${name}"`))
  } finally {
    await admin.close()
  }

  const db = createDatabase(template, { max: 1, onnotice: () => {} })
  try {
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER })
  } finally {
    // Closed before it is sealed: the seal is refused while anybody, including
    // this process, is still connected.
    await db.close()
  }

  const seal = createDatabase(adminUrl(baseUrl), { max: 1, onnotice: () => {} })
  try {
    await seal.execute(sql.raw(`alter database "${name}" is_template true`))
    await seal.execute(sql.raw(`alter database "${name}" allow_connections false`))
  } finally {
    await seal.close()
  }
}

/**
 * Create this worker's database if it is not there yet.
 *
 * Connects to the database the caller named — which is used as a place to stand
 * and never as a place to write — and creates the worker's own beside it.
 *
 * **The race is real and is handled by re-asking rather than by reading an error
 * code.** Workers start together, so two can find the database missing and both
 * issue `create database`; one of them then fails. Deciding that from the driver's
 * error code means depending on how three layers spell `42P04`, whereas asking
 * the database again answers the only question that matters — is it there now.
 */
export async function ensureWorkerDatabase(baseUrl: string, slot: number): Promise<void> {
  const name = new URL(workerDatabaseUrl(baseUrl, slot)).pathname.replace(/^\//, '')
  const db = createDatabase(baseUrl, { max: 1, onnotice: () => {} })

  const exists = async () =>
    (await db.execute(sql`select 1 from pg_database where datname = ${name}`)).length > 0

  try {
    if (await exists()) return
    try {
      // No parameter binding is possible for an identifier. `name` is this file's
      // own composition of the caller's URL and a slot number that
      // `workerDatabaseUrl` has just checked is a positive integer.
      await db.execute(sql.raw(`create database "${name}"`))
    } catch (error) {
      if (!(await exists())) throw error
    }
  } finally {
    await db.close()
  }
}

/**
 * A freshly migrated database for one test file.
 *
 * The reset before migrating is not paranoia. `migrate()` decides what to do
 * from the bookkeeping table alone, so a database whose tables were dropped but
 * whose bookkeeping survived gets no tables and no error — and every test then
 * fails somewhere far away from the cause. Starting from genuinely empty makes
 * each test file independent of whatever ran before it, which is the same
 * property the whole test arrangement is built on.
 *
 * Within a file, tests are separated by {@link truncateAll} instead: `TRUNCATE`
 * is far cheaper than re-migrating, and leaves the schema exactly as the
 * migration built it — which is the thing under test.
 */
/**
 * **Several top-level suites may call it.** It drops and recreates the database,
 * so each recreation is serialized per database name and closes the pool it
 * replaces before dropping. This prevents concurrent suite hooks from racing
 * each other's drop/create pair; suites still must not use a pool after another
 * suite has begun replacing it.
 */
export async function connectForTests(
  url: string,
  /**
   * Where the template's name is derived from. The environment, in every real
   * call — a parameter only so that the test proving a missing template is a
   * *failure* can point at a server where there is none, without dropping the
   * one seventy-seven other files are copying from at that moment.
   */
  baseUrl: string = databaseUrlFromEnv(),
): Promise<Database> {
  const name = databaseNameOf(url)
  return serializeRecreation(name, async () => {
    await recreateFromTemplate(url, baseUrl)

    const db = createDatabase(url, {
      max: 1,
      onnotice: () => {},
      /**
       * **Every statement the tests run is read for the `#183` defect** (`#311`).
       *
       * Whether a `sql` fragment renders a bare identifier is decided at its call
       * site — select-field position *and* a single-table query — so no amount of
       * reading the fragment settles it, which is what `bare-identifiers.test.ts`
       * says about itself. This is the other half: the rendering is right here, and
       * a fragment gets judged in every shape a test puts it in.
       *
       * It throws, so the failure lands on the query that produced it rather than
       * in a summary at the end of the run. Here and not in `createDatabase`,
       * because nothing about this belongs in a running service.
       */
      debug: (_connection, query) => assertNoBareOuterReference(query),
    })
    poolsByDatabase.set(name, db)
    return db
  })
}

/**
 * The pool this module last handed out for a database, so it can be closed
 * before that database is dropped. {@link serializeRecreation} makes concurrent
 * callers share one replacement, so the pool registered by that operation is
 * closed before a later operation begins its drop/create pair.
 *
 * **Module state, which is only durable because `#295` turned off per-file
 * isolation.** With a registry that resets between files, the previous file's
 * pool would be invisible here and would be terminated by `with (force)`
 * instead — correct, and noisy: the driver reports the termination the way it
 * reports a server that went away. Closing our own connection first keeps a
 * green run quiet, and `with (force)` stays for the connections this module did
 * not open.
 */
const poolsByDatabase = new Map<string, Database>()

/**
 * The recreation currently running for a database name, so another caller joins
 * it instead of racing it (`#1854`).
 *
 * **Why one shared promise and not a queue.** Two top-level suites that arrive
 * together need the same clean database and can use the same pool; running the
 * recreation once is both the serialization and the cheapest answer. A queue
 * avoids the duplicate create, but makes the later `beforeAll` pay another full
 * copy while CI is already busy enough for that wait to cross the unchanged
 * ten-second hook limit. Once the promise settles, a later file starts a fresh
 * recreation exactly as before.
 *
 * **Why the key is the name and not one lock for the module.** Two worker slots own
 * two databases and have nothing to serialise: `w3` and `w4` copy the template
 * at the same moment by design, and that is the 136–159 ms measurement
 * {@link recreateFromTemplate} rests on. What must not overlap is two
 * recreations of *one* name, and the name is the whole of the contention.
 *
 * **What overlapping looked like.** `isolate: false` keeps this map alive
 * between files, but one file may hold several top-level suites, and their
 * `beforeAll` hooks start together rather than in sequence. On `main` at
 * `6391b712` two suites in `storage/messaging.test.ts` entered
 * {@link connectForTests} for the same worker database: both dropped it, both
 * issued `create database`, and Postgres answered the second with `23505` on
 * `pg_database_datname_index` while the first hook sat past its timeout. Neither
 * suite was wrong and no timeout was too short — the drop/create pair is simply
 * not re-entrant for one name.
 *
 * **A failure must not wedge the mechanism.** The shared promise is returned to
 * every caller that joined it, so each receives the same rejection. Its owner
 * then removes it in `finally`, and a later call may recreate the same name from
 * scratch. The identity check prevents an older completion from deleting a newer
 * promise if this function's lifecycle ever gains another path.
 */
const recreationsByDatabase = new Map<string, Promise<unknown>>()

async function serializeRecreation<T>(name: string, recreate: () => Promise<T>): Promise<T> {
  const current = recreationsByDatabase.get(name)
  if (current !== undefined) return current as Promise<T>

  const recreation = recreate()
  recreationsByDatabase.set(name, recreation)

  try {
    return await recreation
  } finally {
    if (recreationsByDatabase.get(name) === recreation) recreationsByDatabase.delete(name)
  }
}

/**
 * Replace one worker's database with a copy of the template (`#296`).
 *
 * Measured on CLAUDE002 on 2026-08-04, five rounds, median: 811 ms to drop the
 * schemas and replay all 107 migrations, 63 ms to copy the template. Six workers
 * copying from one template at the same moment took 136–159 ms for all six, so
 * the source is not a queue.
 *
 * **A copy and not a truncation, though the two measured the same.** A database
 * created from a template is indistinguishable from one that was just migrated —
 * same sequences, same constraints, same bookkeeping — while truncation leaves
 * whatever the file before it did to the schema, and this package contains tests
 * that change schemas.
 */
async function recreateFromTemplate(url: string, baseUrl: string): Promise<void> {
  const name = databaseNameOf(url)
  const template = databaseNameOf(templateDatabaseUrl(baseUrl))

  const ours = poolsByDatabase.get(name)
  if (ours !== undefined) {
    poolsByDatabase.delete(name)
    await ours.close()
  }

  const admin = createDatabase(adminUrl(url), { max: 1, onnotice: () => {} })
  try {
    await admin.execute(sql.raw(`drop database if exists "${name}" with (force)`))
    await admin.execute(sql.raw(`create database "${name}" template "${template}"`))
  } finally {
    await admin.close()
  }
}

/**
 * Empty every table in `public`, leaving the schema in place.
 *
 * **Read from `pg_tables` rather than named** (`#556`). This was a hand-written
 * list, and `cascade` from `agents` was what reached most of it — so a table
 * with no foreign key to anything in the list was never truncated at all, its
 * rows survived into the next test, and the failure did not look like leakage.
 * It looked like a wrong count, a duplicate insert, or a precedence bug in
 * whichever test happened to run next.
 *
 * **Five tables arrived in that state and every one of them cost somebody a
 * wrong diagnosis first**: `log_defects` (`#407`), `humans` (`#425`), `settings`
 * (`#489`), `provider_recipes` (`#520`, `#521`) — where it was first
 * misdiagnosed as the seed's upsert inserting duplicates — and
 * `provider_enquiries` (`#544`). Each was fixed by adding a name to the list,
 * which fixed that instance and nothing about the next one. Five is a pattern
 * rather than a coincidence, and the list was correct on the day it was written
 * every single time.
 *
 * **What is given up is that the list also documented which tables are
 * deliberately unattached**, which `#556` names as the real cost of this
 * change. That documentation is the paragraph above: it is now a record of what
 * happened rather than a thing that has to be maintained to stay true, which is
 * the direction a comment should move.
 *
 * **What it costs in time, measured rather than assumed.** 100 calls against the
 * real schema — 83 tables, all empty — on CLAUDE002 on 2026-08-08: 8.32 s for
 * the 19 named tables, 8.58 s for all of them. 83.2 ms against 85.8 ms per call,
 * 3%. `truncate` on an empty table is close to free, and the schema would have to
 * grow by an order of magnitude before that stopped being true.
 *
 * **One statement rather than a query and then a truncate**, so there is no
 * window in which the list this reads and the list it truncates could differ,
 * and no round trip per call to discover what has not changed. `pg_tables`
 * filtered to `public` excludes the migrations bookkeeping, which lives in
 * {@link MIGRATIONS_SCHEMA}.
 */
export async function truncateAll(db: Database): Promise<void> {
  await db.execute(sql`
    do $$
    declare statement text;
    begin
      select 'truncate table ' || string_agg(format('%I', tablename), ', ') ||
             ' restart identity cascade'
        into statement
        from pg_tables
        where schemaname = 'public';

      -- Null when the schema holds no tables, which is a database nobody has
      -- migrated. Truncating nothing is the honest answer; EXECUTE on a null
      -- would be an error about the wrong thing.
      if statement is not null then
        execute statement;
      end if;
    end $$
  `)

  await seedAtlasCategories(db)
}

/**
 * Put the Atlas taxonomy back after a truncate (`#1102`).
 *
 * **The shelves are vocabulary, not test data.** `provider_recipes.category` is
 * a foreign key into them now, so a database whose `atlas_categories` is empty
 * is one no migration ever produces and one in which no entry can be written at
 * all — which is how this was found: eleven tests in `atlas-renames.test.ts`
 * failing with `Key (category)=(code-hosting) is not present`.
 *
 * **Re-seeded rather than skipped by the truncate above**, so that a test which
 * adds a shelf gets it removed again like everything else it wrote. The rows
 * come from {@link ATLAS_SEEDED_CATEGORIES}, which is what the migration's own
 * seed was generated from, in its order — top categories first, because a sub
 * category's parent has to exist before the foreign key will take it.
 */
async function seedAtlasCategories(db: Database): Promise<void> {
  for (const row of ATLAS_SEEDED_CATEGORIES) {
    await db
      .insert(atlasCategories)
      .values({
        slug: row.slug,
        title: row.title,
        standfirst: row.standfirst,
        parentSlug: row.parent,
      })
      .onConflictDoNothing()
  }
}

/**
 * Return the database to genuinely empty — no tables *and* no memory of having
 * had any. See {@link MIGRATIONS_SCHEMA} for why the second half matters.
 */
export async function resetDatabase(db: Database): Promise<void> {
  await db.execute(sql`drop schema if exists public cascade`)
  await db.execute(sql.raw(`drop schema if exists "${MIGRATIONS_SCHEMA}" cascade`))
  await db.execute(sql`create schema public`)
}

/**
 * Flatten an error and its causes into one searchable string.
 *
 * Drizzle wraps every driver error in a `DrizzleQueryError` whose own message is
 * just `Failed query: <sql>`; the interesting part — which constraint rejected
 * the row — is on the `cause`. Asserting against the wrapper would mean a test
 * that passes whenever the query fails *at all*, including for reasons that have
 * nothing to do with what it claims to check.
 */
export function databaseErrorMessage(error: unknown): string {
  const messages: string[] = []
  let current: unknown = error
  while (current instanceof Error) {
    messages.push(current.message)
    current = current.cause
  }
  return messages.join('\n')
}

/**
 * Assert that the database refuses an operation, and refuses it for the stated
 * reason. Use this rather than `expect(...).rejects.toThrow()`, which cannot see
 * past Drizzle's wrapper.
 */
export async function expectRejection(
  operation: () => Promise<unknown>,
  reason: RegExp,
): Promise<void> {
  let message: string | undefined
  try {
    await operation()
  } catch (error) {
    message = databaseErrorMessage(error)
  }
  if (message === undefined) {
    throw new Error(`expected the database to reject this, matching ${String(reason)}`)
  }
  if (!reason.test(message)) {
    throw new Error(`expected rejection matching ${String(reason)}, got:\n${message}`)
  }
}

/**
 * What the ledger says an agent's credit account sums to (`#553`).
 *
 * **A test-only reader, and it exists because the citizen-facing one stopped
 * being about money.** `balanceOfAgent` summed `ledger_entries` and
 * `reputation_events` and reported both; under D-106 the Colony holds no
 * balance for anybody, so it reports standing and nothing else.
 *
 * The escrow and steward-pay tests are not about a citizen's balance — they are
 * about the Colony's own double-entry bookkeeping, which `ledger_entries` still
 * holds and `#553` explicitly keeps. Reading the ledger directly is what those
 * assertions always meant; going through a citizen-facing balance was a
 * convenience that stopped being available.
 *
 * **Not exported from the package.** `testing.ts` is the test harness, and a
 * production caller that wants this number wants something the Colony does not
 * offer any more.
 */
export async function ledgerCreditsOf(db: Database, agentId: string): Promise<number> {
  const rows = await db.execute<{ total: string | null }>(
    sql`select coalesce(sum(amount), 0)::text as total from ledger_entries
        where account_kind = 'agent' and agent_id = ${agentId}`,
  )

  return Number(rows[0]?.total ?? '0')
}

/**
 * The person an arrival produced, or a failure naming the outcome (`#574`).
 *
 * `findOrCreateHuman` gained an outcome with **no person in it** — the address
 * reaching two people, which writes nothing and signs nobody in. That is the
 * point of the type, and it means every test that only wants *the person* has
 * to say what it expects when there is not one.
 *
 * Saying it here once beats a `!` at each call site: a non-null assertion turns
 * *the refusal fired* into *cannot read properties of undefined*, several lines
 * from the call that refused.
 */
export function personOf<T extends { readonly outcome: string; readonly human?: unknown }>(
  arrival: T,
): NonNullable<T['human']> {
  if (arrival.human === undefined || arrival.human === null) {
    throw new Error(`no person: the arrival was ${arrival.outcome}`)
  }
  return arrival.human as NonNullable<T['human']>
}
