/**
 * Whether the database's migration bookkeeping still describes what ran.
 *
 * **A different question from the one `migrate.ts` already asks.** That one asks
 * *did everything run* — journal entries against recorded timestamps, after
 * migrating. This asks *does the record still describe it*, and the difference
 * is nine days long.
 *
 * On 2026-08-03 the deploy failed twice with `1 migration(s) are in the journal
 * and not in the database`. The cause was one row in
 * `drizzle.__drizzle_migrations` — `0079_the_image_rung_certifies_drawing` —
 * carrying a `created_at` exactly 86,399,999 ms ahead of its journal `when`.
 * Drizzle applies only entries newer than the newest recorded timestamp, so
 * everything below that row was invisible.
 *
 * That row had been wrong since 2026-07-25. The repair on the day it surfaced
 * ran the migrations it had hidden and left the row itself untouched, so the
 * future stamp sat there waiting for the next migration to be authored below it.
 * Nine days later one was.
 *
 * **The three defences that existed all did their job and all missed it.**
 * `journal.test.ts` checks the journal is strictly increasing — it was, and is;
 * the drift is in the database. The migrator compares journal against database
 * after migrating — that is what fired, correctly, and stopped the deploy nine
 * days late. `deploy.sh` counts `.sql` files against rows — a count, and the row
 * was present. None of them compares a recorded `created_at` to the journal's
 * `when` for the same migration, which is the fact that was wrong the whole
 * time while every signal read healthy.
 *
 * **Rows are identified by hash**, because it is the only link the bookkeeping
 * offers: `__drizzle_migrations` holds `id`, `hash` and `created_at`, and no
 * tag. The hash is `sha256` of the migration file's whole text, which is how
 * drizzle computes it when it applies one.
 *
 * **A row whose hash matches nothing is skipped, and counted rather than
 * silently dropped.** A migration whose file was edited after it ran hashes to
 * something no file produces — this repository has one,
 * `0039_backfill_task_attempts` — so a check that treated an unmatched row as a
 * finding would cry wolf on every run. The honest cost is that such a row's
 * timestamp cannot be checked at all, which is why the count is reported: one
 * unmatched row is the known one, and a second is a question worth asking.
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import type { Database } from './client.js'
import { MIGRATIONS_FOLDER, MIGRATIONS_SCHEMA, readJournal } from './migrations.js'

/** One migration whose recorded timestamp disagrees with the journal. */
export interface DriftedRow {
  readonly tag: string
  /** What `__drizzle_migrations` says. This is the value drizzle decides with. */
  readonly recorded: number
  /** What `_journal.json` says. This is the value a person reads. */
  readonly journal: number
}

export interface DriftReport {
  readonly drifted: readonly DriftedRow[]
  /**
   * Rows whose hash matches no file in the journal, and whose timestamps this
   * check therefore cannot speak for. One is expected — see the module comment.
   */
  readonly unmatched: number
}

/** `sha256` of each migration file's text, as drizzle computes it. */
async function journalByHash(
  folder = MIGRATIONS_FOLDER,
): Promise<ReadonlyMap<string, { tag: string; when: number }>> {
  const entries = await readJournal()
  const byHash = new Map<string, { tag: string; when: number }>()

  for (const entry of entries) {
    const text = await readFile(join(folder, `${entry.tag}.sql`), 'utf8')
    byHash.set(createHash('sha256').update(text).digest('hex'), {
      tag: entry.tag,
      when: entry.when,
    })
  }

  return byHash
}

/**
 * Compare every recorded migration against the journal entry it is a record of.
 *
 * Returns rather than throws, so the caller decides what a finding is worth: the
 * standalone check exits non-zero on one, and `migrate.ts` refuses the deploy.
 * On a database that has never been migrated there is no bookkeeping table and
 * nothing to disagree with, which is not a finding either.
 */
export async function migrationTimestampDrift(
  db: Database,
  folder = MIGRATIONS_FOLDER,
): Promise<DriftReport> {
  const qualified = `${MIGRATIONS_SCHEMA}.__drizzle_migrations`
  const [presence] = await db.execute<{ present: boolean }>(
    sql`select to_regclass(${qualified}) is not null as present`,
  )
  if (presence?.present !== true) return { drifted: [], unmatched: 0 }

  const byHash = await journalByHash(folder)
  const rows = await db.execute<{ hash: string; created_at: string }>(
    sql`select hash, created_at::text from ${sql.identifier(MIGRATIONS_SCHEMA)}.__drizzle_migrations`,
  )

  const drifted: DriftedRow[] = []
  let unmatched = 0

  for (const row of rows) {
    const entry = byHash.get(row.hash)
    if (entry === undefined) {
      unmatched += 1
      continue
    }
    const recorded = Number(row.created_at)
    if (recorded !== entry.when) drifted.push({ tag: entry.tag, recorded, journal: entry.when })
  }

  return { drifted, unmatched }
}

/**
 * What to print when the check finds something, written for whoever is looking
 * at it without having read this file.
 *
 * The repair is one `update` against one row and the reader has to be told which
 * row and to what — a finding that only says *these disagree* leaves them to
 * work out which of the two numbers is the true one, and the answer is not
 * obvious: the journal is the true one because it is what every future migration
 * will be ordered against.
 */
export function describeDrift(report: DriftReport): string {
  const lines = report.drifted.map((row) => {
    const direction =
      row.recorded > row.journal
        ? `${row.recorded - row.journal}ms ahead of`
        : `${row.journal - row.recorded}ms behind`
    return `  ${row.tag}: recorded ${row.recorded}, journal ${row.journal} (${direction} the journal)`
  })

  return (
    `${report.drifted.length} migration row(s) carry a created_at that disagrees with the journal:\n` +
    `${lines.join('\n')}\n\n` +
    'Drizzle applies journal entries newer than the newest recorded created_at, so a row ' +
    'stamped ahead of its entry hides every migration authored below it while reporting ' +
    'nothing pending. The journal is the value to keep — it is what every future migration ' +
    'is ordered against — so the repair is one update per row, setting created_at to the ' +
    'journal value. See kolonie-infra/docs/disaster-recovery.md, Scenario 6.'
  )
}
