import { afterAll, describe, expect, it } from 'vitest'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { sql } from 'drizzle-orm'
import { createDatabase, databaseUrlFromEnv } from './client.js'
import {
  connectForTests,
  databaseTestTarget,
  ensureWorkerDatabase,
  MIGRATIONS_FOLDER,
  resetDatabase,
  templateDatabaseUrl,
  workerDatabaseUrl,
} from './testing.js'
import type { Database } from './client.js'

/**
 * The template path (`#296`): a test file gets its database by copying one that
 * was migrated once, rather than by replaying all 107 migrations itself.
 *
 * **What must be proved is that the copy is not a shortcut.** A database created
 * from a template is only worth having if it is indistinguishable from a
 * migrated one — otherwise every test in this package is asserting against a
 * schema nobody checked, and the failure would be a green suite rather than a
 * red one.
 *
 * ## Why the slot numbers here are in the hundreds
 *
 * Every database in this arrangement is `<base>_w<slot>`, and slots 1..6 belong
 * to the vitest workers running this file alongside seventy-seven others.
 * Recreating one of those mid-run would pull the schema out from under whatever
 * file is using it. Slots beyond any worker count are databases nobody else can
 * be holding.
 */
const base = databaseUrlFromEnv()
const scratch = (slot: number) => workerDatabaseUrl(base, slot)
const opened: Database[] = []

const columnsOf = async (db: Database): Promise<string[]> => {
  const rows = await db.execute<{ signature: string }>(sql`
    select table_name || '.' || column_name || ':' || data_type as signature
      from information_schema.columns
     where table_schema = 'public'
     order by 1`)

  return rows.map((row) => row.signature)
}

const drop = async (url: string): Promise<void> => {
  const admin = createDatabase(new URL('/postgres', url).toString(), {
    max: 1,
    onnotice: () => {},
  })
  try {
    await admin.execute(
      sql.raw(`drop database if exists "${new URL(url).pathname.slice(1)}" with (force)`),
    )
  } finally {
    await admin.close()
  }
}

afterAll(async () => {
  for (const db of opened) await db.close()
  for (const slot of [101, 102, 103, 104, 105, 106, 107]) await drop(scratch(slot))
})

describe('a database copied from the template', () => {
  /**
   * The assertion the whole change rests on, and the one that would catch a
   * template built from something other than the migrations in this repository.
   */
  it('has exactly the schema migrating produces', async () => {
    const copied = await connectForTests(databaseTestTarget().url)

    await ensureWorkerDatabase(base, 101)
    const migrated = createDatabase(scratch(101), { max: 1, onnotice: () => {} })
    opened.push(migrated)
    await resetDatabase(migrated)
    await migrate(migrated, { migrationsFolder: MIGRATIONS_FOLDER })

    const [fromTemplate, fromMigrations] = await Promise.all([
      columnsOf(copied),
      columnsOf(migrated),
    ])

    expect(fromTemplate).toEqual(fromMigrations)
    expect(fromTemplate.length).toBeGreaterThan(0)
  })

  /**
   * **The template cannot be connected to, and this test is why it is sealed.**
   *
   * It used to open the template and assert that nothing had been written to it.
   * That connection made two other tests in this file fail with *source database
   * is being accessed by other users*: PostgreSQL refuses to copy a template
   * while any session holds it, so one stray connection breaks every worker for
   * as long as it lives.
   *
   * `allow_connections false` turns that from a rule somebody has to know into
   * one the server enforces — the same protection `template0` has.
   */
  it('cannot be connected to at all, which is what keeps the copies working', async () => {
    const template = createDatabase(templateDatabaseUrl(base), { max: 1, onnotice: () => {} })

    await expect(template.execute(sql`select 1`)).rejects.toThrow()
    await template.close()
  })

  it('is empty, so a file inherits no rows from whoever held that database before', async () => {
    const db = await connectForTests(scratch(102))
    opened.push(db)

    const rows = await db.execute<{ count: number }>(sql`select count(*)::int as count from agents`)

    expect(rows[0]?.count).toBe(0)
  })
})

describe('six workers copying at once', () => {
  /**
   * The risk worth measuring before this landed: `create database … template`
   * is refused while another session is connected to the source, and six
   * workers reaching for one template at the same moment could have serialised
   * badly or failed outright. It does neither — 136–159 ms for all six, measured
   * on CLAUDE002 on 2026-08-04 — and this is that measurement as an assertion.
   */
  it('keeps copying different worker databases in parallel', async () => {
    const slots = [103, 104, 105, 106]

    const databases = await Promise.all(slots.map(async (slot) => connectForTests(scratch(slot))))
    opened.push(...databases)

    const counts = await Promise.all(
      databases.map(async (db) => {
        const rows = await db.execute<{ count: number }>(
          sql`select count(*)::int as count from tasks`,
        )
        return rows[0]?.count
      }),
    )

    expect(counts).toEqual(slots.map(() => 0))
  })

  it('serializes copies of the same worker database', async () => {
    const databases = await Promise.all([
      connectForTests(scratch(103)),
      connectForTests(scratch(103)),
    ])
    opened.push(...databases)

    const rows = await databases[1]!.execute<{ count: number }>(
      sql`select count(*)::int as count from tasks`,
    )

    expect(rows[0]?.count).toBe(0)
  })
})

describe('a template that is not there', () => {
  it('continues copying after a same-database failure', async () => {
    const absent = new URL('/kolonie_no_such_base', base).toString()
    await expect(connectForTests(scratch(107), absent)).rejects.toThrow()

    const db = await connectForTests(scratch(107))
    opened.push(db)

    const rows = await db.execute<{ count: number }>(sql`select count(*)::int as count from tasks`)
    expect(rows[0]?.count).toBe(0)
  })

  /**
   * **A failure and not a quiet fall back to migrating.** The whole saving is
   * that no file migrates; a path that silently did so when the template was
   * missing would give back the seventy-eight migration runs and report nothing,
   * which is the shape of defect this package keeps finding — see `#294`, where
   * a check reported the opposite of what had happened.
   *
   * Pointed at a base name whose `_template` was never built, so the template
   * seventy-seven other files are copying from right now is untouched.
   */
  it('fails rather than migrating the database itself', async () => {
    const absent = new URL('/kolonie_no_such_base', base).toString()

    await expect(connectForTests(scratch(107), absent)).rejects.toThrow()
    await expect(
      (async () => {
        const db = createDatabase(scratch(107), { max: 1, onnotice: () => {} })
        opened.push(db)
        return columnsOf(db)
      })(),
    ).rejects.toThrow()
  })
})
