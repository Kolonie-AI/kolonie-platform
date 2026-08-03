import { describe, expect, it } from 'vitest'
import {
  QUEST_AUDIT_DEFAULT_RATE,
  QUEST_AUDIT_OFF,
  isAuditable,
  isAudited,
  nonWithdrawableNotice,
  paidQuestRejection,
  questAuditDraw,
} from './quest-audit.js'

const anId = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

/**
 * The audit that has to exist before a quest pays a coin (`#221`).
 *
 * The first describe is the load-bearing one: everything else here is the
 * mechanism the refusal protects.
 */
describe('publishing a paid quest', () => {
  it('is refused while sampling is off, and says what is missing', () => {
    const refusal = paidQuestRejection(QUEST_AUDIT_OFF, { credits: 10, disagreement: 0 })

    expect(refusal).toContain('sampling audit')
    expect(refusal).toContain('governance/quests.md')
  })

  it('leaves a zero-reward quest alone, which is the whole pilot', () => {
    expect(paidQuestRejection(QUEST_AUDIT_OFF, { credits: 0, disagreement: 0.9 })).toBeUndefined()
  })

  it('is allowed once sampling is on and the judge is holding up', () => {
    const on = { ...QUEST_AUDIT_OFF, enabled: true }

    expect(paidQuestRejection(on, { credits: 10, disagreement: 0.1 })).toBeUndefined()
  })

  it('is refused again above the threshold, with the current rate named', () => {
    const on = { ...QUEST_AUDIT_OFF, enabled: true }

    const refusal = paidQuestRejection(on, { credits: 10, disagreement: 0.34 })

    expect(refusal).toContain('34%')
    expect(refusal).toContain('20%')
  })
})

describe('the draw', () => {
  it('is the same answer every time, for the same submission', () => {
    const id = anId(1)

    expect(questAuditDraw(id)).toBe(questAuditDraw(id))
    expect(isAudited(id, 0.1)).toBe(isAudited(id, 0.1))
  })

  it('lands inside the unit interval for everything it is given', () => {
    for (let index = 0; index < 500; index++) {
      const draw = questAuditDraw(anId(index))
      expect(draw).toBeGreaterThanOrEqual(0)
      expect(draw).toBeLessThan(1)
    }
  })

  /**
   * The rate is what it says it is. A tolerance rather than an equality, because
   * a hash is uniform and not fair — and a test that demanded exactly one in ten
   * would be testing the sample rather than the mechanism.
   */
  it('draws about a tenth over a large set', () => {
    const ids = Array.from({ length: 5000 }, (_, index) => anId(index))
    const drawn = ids.filter((id) => isAudited(id, QUEST_AUDIT_DEFAULT_RATE)).length

    expect(drawn / ids.length).toBeGreaterThan(0.08)
    expect(drawn / ids.length).toBeLessThan(0.12)
  })

  /**
   * Raising the rate adds submissions to the sample and removes none, which is
   * what makes the threshold policy rather than a property frozen into the rows.
   */
  it('is monotonic in the rate', () => {
    const ids = Array.from({ length: 500 }, (_, index) => anId(index))
    const atTenth = ids.filter((id) => isAudited(id, 0.1))
    const atFifth = ids.filter((id) => isAudited(id, 0.2))

    for (const id of atTenth) expect(atFifth).toContain(id)
  })

  it('samples the tiers a model decided, and never the one a third party did', () => {
    expect(isAuditable('colony-judged')).toBe(true)
    expect(isAuditable('soft')).toBe(true)
    // Re-reading a mailbox round trip tells nobody anything.
    expect(isAuditable('hard')).toBe(false)
  })
})

describe('the notice a paid quest carries', () => {
  it('says credits cannot be withdrawn yet', () => {
    expect(nonWithdrawableNotice({ credits: 1 })).toContain('cannot yet be withdrawn')
  })

  it('is absent from a quest that pays no credits', () => {
    expect(nonWithdrawableNotice({ credits: 0 })).toBeUndefined()
  })
})
