import { describe, expect, it } from 'vitest'
import { DATABASE_URL_VAR } from './client.js'
import { databaseTestTarget, testWorkerSlot, workerDatabaseUrl } from './testing.js'

/**
 * These need no database — they are about what happens when there isn't one.
 *
 * D-009 turns on this guard, so it is asserted rather than assumed. It used to
 * assert an asymmetry: throw on CI, skip locally. `#224` removed the asymmetry
 * after a full `npm run check` exited 0 with 938 of 2747 tests unrun and one
 * `console.warn` to say so, so what is pinned here now is that **there is no
 * environment in which this skips** — including the one where somebody has tried
 * to arrange it.
 */
describe('databaseTestTarget', () => {
  const url = 'postgres://user:pw@example.invalid:5432/db'

  /**
   * The URL that comes back is **this worker's**, not the one that went in
   * (`#284`). The caller still supplies one server through one variable; which
   * database on it belongs to this process is decided here, below that interface.
   */
  it('uses the variable when it is set, pointing it at this worker database', () => {
    expect(databaseTestTarget({ [DATABASE_URL_VAR]: url, VITEST_POOL_ID: '2' })).toEqual({
      available: true,
      url: 'postgres://user:pw@example.invalid:5432/db_w2',
    })
  })

  it('throws when the variable is missing', () => {
    expect(() => databaseTestTarget({})).toThrow(/cannot run/)
  })

  it('throws when the variable is empty rather than absent', () => {
    expect(() => databaseTestTarget({ [DATABASE_URL_VAR]: '   ' })).toThrow(/cannot run/)
  })

  /**
   * The local case is the one that matters, and it is the one that used to skip.
   * A push to `main` bypasses the required status check, so CI runs *after* the
   * decision to push has been made on a local exit code.
   */
  it('throws off CI too, which is the half that decides whether anyone pushes', () => {
    expect(() => databaseTestTarget({ CI: 'false' })).toThrow(/cannot run/)
    expect(() => databaseTestTarget({ CI: 'true' })).toThrow(/cannot run/)
  })

  /**
   * The message has to carry the way out, or the throw is a wall. Both halves:
   * how to get a database, and what to run when the change genuinely needs none.
   */
  it('says how to fix it and what to run instead', () => {
    try {
      databaseTestTarget({})
      expect.unreachable('it should have thrown')
    } catch (error) {
      const message = (error as Error).message
      expect(message).toContain(DATABASE_URL_VAR)
      // Both routes, because the reader either has a server or does not (`#283`).
      // This asserted the image name `postgres:16` until 2026-08-04, when the
      // message stopped carrying a command to paste and started pointing at one
      // to run — a container image is a tool, and the way out should not stop
      // working for somebody whose PostgreSQL 16 came from anywhere else.
      expect(message).toContain('test:db:up')
      expect(message).toContain('test:db:relax')
      expect(message).toContain('check:fast')
    }
  })

  /**
   * No opt-out, asserted rather than trusted. A variable that silences a safety
   * check ends up in a shell profile and is then permanent and invisible — this
   * defect again, with one more step in front of it. If somebody adds one, this
   * is where the argument has to be reopened.
   */
  it.each([
    { SKIP_DB_TESTS: '1' },
    { KOLONIE_SKIP_DB_TESTS: 'true' },
    { NO_DB: '1' },
    { VITEST: 'true' },
  ])('cannot be switched off by %s', (env) => {
    expect(() => databaseTestTarget(env)).toThrow(/cannot run/)
  })
})

/**
 * `#284`. Turning `fileParallelism` on is safe only because two files never share
 * a database, and these are the two pure steps that decide which one a file gets.
 *
 * **The property is asserted here rather than left to the suite to demonstrate.**
 * If the derivation is ever wrong, the symptom is not a red test — it is a flake
 * that needs two particular files to interleave on a machine with the cores to
 * run them at once. Checked as arithmetic, it either holds for every slot or it
 * does not.
 */
describe('deriving the database a worker may touch', () => {
  const BASE = 'postgres://postgres:postgres@127.0.0.1:5433/kolonie_test'

  describe('reading the slot', () => {
    it('is the pool id, which is the number bounded by the worker count', () => {
      expect(testWorkerSlot({ VITEST_POOL_ID: '3' })).toBe(3)
    })

    /**
     * Running one file directly, or under a debugger, sets nothing — and that is
     * the first thing anybody does when a test fails, so it must reach a database
     * rather than throw.
     */
    it('falls back to the first slot when nothing says which', () => {
      expect(testWorkerSlot({})).toBe(1)
    })

    it.each(['0', '-1', 'two', '', '1.5'])('refuses %o rather than guessing', (raw) => {
      expect(() => testWorkerSlot({ VITEST_POOL_ID: raw })).toThrow(/slot number/)
    })
  })

  describe('rewriting the URL', () => {
    it('puts the slot in the database name and changes nothing else', () => {
      expect(workerDatabaseUrl(BASE, 4)).toBe(
        'postgres://postgres:postgres@127.0.0.1:5433/kolonie_test_w4',
      )
    })

    it('keeps connection parameters, which is where TLS settings live', () => {
      const derived = workerDatabaseUrl(`${BASE}?sslmode=require`, 2)

      expect(derived).toContain('sslmode=require')
      expect(derived).toContain('kolonie_test_w2')
    })

    /**
     * The rejection case. Without it the derivation yields `/_w1` — a
     * plausible-looking name for a database nobody meant, created on whatever
     * server the caller pointed at.
     */
    it('refuses a URL that names no database', () => {
      expect(() => workerDatabaseUrl('postgres://postgres:postgres@127.0.0.1:5433', 1)).toThrow(
        /names no database/,
      )
    })

    it.each([0, -1, 1.5, Number.NaN])('refuses %o as a slot, before naming anything', (slot) => {
      expect(() => workerDatabaseUrl(BASE, slot)).toThrow(/not a worker slot/)
    })

    it('gives every slot a database of its own, which is the whole safety argument', () => {
      const derived = Array.from({ length: 12 }, (_, index) => workerDatabaseUrl(BASE, index + 1))

      expect(new Set(derived).size).toBe(derived.length)
    })
  })
})
