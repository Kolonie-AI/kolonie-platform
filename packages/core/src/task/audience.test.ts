import { describe, expect, it } from 'vitest'
import {
  AUDIENCE_FLOOR,
  AudienceQueryStringSchema,
  audienceFragment,
  reportAudience,
} from './audience.js'

describe('what a sponsor is told about reach', () => {
  it('states a count at or above the floor exactly', () => {
    expect(reportAudience(AUDIENCE_FLOOR)).toEqual({ kind: 'exact', citizens: AUDIENCE_FLOOR })
    expect(reportAudience(40)).toEqual({ kind: 'exact', citizens: 40 })
  })

  /**
   * The whole point of the floor: a sponsor must not be able to bisect its way
   * to a requirement set that describes one citizen.
   */
  it('suppresses every count between one and the floor, and says which floor', () => {
    for (let count = 1; count < AUDIENCE_FLOOR; count += 1) {
      expect(reportAudience(count)).toEqual({ kind: 'fewer-than', citizens: AUDIENCE_FLOOR })
    }
  })

  /**
   * Zero names nobody — it is a statement about the empty set — and it is the
   * answer a sponsor most needs before it funds a quest nobody can take.
   */
  it('states zero, which is the one small answer that identifies no one', () => {
    expect(reportAudience(0)).toEqual({ kind: 'exact', citizens: 0 })
  })

  it('reads as a fragment a sentence can be built around', () => {
    expect(audienceFragment(reportAudience(0))).toBe('no citizen')
    expect(audienceFragment(reportAudience(2))).toBe(`fewer than ${AUDIENCE_FLOOR} citizens`)
    expect(audienceFragment(reportAudience(12))).toBe('12 citizens')
    expect(audienceFragment({ kind: 'exact', citizens: 1 })).toBe('1 citizen')
  })
})

describe('what may be asked', () => {
  it('defaults to the population a quest reaches when nothing is stated', () => {
    expect(AudienceQueryStringSchema.parse({})).toEqual({
      audience: 'citizens',
      requires: [],
      minReputation: 0,
      minActivityDays: null,
    })
  })

  it('reads a comma-separated requirement set out of a query string', () => {
    expect(
      AudienceQueryStringSchema.parse({
        requires: 'browser, mailbox',
        minReputation: '10',
        minActivityDays: '7',
        audience: 'candidates',
      }),
    ).toEqual({
      audience: 'candidates',
      requires: ['browser', 'mailbox'],
      minReputation: 10,
      minActivityDays: 7,
    })
  })

  it('refuses a skill that is not a slug, rather than counting a set nobody has', () => {
    expect(AudienceQueryStringSchema.safeParse({ requires: 'Browser Skill' }).success).toBe(false)
    expect(AudienceQueryStringSchema.safeParse({ minActivityDays: '3' }).success).toBe(false)
    expect(AudienceQueryStringSchema.safeParse({ audience: 'everybody' }).success).toBe(false)
  })
})
