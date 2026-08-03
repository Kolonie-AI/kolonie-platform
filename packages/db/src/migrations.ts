/**
 * Where the migrations are and where Drizzle remembers applying them.
 *
 * Their own module rather than part of `testing.ts`, because `migrate.ts` needs
 * both and `migrate.ts` is what runs against the live database. Reaching into
 * the test helpers for them would put `resetDatabase` — which drops `public` —
 * in the import graph of the deploy step. Nothing would call it; it simply has
 * no business being loadable there.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
 * what `resetDatabase` in `testing.ts` is for.
 */
export const MIGRATIONS_SCHEMA = 'drizzle'

/** One entry of drizzle's journal, as it is written on disk. */
export interface JournalEntry {
  readonly idx: number
  readonly when: number
  readonly tag: string
}

/**
 * The journal, read from the migrations folder.
 *
 * **The journal and not the directory listing**, because the journal is what
 * drizzle's migrator reads: a `.sql` file nobody registered is not a migration,
 * and an entry whose file is missing is a migration that cannot run. The test
 * beside this asserts the two agree, which is the only place that question is
 * worth asking.
 */
export async function readJournal(): Promise<readonly JournalEntry[]> {
  const raw = await readFile(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')
  const journal = JSON.parse(raw) as { entries?: JournalEntry[] }

  return journal.entries ?? []
}
