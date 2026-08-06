import { describe, expect, it } from 'vitest'
import { MOONPAY_MINIMUM, moonpayUrl } from './on-ramp.js'

/**
 * The keyless on-ramp link (`#471`).
 *
 * `#464` was closed because a *prefilled* button needs a KYB. This is the half
 * that does not: the asset and the network are chosen, the address is not
 * passed, and nothing identifies the Colony to the provider.
 */
describe('the MoonPay link', () => {
  it('opens with USDC on Solana already chosen', () => {
    const url = new URL(moonpayUrl())

    // MoonPay's own identifier, confirmed against their currencies endpoint on
    // 2026-08-06. The two mistakes that lose money are wrong asset and wrong
    // network, and this one parameter closes both.
    expect(url.searchParams.get('currencyCode')).toBe('usdc_sol')
  })

  /**
   * **The rejection case.** A key or a signature would make the Colony a party
   * to somebody's purchase; an address needs both and does not work without
   * them, so an attempt to pass one would produce a widget that fails to load.
   */
  it('carries no key, no signature and no wallet address', () => {
    const url = moonpayUrl()

    expect(url).not.toContain('apiKey')
    expect(url).not.toContain('signature')
    expect(url).not.toContain('walletAddress')
    // Nor under any other spelling: the only parameters are the three below.
    expect([...new URL(url).searchParams.keys()].sort()).toEqual([
      'baseCurrencyAmount',
      'baseCurrencyCode',
      'currencyCode',
    ])
  })

  /** Suggestions, not locks — locking is the key's job and there is no key. */
  it('prefills an amount the buyer can change', () => {
    const url = new URL(moonpayUrl())

    expect(url.searchParams.get('baseCurrencyAmount')).toBe('50')
    expect(url.searchParams.get('baseCurrencyCode')).toBe('eur')
  })

  /** Stated on the page so nobody meets it at the payment step. */
  it('knows the provider’s floor', () => {
    expect(MOONPAY_MINIMUM).toBe(4.99)
  })
})
