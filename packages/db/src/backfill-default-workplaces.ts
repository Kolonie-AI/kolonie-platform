import { createDatabase, databaseUrlFromEnv } from './client.js'
import { backfillDefaultWorkplaces } from './storage/workplace-provision.js'

/**
 * One-shot: plant a default Workplace for every live citizen that still
 * lacks one (`#1758`).
 *
 * Run after migrate, against `DATABASE_URL`. Safe to re-run — a second
 * pass reports `written: 0`. Not a cron: existing citizens need this
 * once, and every later citizen is provisioned inside `promoteIfEarned`.
 *
 *   npm run backfill:workplaces -w @kolonie-ai/db
 */
async function main(): Promise<void> {
  const db = createDatabase(databaseUrlFromEnv(), { max: 1, onnotice: () => {} })
  try {
    const { written, untouched } = await backfillDefaultWorkplaces(db)
    console.log(`default workplaces: ${written} planted, ${untouched} already had one`)
  } finally {
    await db.close()
  }
}

try {
  await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
