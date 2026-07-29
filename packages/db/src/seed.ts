import { seedAcademyTasks } from './academy-tasks.js'
import { createDatabase, databaseUrlFromEnv } from './client.js'

/**
 * Put the Academy tasks in the database, then exit.
 *
 * A separate process from `migrate`, and run after it, for the reason
 * `migrate.ts` is separate from the API: a step that does one thing can be run
 * again on its own when it is the thing that failed. It is safe to re-run — see
 * `seedAcademyTasks` for why that is a property of the data rather than a check
 * around it.
 *
 * It reports what it changed. `GET /v1/tasks` returning an empty list is the
 * failure this whole script exists to prevent, and a deploy log that prints the
 * same line whether it seeded three tasks or none cannot tell anyone whether it
 * was prevented — the same argument as kolonie-infra#9.
 */
async function main(): Promise<void> {
  const db = createDatabase(databaseUrlFromEnv(), { max: 1, onnotice: () => {} })
  try {
    const { inserted, updated, hints } = await seedAcademyTasks(db)
    console.log(
      `academy tasks: ${inserted} inserted, ${updated} already present and refreshed, ` +
        `${hints} hints serving`,
    )
  } finally {
    await db.close()
  }
}

await main()
