import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { sql } from 'drizzle-orm'
import { createDatabase, DATABASE_URL_VAR, type Database } from './client.js'
import { MIGRATIONS_FOLDER, MIGRATIONS_SCHEMA } from './migrations.js'

// Re-exported so test files keep importing everything they need from one place.
export { MIGRATIONS_FOLDER, MIGRATIONS_SCHEMA }

const HOW_TO_PROVIDE_ONE = `Provide a PostgreSQL 16 server and set ${DATABASE_URL_VAR}, e.g.

  docker run -d --name kolonie-pg -e POSTGRES_PASSWORD=postgres \\
    -e POSTGRES_DB=kolonie_test -p 5432:5432 postgres:16
  export ${DATABASE_URL_VAR}=postgres://postgres:postgres@localhost:5432/kolonie_test

Any PostgreSQL 16 will do — the Compose stack in kolonie-infra is one way, not
the only one. See operations/testing.md in kolonie-docs.`

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
 */
export function databaseTestTarget(env: NodeJS.ProcessEnv = process.env): {
  available: true
  url: string
} {
  const url = env[DATABASE_URL_VAR]
  if (url !== undefined && url.trim() !== '') return { available: true, url }

  throw new Error(
    `${DATABASE_URL_VAR} is not set, so the database tests cannot run — and a suite that ` +
      `skips them silently reports green while covering nothing.\n\n${HOW_TO_PROVIDE_ONE}\n\n` +
      `If this change genuinely needs no database, run \`npm run check:fast\`, which runs ` +
      `everything except the tests and says so.`,
  )
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
 * file of its own; `fileParallelism` is off, so a new file costs a reconnection
 * and nothing else.
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
