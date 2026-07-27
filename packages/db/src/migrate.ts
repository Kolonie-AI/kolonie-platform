import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { fileURLToPath } from 'node:url'
import { createDatabase, databaseUrlFromEnv } from './client.js'

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
    await migrate(db, {
      migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)),
    })
    console.log('migrations applied')
  } finally {
    await db.close()
  }
}

await main()
