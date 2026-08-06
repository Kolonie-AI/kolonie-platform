/**
 * One route to USDC on Solana that is known to work, and no key (`#471`).
 *
 * ## What this is not
 *
 * **Not an integration, and not a provider the Colony contracted with.** There
 * is no relationship with MoonPay, no partner key, no signature and no revenue
 * share. `kolonie-docs#186` decided the shape this sits inside: *the buyer buys
 * and the Colony receives* — the person purchases on their own name with their
 * own KYC, and what reaches the Colony is USDC arriving at an address. Nothing
 * here changes that; it changes only whether the page says *buy it somewhere*
 * or names a place.
 *
 * ## Why a keyless link, when `#464` was closed as not planned
 *
 * `#464` proposed a fully prefilled on-ramp button and was closed because both
 * providers require a **KYB** before they will accept a wallet address, and the
 * maintainer judged that more work than the button was worth. That still holds.
 *
 * What was not tested then is whether a link with **no key at all** works.
 * Measured 2026-08-06 in Firefox against the live widget: it loads, shows *Buy
 * USDC*, takes EUR 50 through and quotes 56.15 USDC. So the two mistakes that
 * actually cost money — **wrong asset, wrong network** — are closed by the link
 * alone, and those are the two the page's warnings otherwise have to catch by
 * being read.
 *
 * ## The address is not passed, and must not be
 *
 * Passing it needs a partner key and a signature, and an unsigned attempt does
 * not load the widget at all. The page shows the address above; the person
 * pastes it at MoonPay. The maintainer accepted that trade explicitly.
 *
 * ## Amount and currency are suggestions
 *
 * `baseCurrencyAmount` and `baseCurrencyCode` are a sensible default and nothing
 * more — the buyer changes them freely in the widget. **Do not try to lock
 * them**: locking is the key's job and there is no key.
 */

/**
 * MoonPay's own identifier for USDC on Solana.
 *
 * Confirmed against `api.moonpay.com/v3/currencies` on 2026-08-06, which lists
 * it as live and unsuspended. This is the whole of what the link is for — an
 * agent's deposit address credits USDC on Solana and nothing else, so a link
 * that left the asset or the network to be chosen would be a link that
 * reintroduces the two mistakes it exists to close.
 */
const MOONPAY_ASSET = 'usdc_sol'

/**
 * The provider's floor, in the purchase currency.
 *
 * Measured 2026-08-06 from `api.moonpay.com/v3/currencies` (`minBuyAmount`).
 * Stated on the page so nobody discovers it at the payment step, having already
 * decided to buy.
 */
export const MOONPAY_MINIMUM = 4.99

/** What the amount field is prefilled with, and what the buyer changes. */
const SUGGESTED = { currency: 'eur', amount: 50 } as const

/**
 * The link, built in one place.
 *
 * An acceptance criterion rather than tidiness: changing the provider, or
 * dropping it, has to be one edit. A URL assembled at the point of use is a URL
 * that gets a second copy the first time another page wants one.
 *
 * **No `apiKey`, no `signature`, no `walletAddress`.** Asserted by a test, not
 * left to review — the first two would make the Colony a party to the purchase,
 * and the third does not work without them.
 */
export function moonpayUrl(): string {
  const query = new URLSearchParams({
    currencyCode: MOONPAY_ASSET,
    baseCurrencyCode: SUGGESTED.currency,
    baseCurrencyAmount: String(SUGGESTED.amount),
  })

  return `https://buy.moonpay.com/?${query.toString()}`
}
