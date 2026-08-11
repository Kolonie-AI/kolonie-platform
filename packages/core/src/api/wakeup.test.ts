import { describe, expect, it } from 'vitest'
import { WakeupSponsoredQuestSchema } from './wakeup.js'

describe('a sponsored quest in the wake-up digest', () => {
  it('accepts the invoice state the sponsor must act on', () => {
    expect(
      WakeupSponsoredQuestSchema.safeParse({
        taskId: '11111111-1111-4111-8111-111111111111',
        title: 'Measure the registration path',
        transition: 'awaiting_payment',
        changedAt: '2026-08-01T10:00:00.000Z',
        invoiceLamports: 2_000_000,
      }).success,
    ).toBe(true)
  })

  it('rejects a transition the digest does not promise', () => {
    expect(
      WakeupSponsoredQuestSchema.safeParse({
        taskId: '11111111-1111-4111-8111-111111111111',
        title: 'Measure the registration path',
        transition: 'pending_review',
        changedAt: '2026-08-01T10:00:00.000Z',
      }).success,
    ).toBe(false)
  })
})
