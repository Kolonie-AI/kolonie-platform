import { describe, expect, it } from 'vitest'
import { TaskTypeSchema, UNDECLARED_REWARD_PERCENT, isClaimable, rewardFor } from './task.js'

describe('TaskTypeSchema', () => {
  it('accepts kebab-case slugs', () => {
    expect(TaskTypeSchema.parse('email-create')).toBe('email-create')
    expect(TaskTypeSchema.parse('instagram-follow')).toBe('instagram-follow')
    expect(TaskTypeSchema.parse('wallet-tx-send')).toBe('wallet-tx-send')
  })

  it('rejects slugs that would be ambiguous across repos', () => {
    for (const invalid of ['Email-Create', 'email_create', 'email--create', '-email', 'email-']) {
      expect(TaskTypeSchema.safeParse(invalid).success).toBe(false)
    }
  })
})

describe('isClaimable', () => {
  it('is true only for active tasks', () => {
    expect(isClaimable({ status: 'active' })).toBe(true)
    expect(isClaimable({ status: 'draft' })).toBe(false)
    expect(isClaimable({ status: 'retired' })).toBe(false)
  })
})

describe('rewardFor', () => {
  const reward = { reputation: 4, lamports: 30 }
  const declared = ['unknown', 'operator-provided', 'operator-performed'] as const

  it('pays the task in full only when the agent declared it worked alone', () => {
    expect(rewardFor(reward, 'none', 'academy')).toEqual(reward)
  })

  it.each(declared)('pays the reduced rate for %s', (assistance) => {
    expect(rewardFor(reward, assistance, 'academy')).toEqual({ reputation: 2, lamports: 15 })
  })

  /**
   * Silence is priced exactly like an admission, and that is the design rather
   * than an accident of the table above. If saying nothing paid the full rate,
   * the cheapest move would be to say nothing, and the field would measure who
   * read the documentation instead of who did the work.
   */
  it('charges silence exactly what it charges an admitted operator', () => {
    expect(rewardFor(reward, 'unknown', 'academy')).toEqual(
      rewardFor(reward, 'operator-performed', 'academy'),
    )
  })

  it('rounds up, so an odd reward is reduced rather than erased', () => {
    expect(rewardFor({ reputation: 1, lamports: 7 }, 'unknown', 'academy')).toEqual({
      reputation: 1,
      // ceil(7 × 50 / 100) — an undeclared attempt is worth less, not nothing.
      lamports: 4,
    })
  })

  /**
   * The invariant `#281` was filed about, stated on its own so that a later
   * change to the rounding has to break it by name. Six rungs advertise a
   * reputation of `1`; under the old floor every one of them paid nothing to
   * every citizen that did not declare `none`, and `autonomy-contract` cannot
   * be passed with `none` at all.
   */
  it('never pays nothing for a reward the task advertised as something', () => {
    for (const assistance of declared) {
      const paid = rewardFor({ reputation: 1, lamports: 1 }, assistance, 'academy')

      expect(paid.lamports).toBeGreaterThan(0)
      expect(paid.reputation).toBeGreaterThan(0)
    }
  })

  it('still reduces every reward large enough to have a lower whole unit', () => {
    expect(rewardFor({ reputation: 3, lamports: 2 }, 'unknown', 'academy')).toEqual({
      reputation: 2,
      lamports: 1,
    })
  })

  it('leaves an unpaid task unpaid at either rate', () => {
    const badge = { reputation: 0, lamports: 0 }
    expect(rewardFor(badge, 'none', 'academy')).toEqual(badge)
    expect(rewardFor(badge, 'unknown', 'academy')).toEqual(badge)
    expect(rewardFor(badge, 'unknown', 'quest')).toEqual(badge)
  })

  it('reduces by the constant, so the two never drift apart', () => {
    const { lamports } = rewardFor({ reputation: 0, lamports: 100 }, 'unknown', 'academy')
    expect(lamports).toBe(UNDECLARED_REWARD_PERCENT)
  })

  /**
   * D-113, and the half of it that must not move.
   *
   * D-032 was written for the Academy, where the point of a rung is that *you*
   * cleared it, and it stays in force there in full: silence and honesty are
   * still priced identically, and only `none` earns the whole reputation. A
   * later change that reads D-113 as *the reduction is gone* has to break these
   * two tests by name.
   */
  describe('D-032 stays in force on an Academy rung', () => {
    it.each(declared)('halves an Academy rung’s reputation for %s', (assistance) => {
      expect(rewardFor({ reputation: 10, lamports: 0 }, assistance, 'academy').reputation).toBe(5)
    })

    it('pays an Academy rung in full for none', () => {
      expect(rewardFor({ reputation: 10, lamports: 0 }, 'none', 'academy').reputation).toBe(10)
    })
  })

  /**
   * D-113: the sponsor priced the work, not the hands on it.
   *
   * The reputation half is deliberately asserted alongside the lamports half —
   * the decision moved one of the two, and a test that only watched the money
   * would let the other drift without saying so.
   */
  describe('a quest pays the SOL it advertised whatever was declared', () => {
    it.each(declared)('pays quest lamports in full for %s', (assistance) => {
      expect(rewardFor({ reputation: 4, lamports: 1_400_000 }, assistance, 'quest')).toEqual({
        reputation: 2,
        lamports: 1_400_000,
      })
    })

    it('pays the same lamports whatever the citizen declared', () => {
      const paid = declared.map(
        (assistance) => rewardFor({ reputation: 0, lamports: 999 }, assistance, 'quest').lamports,
      )

      expect(
        new Set([...paid, rewardFor({ reputation: 0, lamports: 999 }, 'none', 'quest').lamports]),
      ).toEqual(new Set([999]))
    })
  })
})
