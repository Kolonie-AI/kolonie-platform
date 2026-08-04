import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { sql } from 'drizzle-orm'
import { createDatabase, DATABASE_URL_VAR, type Database } from './client.js'
import { MIGRATIONS_FOLDER, MIGRATIONS_SCHEMA } from './migrations.js'

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
 * **One call per test file, and never two in the same one.** It drops `public`
 * before it migrates, so a second `connectForTests` in a file that already has a
 * connection pulls the schema out from under the suite still using it. What that
 * looks like is not an error here — it is a lock wait and then a failing insert
 * in *another* file entirely, which is a long way from the change that caused
 * it. A second suite in one file shares the first suite's `db`, or moves to a
 * file of its own; a new file costs a reconnection and nothing else.
 *
 * **`fileParallelism` being on does not soften this** (`#284`). Files are
 * independent of *each other* because each worker slot owns a database, and that
 * is a statement about files in different slots. Two `connectForTests` calls in
 * one file are in one slot, in one database, and pull the schema out from under
 * each other exactly as before.
 */
export async function connectForTests(url: string): Promise<Database> {
  const db = createDatabase(url, { max: 1, onnotice: () => {} })
  await resetDatabase(db)
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER })
  return db
}

/**
 * Empty every table, leaving the schema in place.
 *
 * Every table is named even though `cascade` would reach most of them through a
 * foreign key. A table that is only truncated by cascade is one that silently
 * stops being truncated the day somebody adds it without a reference to
 * anything here — and a table that keeps rows between tests fails a later test
 * for a reason that is nowhere near it.
 */
export async function truncateAll(db: Database): Promise<void> {
  await db.execute(
    sql`truncate table task_hints, agent_contacts, agent_sessions, agent_origins, reputation_events, ledger_entries, verifications, submissions, website_challenges, social_challenges, github_challenges, credentials, tasks, agents restart identity cascade`,
  )
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
