import { describe, expect, it } from 'vitest'
import { LAMPORTS_PER_SOL } from './payments.js'
import { ceilingsRefusal, payoutRefusal, payoutRefusalRaises } from './payout.js'

const CEILINGS = { perTransaction: LAMPORTS_PER_SOL, perDay: LAMPORTS_PER_SOL * 10 }

const asked = (overrides: Partial<Parameters<typeof payoutRefusal>[0]> = {}) =>
  payoutRefusal({
    lamports: LAMPORTS_PER_SOL / 100,
    ceilings: CEILINGS,
    paidToday: 0,
    availableFloat: LAMPORTS_PER_SOL * 100,
    chainMinimum: 890_880,
    recipientFunded: true,
    ...overrides,
  })

/**
 * D-106 (`#505`). Rescued from `#222`: limits exist before the first payout,
 * not after it.
 */
describe('whether a payout may go out', () => {
  it('goes out when nothing is in its way', () => {
    expect(asked()).toBeUndefined()
  })

  /** Refused and raised, not paid and apologised for. */
  it('refuses a single payout above the per-transaction ceiling', () => {
    expect(asked({ lamports: LAMPORTS_PER_SOL * 2 })).toBe('above-transaction-ceiling')
  })

  /** Reaching it stops payments and raises; it does not silently queue. */
  it('refuses once the day total would pass the daily ceiling', () => {
    expect(asked({ paidToday: LAMPORTS_PER_SOL * 10 })).toBe('above-daily-ceiling')
    expect(asked({ paidToday: LAMPORTS_PER_SOL * 9 })).toBeUndefined()
  })

  /** The Colony failing to pay, not a citizen failing to be payable. */
  it('refuses when the float cannot cover it', () => {
    expect(asked({ availableFloat: 1 })).toBe('float-exhausted')
  })

  /**
   * Physics rather than a threshold policy: an address with no account cannot
   * receive less than the rent-exempt minimum.
   */
  it('accrues below the chain minimum only for an address that has never held SOL', () => {
    expect(asked({ lamports: 1000, recipientFunded: false })).toBe('accruing-below-chain-minimum')
    expect(asked({ lamports: 1000, recipientFunded: true })).toBeUndefined()
    expect(asked({ lamports: 890_880, recipientFunded: false })).toBeUndefined()
  })

  /** A ceiling breach is a fault somebody looks at; the minimum resolves by waiting. */
  it('checks a ceiling before anything that merely delays', () => {
    expect(asked({ lamports: LAMPORTS_PER_SOL * 2, availableFloat: 1 })).toBe(
      'above-transaction-ceiling',
    )
  })

  it('says which refusals somebody has to be told about', () => {
    expect(payoutRefusalRaises('above-transaction-ceiling')).toBe(true)
    expect(payoutRefusalRaises('above-daily-ceiling')).toBe(true)
    expect(payoutRefusalRaises('float-exhausted')).toBe(true)
    expect(payoutRefusalRaises('accruing-below-chain-minimum')).toBe(false)
    expect(payoutRefusalRaises('unavailable')).toBe(false)
  })
})

/** The process refuses to start without both, and that is the point. */
describe('the ceilings themselves', () => {
  it('accepts two positive whole numbers', () => {
    expect(ceilingsRefusal({ perTransaction: 1, perDay: 2 })).toBeUndefined()
  })

  it('names whichever is missing, and says why a default would not do', () => {
    const both = ceilingsRefusal({ perTransaction: undefined, perDay: undefined }) as string
    expect(both).toContain('PAYOUT_MAX_LAMPORTS')
    expect(both).toContain('PAYOUT_DAILY_MAX_LAMPORTS')
    expect(both).toContain('not a ceiling')

    expect(ceilingsRefusal({ perTransaction: 1, perDay: undefined })).toContain(
      'PAYOUT_DAILY_MAX_LAMPORTS',
    )
  })

  it('refuses zero and a fraction, which are ceilings in name only', () => {
    expect(ceilingsRefusal({ perTransaction: 0, perDay: 1 })).toContain('positive')
    expect(ceilingsRefusal({ perTransaction: 1.5, perDay: 1 })).toContain('positive')
  })
})
