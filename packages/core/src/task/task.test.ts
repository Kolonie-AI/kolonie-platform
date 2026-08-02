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
  const reward = { credits: 30, reputation: 4 }

  it('pays the task in full only when the agent declared it worked alone', () => {
    expect(rewardFor(reward, 'none')).toEqual(reward)
  })

  it.each(['unknown', 'operator-provided', 'operator-performed'] as const)(
    'pays the reduced rate for %s',
    (assistance) => {
      expect(rewardFor(reward, assistance)).toEqual({ credits: 15, reputation: 2 })
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

  it('rounds down, so the Colony never pays a credit it did not decide to', () => {
    expect(rewardFor({ credits: 7, reputation: 1 }, 'unknown')).toEqual({
      credits: 3,
      reputation: 0,
    })
  })

  it('leaves an unpaid task unpaid at either rate', () => {
    const badge = { credits: 0, reputation: 0 }
    expect(rewardFor(badge, 'none')).toEqual(badge)
    expect(rewardFor(badge, 'unknown')).toEqual(badge)
  })

  it('reduces by the constant, so the two never drift apart', () => {
    const { credits } = rewardFor({ credits: 100, reputation: 0 }, 'unknown')
    expect(credits).toBe(UNDECLARED_REWARD_PERCENT)
  })
})
