import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { sql } from 'drizzle-orm'
import { createDatabase, databaseUrlFromEnv, type Database } from './client.js'
import { describeDrift, migrationTimestampDrift } from './migration-drift.js'
import { MIGRATIONS_FOLDER, MIGRATIONS_SCHEMA, readJournal } from './migrations.js'

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
 * Which migrations the journal has and the database does not.
 *
 * **Matched on the timestamp, which is the key drizzle itself decides with.**
 * `migrate()` records `created_at` as the journal's `when`, and chooses what to
 * apply by comparing those numbers — so asking the same question the same way
 * is the only version of this check that cannot disagree with the migrator
 * about what "applied" means.
 *
 * **Not by hash**, which was the first attempt and is wrong in a way worth
 * recording: the hash is of the file's contents, so a migration whose file was
 * edited after it ran looks exactly like one that never ran. This repository has
 * one — `0039_backfill_task_attempts` — and a guard keyed on hashes would have
 * failed every deploy from the moment it shipped, which is the same class of
 * false confidence it exists to remove, pointed the other way.
 *
 * **Rows with no journal entry are not reported.** They are migrations that were
 * squashed or renamed after being applied, the database is ahead of the tree,
 * and nothing is missing. Only the other direction is a failure.
 *
 * This exists because on 2026-08-03 the honest answer to *did the migrations
 * run* was **no** while every signal said yes. Drizzle does not track migrations
 * individually: it reads the newest `created_at` and applies every journal entry
 * newer than that, so one entry stamped in the future — `drizzle-kit` takes
 * `when` from the clock of whichever machine generated the file — silently
 * swallowed the five that followed it while printing `none pending`. Three
 * deploys reported success with the tables missing.
 *
 * The guard against writing another such entry is in `migrate.test.ts`. This is
 * the guard against one that is already in a database, which no test in this
 * repository can reach.
 */
async function unappliedTags(db: Database): Promise<readonly string[]> {
  const journal = await readJournal()
  if (journal.length === 0) return []

  const rows = await db.execute<{ created_at: string }>(
    sql`select created_at::text from ${sql.identifier(MIGRATIONS_SCHEMA)}.__drizzle_migrations`,
  )
  const applied = new Set(rows.map((row) => Number(row.created_at)))

  return journal.filter((entry) => !applied.has(entry.when)).map((entry) => entry.tag)
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

    /**
     * **The line that makes the two above trustworthy.** Without it, `none
     * pending` is a statement about what drizzle decided rather than about the
     * database — and those came apart once, expensively.
     *
     * Thrown rather than warned: a deploy whose schema did not arrive must stop
     * at the step that failed, not three steps later in a seed. `deploy.sh`
     * already exits on a non-zero migrator.
     */
    const missing = await unappliedTags(db)
    if (missing.length > 0) {
      throw new Error(
        `${missing.length} migration(s) are in the journal and not in the database: ` +
          `${missing.join(', ')}.\n\n` +
          'Drizzle applies journal entries newer than the newest `created_at` it has ' +
          'recorded, so one entry stamped ahead of its neighbours hides every migration ' +
          'after it while reporting that there is nothing to do. See ' +
          'kolonie-infra/docs/disaster-recovery.md, Scenario 6, for the one-row repair.',
      )
    }

    /**
     * **The check above asks whether everything ran; this one asks whether the
     * record still describes it** — and on 2026-08-03 the answer to the second
     * was *no* for nine days while the first read healthy the whole time
     * (`#267`).
     *
     * Thrown rather than warned, for the same reason as the line above and one
     * more: the state is dormant, so a warning has no deadline attached to it.
     * The first thing that makes a drifted row matter is the next migration
     * authored below it, and by then it is hiding that migration rather than
     * describing itself. `check-migration-drift.ts` is the same question asked
     * without a deploy, which is how it gets found before it costs anything.
     */
    const drift = await migrationTimestampDrift(db)
    if (drift.drifted.length > 0) throw new Error(describeDrift(drift))
  } finally {
    await db.close()
  }
}

await main()
