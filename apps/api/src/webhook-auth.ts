import { timingSafeEqual } from 'node:crypto'
import type { ApiError } from '@kolonie-ai/core'

/**
 * The shared secret a machine presents to the routes that decide money arrived.
 *
 * **Its own file since `#506`.** It lived in `deposits.ts` because the deposit
 * webhook was the first caller; the deposit module is gone and the guard is not,
 * because the payment webhook, the reconciliation and the payout pass all stand
 * behind it. One power, one secret.
 */

/**
 * Whether this caller may deliver a webhook.
 *
 * Compared in constant time, because a secret compared with `===` leaks its
 * prefix to anybody willing to time the answer — and these are the endpoints
 * that turn *money arrived* into a quest going live.
 */
export function webhookAuthorised(presented: string | undefined, secret: string): boolean {
  if (presented === undefined) return false

  const a = Buffer.from(presented)
  const b = Buffer.from(secret)

  // `timingSafeEqual` throws on a length mismatch, which would itself be a
  // timing signal. The length check is done first and deliberately: it leaks the
  // length of the secret and nothing about its contents.
  return a.length === b.length && timingSafeEqual(a, b)
}

export const WEBHOOK_REFUSED: ApiError = {
  code: 'unauthorized',
  message: 'This endpoint is not for you.',
}
