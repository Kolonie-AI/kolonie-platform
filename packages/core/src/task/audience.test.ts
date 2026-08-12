import { describe, expect, it } from 'vitest'
import {
  AUDIENCE_FLOOR,
  AudienceQueryStringSchema,
  audienceFragment,
  audienceSentence,
  questCapacityRejection,
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
    ).toContain(
      'With browser, mailbox required, 6 citizens may attempt this quest, against 40 citizens with no requirement.',
    )
  })

  it('says what is reachable when nothing is required, rather than saying nothing', () => {
    expect(
      audienceSentence({
        reach: reportAudience(40),
        unrestricted: reportAudience(40),
        requires: [],
      }),
    ).toContain(
      'You have required no skills, so anyone this quest is offered to may attempt — 40 citizens today.',
    )
  })

  it('states that a proof verifier is checked after the reach is counted', () => {
    const said = audienceSentence({
      reach: reportAudience(6),
      unrestricted: reportAudience(40),
      requires: ['browser'],
      proofVerifier: 'email-inbox',
    })

    expect(said).toContain('The `proofVerifier` is not included in this reach')
    expect(said).toContain('`email-inbox` is checked when an answer is handed in')
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
    ).toContain(
      'With solana-wallet required, no citizen may attempt this quest, against 40 citizens with no requirement.',
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

/**
 * A sponsor is told that its capacity exceeds its reach, and never by how much —
 * D-116 (`#754`).
 */
describe('buying more answers than there are citizens', () => {
  it('refuses capacity above the reach', () => {
    expect(questCapacityRejection({ slots: 3, reach: 2 })).toBeDefined()
  })

  it('takes capacity at the reach and below it', () => {
    expect(questCapacityRejection({ slots: 2, reach: 2 })).toBeUndefined()
    expect(questCapacityRejection({ slots: 1, reach: 2 })).toBeUndefined()
  })

  /**
   * **The whole point of the refusal, and the assertion that has to survive any
   * rewording of it.** The sponsor learns one inequality about a number it chose
   * itself; the count, the shortfall and anything that narrows either are what
   * `AUDIENCE_FLOOR` exists to keep out, and a refusal that leaked them would
   * defeat the floor rather than complement it.
   */
  it('names neither the reach nor the shortfall, at any reach', () => {
    for (const reach of [1, 2, 3, 4]) {
      const said = questCapacityRejection({ slots: 9, reach })

      // The capacity, which the sponsor chose and already knows.
      expect(said).toContain('9 answers')
      expect(said).not.toContain(String(reach))
      expect(said).not.toContain(String(9 - reach))
    }
  })

  /**
   * **A reach of zero is the one case where the shortfall equals the capacity**,
   * so *the difference is not printed* cannot be asserted by looking for the
   * digit — it is the same digit the sponsor typed. It is not a leak for the
   * same reason: `9 - 0` tells a reader nothing it did not supply. What has to
   * hold is that the sentence is the same one, with no extra clause about
   * nobody being able to answer, because *no citizen at all* is a far sharper
   * fact than *fewer than nine*.
   */
  it('says the same thing at a reach of zero, and no more', () => {
    expect(questCapacityRejection({ slots: 9, reach: 0 })).toBe(
      questCapacityRejection({ slots: 9, reach: 4 }),
    )
  })

  /**
   * A quest nobody can answer is refused by the same rule rather than by a
   * special case — one slot against a reach of zero is capacity above the reach.
   */
  it('refuses a quest with a reach of nobody', () => {
    expect(questCapacityRejection({ slots: 1, reach: 0 })).toBeDefined()
  })

  /** The rule is on every draft, so the sponsor meets it before it is refused. */
  it('is stated on a draft before submission, without the comparison', () => {
    const said = audienceSentence({
      reach: reportAudience(40),
      unrestricted: reportAudience(40),
      requires: [],
    })

    expect(said).toContain('not returned at expiry')
    expect(said).toContain('is refused')
  })
})
