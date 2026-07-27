import { describe, expect, it } from 'vitest'
import { DATABASE_URL_VAR } from './client.js'
import { databaseTestTarget } from './testing.js'

/**
 * These need no database — they are about what happens when there isn't one.
 *
 * D-009 turns on this asymmetry, so it is asserted rather than assumed: a silent
 * skip on CI would mean the database tests stop running and nothing ever says
 * so, which is the failure the whole arrangement exists to prevent.
 */
describe('databaseTestTarget', () => {
  const url = 'postgres://user:pw@example.invalid:5432/db'

  it('uses the variable when it is set', () => {
    expect(databaseTestTarget({ [DATABASE_URL_VAR]: url })).toEqual({ available: true, url })
  })

  it('throws on CI when the variable is missing', () => {
    expect(() => databaseTestTarget({ CI: 'true' })).toThrow(/must never be skipped/)
  })

  it('throws on CI when the variable is empty', () => {
    expect(() => databaseTestTarget({ CI: 'true', [DATABASE_URL_VAR]: '   ' })).toThrow(
      /must never be skipped/,
    )
  })

  it('skips locally, and says how to stop skipping', () => {
    const target = databaseTestTarget({})
    expect(target.available).toBe(false)
    if (target.available) return

    // A skip that does not teach is a skip that becomes permanent.
    expect(target.reason).toContain(DATABASE_URL_VAR)
    expect(target.reason).toContain('postgres:16')
  })

  it('does not treat an unrelated CI value as a CI runner', () => {
    expect(databaseTestTarget({ CI: 'false' }).available).toBe(false)
  })
})
