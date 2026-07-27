import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { createDatabase, type Database } from './client.js'
import { databaseTestTarget, MIGRATIONS_FOLDER, resetDatabase } from './testing.js'

const target = databaseTestTarget()

if (!target.available) {
  // Deliberately console, and deliberately at module scope: this has to be
  // visible before the reporter prints a tidy "skipped".
  console.warn(`\n${target.reason}\n`)
}

/**
 * The two properties a migration has to have before it is allowed near a live
 * database: it works on nothing, and running it twice is the same as running it
 * once. Both are cheap to assert and expensive to discover in production.
 */
describe.skipIf(!target.available)('the migrations', () => {
  let db: Database

  const objectCounts = async () => {
    const [row] = await db.execute<{ tables: string; enums: string; triggers: string }>(
      sql`select
            (select count(*)::text from information_schema.tables
              where table_schema = 'public' and table_type = 'BASE TABLE') as tables,
            (select count(distinct t.typname)::text from pg_type t
               join pg_enum e on e.enumtypid = t.oid
               join pg_namespace n on n.oid = t.typnamespace
              where n.nspname = 'public') as enums,
            (select count(*)::text from pg_trigger
              where not tgisinternal) as triggers`,
    )
    return row!
  }

  beforeAll(async () => {
    if (!target.available) return
    // `drop schema if exists` and drizzle's `create ... if not exists` both emit
    // notices; they are expected here and would only be noise in the report.
    db = createDatabase(target.url, { max: 1, onnotice: () => {} })
    // An empty database, not merely a truncated one — the schema itself is what
    // is under test here. This also drops drizzle's migration bookkeeping;
    // without that, `migrate()` would report success and create nothing.
    await resetDatabase(db)
  })

  afterAll(async () => {
    await db?.close()
  })

  it('applies to an empty database, then leaves it unchanged on re-run', async () => {
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER })
    const afterFirst = await objectCounts()

    // The five tables the MVP loop needs. Drizzle's bookkeeping table is not
    // among them — it lives in its own schema, which is why `resetDatabase`
    // has to drop that one too.
    expect(afterFirst.tables).toBe('5')
    expect(afterFirst.enums).toBe('9')
    // The deferred double-entry constraint trigger, on ledger_entries.
    expect(afterFirst.triggers).toBe('1')

    await expect(migrate(db, { migrationsFolder: MIGRATIONS_FOLDER })).resolves.not.toThrow()
    expect(await objectCounts()).toEqual(afterFirst)
  })
})
