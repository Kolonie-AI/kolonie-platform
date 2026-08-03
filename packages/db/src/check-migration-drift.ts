/**
 * Ask a database whether its migration bookkeeping still describes what ran.
 *
 * **Its own entry point, and that is the point of the issue behind it
 * (`#267`).** The same comparison runs on every deploy, and a check that only
 * runs on a deploy would have found the 2026-08-03 drift on 2026-08-03 — which
 * is where it was found, nine days and one hidden migration too late. The state
 * this detects is dormant: nothing is failing while it is true, so nothing
 * prompts anybody to look. Something that can be run on an ordinary afternoon is
 * the only version of this that closes that gap.
 *
 * Reads only. It reports the repair rather than performing it, because the
 * repair is an `update` against drizzle's own bookkeeping on a live database and
 * that is not a thing a diagnostic should do while nobody is watching.
 *
 *     npm run build -w @kolonie-ai/db
 *     DATABASE_URL=… npm run check:drift -w @kolonie-ai/db
 */
import { createDatabase, databaseUrlFromEnv } from './client.js'
import { describeDrift, migrationTimestampDrift } from './migration-drift.js'

async function main(): Promise<void> {
  const db = createDatabase(databaseUrlFromEnv(), { max: 1, onnotice: () => {} })
  try {
    const report = await migrationTimestampDrift(db)

    // Reported on the way past whatever the verdict is: one is the known
    // edited-after-it-ran migration, and a second is worth somebody knowing
    // about, because those rows are the ones this check cannot speak for.
    console.log(
      `migration bookkeeping: ${report.unmatched} row(s) hash to no file in the journal ` +
        'and were not checked',
    )

    if (report.drifted.length === 0) {
      console.log('migration bookkeeping: every checked row agrees with the journal')
      return
    }

    console.error(describeDrift(report))
    process.exitCode = 1
  } finally {
    await db.close()
  }
}

await main()
