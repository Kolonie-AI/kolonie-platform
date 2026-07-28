/**
 * Where the migrations are and where Drizzle remembers applying them.
 *
 * Their own module rather than part of `testing.ts`, because `migrate.ts` needs
 * both and `migrate.ts` is what runs against the live database. Reaching into
 * the test helpers for them would put `resetDatabase` — which drops `public` —
 * in the import graph of the deploy step. Nothing would call it; it simply has
 * no business being loadable there.
 */
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
