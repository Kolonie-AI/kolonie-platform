import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { sql } from 'drizzle-orm'
import { fileURLToPath } from 'node:url'
import { createDatabase, DATABASE_URL_VAR, type Database } from './client.js'

/** Where the generated SQL lives, resolved from this file so cwd does not matter. */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../drizzle', import.meta.url))

/**
 * Drizzle records which migrations have run in `__drizzle_migrations`, and puts
 * that table in its **own** schema rather than in `public`.
 *
 * This is worth knowing before you reset a database by hand: dropping `public`
 * alone leaves the bookkeeping intact, so the next `migrate()` believes
 * everything is applied, does nothing, and hands back an empty database without
 * an error. Anything that wipes the database must wipe both schemas — which is
 * what `resetDatabase` is for.
 */
export const MIGRATIONS_SCHEMA = 'drizzle'

/**
 * Whether we are on a CI runner.
 *
 * GitHub Actions, GitLab, CircleCI and Travis all set `CI=true`. The check is on
 * the environment rather than on a flag the caller passes, because a flag can be
 * forgotten and a forgotten flag is exactly the failure this guards against.
 */
const onCi = (env: NodeJS.ProcessEnv): boolean => env.CI === 'true' || env.CI === '1'

const HOW_TO_PROVIDE_ONE = `Provide a PostgreSQL 16 server and set ${DATABASE_URL_VAR}, e.g.

  docker run -d --name kolonie-pg -e POSTGRES_PASSWORD=postgres \\
    -e POSTGRES_DB=kolonie_test -p 5432:5432 postgres:16
  export ${DATABASE_URL_VAR}=postgres://postgres:postgres@localhost:5432/kolonie_test

Any PostgreSQL 16 will do — the Compose stack in kolonie-infra is one way, not
the only one. See operations/testing.md in kolonie-docs.`

/**
 * Decide whether the database-backed tests in this package can run.
 *
 * This function is where D-009's second half lives, and it is the part that is
 * easy to get wrong. Integration tests that quietly pass when their variable is
 * unset report green while covering nothing, nobody notices, and within a month
 * the suite has stopped testing the database without a single failure to
 * announce it. That is the same class of defect as a deploy pipeline that had
 * never once succeeded while every failure was read as a known problem.
 *
 * So the two environments are treated differently on purpose:
 *
 * - **On CI**, a missing `DATABASE_URL` throws. The configuration is broken and
 *   the build must say so rather than silently narrowing what it checked.
 * - **Locally**, it skips — but returns the reason, and the reason is a command
 *   that fixes it. A skip that does not teach is a skip that becomes permanent.
 */
export function databaseTestTarget(
  env: NodeJS.ProcessEnv = process.env,
): { available: true; url: string } | { available: false; reason: string } {
  const url = env[DATABASE_URL_VAR]
  if (url !== undefined && url.trim() !== '') return { available: true, url }

  if (onCi(env)) {
    throw new Error(
      `${DATABASE_URL_VAR} is not set on CI. Database tests must never be skipped there: ` +
        `a suite that skips silently reports green while covering nothing. ` +
        `Add a postgres:16 service to the workflow.`,
    )
  }

  return {
    available: false,
    reason: `${DATABASE_URL_VAR} is not set, so the database tests were skipped.\n\n${HOW_TO_PROVIDE_ONE}`,
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
export async function connectForTests(url: string): Promise<Database> {
  const db = createDatabase(url, { max: 1, onnotice: () => {} })
  await resetDatabase(db)
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER })
  return db
}

/** Empty every table, leaving the schema in place. */
export async function truncateAll(db: Database): Promise<void> {
  await db.execute(
    sql`truncate table reputation_events, ledger_entries, submissions, credentials, tasks, agents restart identity cascade`,
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
