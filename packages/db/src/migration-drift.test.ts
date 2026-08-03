import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import type { Database } from './client.js'
import { describeDrift, migrationTimestampDrift } from './migration-drift.js'
import { MIGRATIONS_SCHEMA, readJournal } from './migrations.js'
import { connectForTests, databaseTestTarget, resetDatabase } from './testing.js'

const target = databaseTestTarget()

/**
 * The state that was true for nine days while every signal read healthy.
 *
 * Asserted against a database this suite migrates itself, so the healthy case is
 * a real one rather than a fixture: every row was written by drizzle, from these
 * files, moments earlier. The drift is then introduced the only way it ever
 * arises — one wrong number in one row — and the check has to find it.
 */
describe('migration timestamp drift', () => {
  let db: Database

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  const journalWhen = async (tag: string): Promise<number> => {
    const journal = await readJournal()
    const entry = journal.find((candidate) => candidate.tag === tag)
    if (entry === undefined) throw new Error(`no journal entry for ${tag}`)
    return entry.when
  }

  const stamp = async (when: number, to: number): Promise<void> => {
    await db.execute(
      sql`update ${sql.identifier(MIGRATIONS_SCHEMA)}.__drizzle_migrations
          set created_at = ${to} where created_at = ${when}`,
    )
  }

  it('finds nothing on a database drizzle has just migrated', async () => {
    const report = await migrationTimestampDrift(db)

    expect(report.drifted).toEqual([])
    // Every file here is the text that was applied, so every row hashes to one.
    // Production carries one that does not — `0039_backfill_task_attempts`, whose
    // file was edited after it ran — which is why unmatched rows are counted and
    // not reported as findings.
    expect(report.unmatched).toBe(0)
  })

  it('reports a row stamped ahead of its journal entry', async () => {
    const journal = await readJournal()
    const victim = journal[Math.floor(journal.length / 2)]
    if (victim === undefined) throw new Error('the journal is empty')

    // 86,399,999 ms: the exact drift found in production on 2026-08-03, one
    // millisecond short of a day.
    const drifted = victim.when + 86_399_999
    await stamp(victim.when, drifted)

    try {
      const report = await migrationTimestampDrift(db)

      expect(report.drifted).toEqual([{ tag: victim.tag, recorded: drifted, journal: victim.when }])
      expect(report.unmatched).toBe(0)

      const described = describeDrift(report)
      expect(described).toContain(victim.tag)
      expect(described).toContain('86399999ms ahead of the journal')
      expect(described).toContain('disaster-recovery.md')
    } finally {
      await stamp(drifted, victim.when)
    }
  })

  it('reports a row stamped behind its journal entry', async () => {
    const when = await journalWhen('0000_initial_schema')
    await stamp(when, when - 1000)

    try {
      const report = await migrationTimestampDrift(db)

      expect(report.drifted).toEqual([
        { tag: '0000_initial_schema', recorded: when - 1000, journal: when },
      ])
      expect(describeDrift(report)).toContain('1000ms behind the journal')
    } finally {
      await stamp(when - 1000, when)
    }
  })

  /**
   * A row whose file was edited after it ran hashes to nothing, and this is the
   * case the check must not report — production has one, and a guard that cried
   * wolf on every run would be switched off within a week.
   */
  it('counts a row that hashes to no file, and does not report it', async () => {
    await db.execute(
      sql`insert into ${sql.identifier(MIGRATIONS_SCHEMA)}.__drizzle_migrations (hash, created_at)
          values ('not-the-hash-of-any-file-here', 1)`,
    )

    try {
      const report = await migrationTimestampDrift(db)

      expect(report.drifted).toEqual([])
      expect(report.unmatched).toBe(1)
    } finally {
      await db.execute(
        sql`delete from ${sql.identifier(MIGRATIONS_SCHEMA)}.__drizzle_migrations
            where hash = 'not-the-hash-of-any-file-here'`,
      )
    }
  })

  /**
   * A database drizzle has never touched has nothing to disagree with — the
   * case `check:drift` hits when it is pointed at a fresh database by mistake,
   * where an exception would read as a finding.
   *
   * Last in the file deliberately: it leaves the database without a schema, and
   * every test file migrates its own from scratch.
   */
  it('finds nothing where drizzle has never run', async () => {
    await resetDatabase(db)

    expect(await migrationTimestampDrift(db)).toEqual({ drifted: [], unmatched: 0 })
  })
})
