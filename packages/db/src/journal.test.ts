import { describe, expect, it } from 'vitest'
import {
  duplicateFilePrefixes,
  duplicateIndexes,
  journalFileMismatches,
  migrationFileTags,
  outOfOrderStamps,
} from './journal.js'
import { readJournal, type JournalEntry } from './migrations.js'

/**
 * The guard on the most-contended file in this repository.
 *
 * **All four invariants held on the day this was written** — 92 SQL files, 92
 * journal entries, `when` strictly increasing across all of them, no duplicate
 * `idx` — which is what makes this a guard rather than a bug report. Green on
 * arrival is the point.
 *
 * Each invariant is asserted twice: against the real journal, and against a
 * fixture that violates it. The second half is not ceremony. A check nobody has
 * seen go red is a check nobody has seen, and the failure this suite exists for
 * is a rewrite that quietly stops comparing anything — which the first half
 * would pass forever.
 *
 * No database. `migrate.test.ts` beside this one needs `DATABASE_URL` and these
 * questions do not, so they were separated: this file reads the journal and the
 * directory and runs anywhere `npm run check` does.
 */
describe('the migration journal', () => {
  const entry = (idx: number, when: number, tag: string): JournalEntry => ({ idx, when, tag })

  describe('every idx appears once', () => {
    it('holds', async () => {
      expect(duplicateIndexes(await readJournal())).toEqual([])
    })

    it('catches a merge that kept both sides', () => {
      const problems = duplicateIndexes([
        entry(86, 1785700000000, '0086_a'),
        entry(87, 1785700001000, '0087_a'),
        entry(87, 1785700002000, '0087_b'),
      ])

      expect(problems).toHaveLength(1)
      expect(problems[0]).toContain('0087_a and 0087_b')
      expect(problems[0]).toContain('npm run generate')
    })
  })

  describe('every file prefix appears once', () => {
    it('holds', async () => {
      expect(duplicateFilePrefixes(await migrationFileTags())).toEqual([])
    })

    it('catches two migrations generated against the same tree', () => {
      const problems = duplicateFilePrefixes(['0086_a', '0087_a', '0087_b'])

      expect(problems).toHaveLength(1)
      expect(problems[0]).toContain('0087_a.sql and 0087_b.sql')
    })

    it('catches a file that no generator produced', () => {
      const problems = duplicateFilePrefixes(['0086_a', 'hotfix'])

      expect(problems).toHaveLength(1)
      expect(problems[0]).toContain('hotfix.sql has no numeric prefix')
    })
  })

  describe('the journal and the directory agree', () => {
    it('holds', async () => {
      const [entries, tags] = await Promise.all([readJournal(), migrationFileTags()])
      expect(journalFileMismatches(entries, tags)).toEqual([])
    })

    it('catches an entry whose file is gone', () => {
      const problems = journalFileMismatches([entry(86, 1785700000000, '0086_a')], [])

      expect(problems).toHaveLength(1)
      expect(problems[0]).toContain('drizzle/0086_a.sql does not exist')
    })

    it('catches a file nothing registered', () => {
      const problems = journalFileMismatches([], ['0086_a'])

      expect(problems).toHaveLength(1)
      expect(problems[0]).toContain('has no journal entry, so it will never run')
    })
  })

  describe('when increases with idx', () => {
    it('holds', async () => {
      expect(outOfOrderStamps(await readJournal())).toEqual([])
    })

    /**
     * The real numbers from 2026-08-03: `0079` carried a stamp twenty-two hours
     * ahead of its neighbours, five migrations landed after it, none of them
     * ran, and three deploys reported success.
     */
    it('catches the entry that was twenty-two hours ahead', () => {
      const problems = outOfOrderStamps([
        entry(78, 1785696615380, '0078'),
        entry(79, 1785783015380, '0079'),
        entry(80, 1785703035903, '0080'),
      ])

      expect(problems).toHaveLength(1)
      expect(problems[0]).toContain('0080 is numbered after 0079')
      expect(problems[0]).toContain('Regenerate the later migration')
    })

    /** Read in `idx` order, not in the order the entries happen to be written. */
    it('catches it whichever order the entries are stored in', () => {
      const problems = outOfOrderStamps([
        entry(80, 1785703035903, '0080'),
        entry(78, 1785696615380, '0078'),
        entry(79, 1785783015380, '0079'),
      ])

      expect(problems).toHaveLength(1)
      expect(problems[0]).toContain('0080 is numbered after 0079')
    })

    /** Equal stamps are the same defect: neither order is the one on disk. */
    it('refuses two entries stamped at the same millisecond', () => {
      const problems = outOfOrderStamps([
        entry(78, 1785696615380, '0078'),
        entry(79, 1785696615380, '0079'),
      ])

      expect(problems).toHaveLength(1)
      expect(problems[0]).toContain('0079 is numbered after 0078')
    })
  })
})
