import { describe, expect, it } from 'vitest'
import { TimestampSchema, toTimestamp } from './time.js'

describe('toTimestamp', () => {
  it.each([
    ['a Date object', new Date('2026-09-13T20:11:36.901Z')],
    ['a UTC offset string', '2026-09-13T20:11:36.901+00:00'],
    ['a two-digit UTC offset string', '2026-09-13T20:11:36.901+00'],
    ['a compact four-digit UTC offset string', '2026-09-13T20:11:36.901+0000'],
    ['a Postgres offset rendering', '2026-09-13 20:11:36.901+00'],
    ['a string missing its timezone', '2026-09-13T20:11:36.901'],
    ['a canonical ISO UTC string', '2026-09-13T20:11:36.901Z'],
  ])('normalises %s to what TimestampSchema accepts', (_case, value) => {
    const normalised = toTimestamp(value)
    expect(TimestampSchema.safeParse(normalised).success).toBe(true)
    expect(normalised).toBe('2026-09-13T20:11:36.901Z')
  })

  it('returns an unparseable value unchanged rather than throwing', () => {
    expect(toTimestamp('not-a-datetime')).toBe('not-a-datetime')
    expect(TimestampSchema.safeParse(toTimestamp('not-a-datetime')).success).toBe(false)
  })
})
