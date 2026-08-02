import { describe, expect, it } from 'vitest'
import { DATABASE_URL_VAR } from './client.js'
import { databaseTestTarget } from './testing.js'

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

  it('uses the variable when it is set', () => {
    expect(databaseTestTarget({ [DATABASE_URL_VAR]: url })).toEqual({ available: true, url })
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
      expect(message).toContain('postgres:16')
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
