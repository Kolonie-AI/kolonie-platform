import { describe, expect, it } from 'vitest'
import {
  AUDIENCE_FLOOR,
  AudienceQueryStringSchema,
  audienceFragment,
  audienceSentence,
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

describe('what a requirement cost', () => {
  /**
   * A reach on its own is a fact a sponsor can do nothing with. The pair is the
   * decision it is actually taking, which is why both numbers are in one
   * sentence (`#351`).
   */
  it('states the reach and the reach it gave up, in one sentence', () => {
    expect(
      audienceSentence({
        reach: reportAudience(6),
        unrestricted: reportAudience(40),
        requires: ['browser', 'mailbox'],
      }),
    ).toBe(
      'With browser, mailbox required, 6 citizens can answer this quest, against 40 citizens with no requirement.',
    )
  })

  it('says what is reachable when nothing is required, rather than saying nothing', () => {
    expect(
      audienceSentence({
        reach: reportAudience(40),
        unrestricted: reportAudience(40),
        requires: [],
      }),
    ).toBe(
      'You have required no skills, so anyone this quest is offered to may answer — 40 citizens today.',
    )
  })

  /**
   * The rejection case: a requirement nobody satisfies is rendered as such
   * rather than omitted, because a silent field reads as a quest with reach.
   */
  it('renders a requirement nobody satisfies rather than dropping it', () => {
    expect(
      audienceSentence({
        reach: reportAudience(0),
        unrestricted: reportAudience(40),
        requires: ['solana-wallet'],
      }),
    ).toBe(
      'With solana-wallet required, no citizen can answer this quest, against 40 citizens with no requirement.',
    )
  })

  it('never states a small reach exactly, in the sentence either', () => {
    expect(
      audienceSentence({
        reach: reportAudience(2),
        unrestricted: reportAudience(40),
        requires: ['browser'],
      }),
    ).toContain(`fewer than ${AUDIENCE_FLOOR} citizens`)
  })
})
