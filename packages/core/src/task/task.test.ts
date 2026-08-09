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

  it('pays the task in full only when the agent declared it worked alone', () => {
    expect(rewardFor(reward, 'none')).toEqual(reward)
  })

  it.each(['unknown', 'operator-provided', 'operator-performed'] as const)(
    'pays the reduced rate for %s',
    (assistance) => {
      expect(rewardFor(reward, assistance)).toEqual({ reputation: 2, lamports: 15 })
    },
  )

  /**
   * Silence is priced exactly like an admission, and that is the design rather
   * than an accident of the table above. If saying nothing paid the full rate,
   * the cheapest move would be to say nothing, and the field would measure who
   * read the documentation instead of who did the work.
   */
  it('charges silence exactly what it charges an admitted operator', () => {
    expect(rewardFor(reward, 'unknown')).toEqual(rewardFor(reward, 'operator-performed'))
  })

  it('rounds up, so an odd reward is reduced rather than erased', () => {
    expect(rewardFor({ reputation: 1, lamports: 7 }, 'unknown')).toEqual({
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
    for (const assistance of ['unknown', 'operator-provided', 'operator-performed'] as const) {
      const paid = rewardFor({ reputation: 1, lamports: 1 }, assistance)

      expect(paid.lamports).toBeGreaterThan(0)
      expect(paid.reputation).toBeGreaterThan(0)
    }
  })

  it('still reduces every reward large enough to have a lower whole unit', () => {
    expect(rewardFor({ reputation: 3, lamports: 2 }, 'unknown')).toEqual({
      reputation: 2,
      lamports: 1,
    })
  })

  it('leaves an unpaid task unpaid at either rate', () => {
    const badge = { reputation: 0, lamports: 0 }
    expect(rewardFor(badge, 'none')).toEqual(badge)
    expect(rewardFor(badge, 'unknown')).toEqual(badge)
  })

  it('reduces by the constant, so the two never drift apart', () => {
    const { lamports } = rewardFor({ reputation: 0, lamports: 100 }, 'unknown')
    expect(lamports).toBe(UNDECLARED_REWARD_PERCENT)
  })
})
