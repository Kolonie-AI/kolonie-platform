import { describe, expect, it } from 'vitest'
import {
  BASE_UNITS_PER_CREDIT,
  SPL_TOKEN_PROGRAM,
  USDC_MINT,
  creditsFromUsdc,
  depositRejection,
  type ObservedTransfer,
} from './deposits.js'

const aTransfer = (overrides: Partial<ObservedTransfer> = {}): ObservedTransfer => ({
  signature: 'a-signature',
  address: 'an-address',
  mint: USDC_MINT,
  tokenProgram: SPL_TOKEN_PROGRAM,
  baseUnits: 1_000_000,
  commitment: 'finalized',
  ...overrides,
})

describe('what a deposit is worth', () => {
  it('is one credit per cent, and USDC carries six decimals', () => {
    expect(BASE_UNITS_PER_CREDIT).toBe(10_000)
    expect(creditsFromUsdc(1_000_000)).toEqual({ credits: 100, remainder: 0 })
  })

  /** Rounding up would mint credits from nothing. */
  it('floors, and keeps the remainder rather than discarding it', () => {
    expect(creditsFromUsdc(19_999)).toEqual({ credits: 1, remainder: 9_999 })
    expect(creditsFromUsdc(9_999)).toEqual({ credits: 0, remainder: 9_999 })
  })

  it('always adds back up to what arrived', () => {
    for (const baseUnits of [0, 1, 9_999, 10_000, 123_456, 5_000_005]) {
      const { credits, remainder } = creditsFromUsdc(baseUnits)
      expect(credits * BASE_UNITS_PER_CREDIT + remainder).toBe(baseUnits)
    }
  })
})

describe('what may be credited', () => {
  it('accepts a finalized USDC transfer of at least a cent', () => {
    expect(depositRejection(aTransfer())).toBeUndefined()
  })

  it.each([
    ['not finalized', { commitment: 'confirmed' }, 'not-final'],
    ['another mint', { mint: 'somethingelse' }, 'wrong-mint'],
    ['another token program', { tokenProgram: 'somethingelse' }, 'wrong-token-program'],
    ['under a cent', { baseUnits: 42 }, 'below-one-cent'],
  ])('refuses one that is %s', (_name, overrides, expected) => {
    expect(depositRejection(aTransfer(overrides))).toBe(expected)
  })

  /**
   * The commitment is checked first and deliberately: a transfer that can still
   * disappear is not a transfer to have an opinion about yet, whatever its mint.
   */
  it('checks the commitment before anything else', () => {
    expect(depositRejection(aTransfer({ commitment: 'confirmed', mint: 'wrong' }))).toBe(
      'not-final',
    )
  })
})
