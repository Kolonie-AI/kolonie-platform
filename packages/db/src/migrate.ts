import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { sql } from 'drizzle-orm'
import { createDatabase, databaseUrlFromEnv, type Database } from './client.js'
import { MIGRATIONS_FOLDER, MIGRATIONS_SCHEMA } from './migrations.js'

/**
 * How many migrations Drizzle has recorded so far.
 *
 * Asked in two statements rather than one, because Postgres resolves every
 * table reference at parse time: a `case when to_regclass(…) is null then 0
 * else (select count(*) from …) end` still fails on a database where the
 * bookkeeping does not exist yet — which is exactly the case it was written to
 * handle. So: ask whether the table is there, then ask it what it holds.
 */
async function appliedCount(db: Database): Promise<number> {
  const qualified = `${MIGRATIONS_SCHEMA}.__drizzle_migrations`
  const [presence] = await db.execute<{ present: boolean }>(
    sql`select to_regclass(${qualified}) is not null as present`,
  )
  if (presence?.present !== true) return 0

  const [row] = await db.execute<{ count: string }>(
    sql`select count(*)::text as count from ${sql.identifier(MIGRATIONS_SCHEMA)}.__drizzle_migrations`,
  )
  return Number(row?.count ?? 0)
}

/**
 * Apply every pending migration, then exit.
 *
 * This is what runs against the live database on deploy, and it is deliberately
 * a separate process rather than something `apps/api` does at startup. Two API
 * containers starting at once would otherwise race to migrate the same database,
 * and the loser's behaviour depends on which statement it happened to reach —
 * exactly the kind of failure that is impossible to reproduce afterwards.
 *
 * Re-running it is safe: Drizzle records what has been applied and skips it.
 *
 * It counts before and after and reports which of the two happened. `migrate()`
 * is silent about how much work it found, and a deploy step that prints the
 * same line whether it created six tables or nothing at all is a step nobody
 * can read an answer out of afterwards — see kolonie-infra#9.
 */
async function main(): Promise<void> {
  const db = createDatabase(databaseUrlFromEnv(), {
    max: 1,
    // Drizzle's own bookkeeping uses CREATE ... IF NOT EXISTS, so Postgres
    // emits "already exists, skipping" notices on every run after the first.
    // Printed raw they look like errors on a deploy log that nobody wants to
    // learn to ignore — and a log people learn to ignore is a log that hides
    // the next real failure. Errors are unaffected: they still throw.
    onnotice: () => {},
  })
  try {
    const before = await appliedCount(db)
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER })
    const after = await appliedCount(db)

    if (after === before) {
      console.log(`migrations: none pending, ${after} already applied`)
    } else {
      console.log(`migrations: applied ${after - before}, ${after} in total`)
    }
  } finally {
    await db.close()
  }
}

await main()
