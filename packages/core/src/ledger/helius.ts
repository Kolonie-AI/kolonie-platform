import { z } from 'zod'

/**
 * What Helius actually sends, and what the Colony is willing to read from it
 * (`#321`).
 *
 * `#219` built the receiving side against a shape designed from what the credit
 * needs — `signature`, `address`, `mint`, `tokenProgram`, `baseUnits`,
 * `commitment` — and no observer emits it. An enhanced Helius webhook delivers
 * an array of transactions carrying `nativeTransfers[]`, and **neither the
 * enhanced nor the raw form carries a token program or a commitment at all**.
 * So the endpoint answered `422` to every delivery a real sender could make.
 *
 * **The translation here is deliberately lossy, and that is the point.** A
 * delivery is read for two facts only — *which signature* and *which address* —
 * and everything that decides whether money may be credited is re-read from the
 * chain afterwards. The alternative was to trust `tokenAmount` and invent the
 * two missing fields, which would make a webhook body the source of a balance.
 *
 * A consequence worth stating, because it is the security property: **a forged
 * delivery cannot credit anything.** The worst it can do is make the Colony
 * re-read a signature that says nothing, which the reconciliation does hourly
 * anyway.
 */

/**
 * One entry of `nativeTransfers`, as far as this file cares — D-106 (`#503`).
 *
 * SOL rather than a token, which is what a sponsor now pays in. `amount` is
 * ignored for the same reason `tokenAmount` is: the delivery is a trigger and
 * the chain is the source, and an amount read off a webhook body is an amount
 * whoever holds the webhook secret chose.
 */
const HeliusNativeTransferSchema = z.looseObject({
  /** The wallet that gained lamports. The Colony's own, when it is one of ours. */
  toUserAccount: z.string().min(1).max(64).optional(),
})

/**
 * One transaction of an enhanced delivery.
 *
 * `looseObject`, because Helius adds fields to this payload and a strict schema
 * would turn *the sender improved its product* into *no deposit is ever
 * credited promptly again*. The fields that are read are pinned; the rest may
 * come and go.
 */
const HeliusTransactionSchema = z.looseObject({
  signature: z.string().min(1).max(120),
  nativeTransfers: z.array(HeliusNativeTransferSchema).optional(),
})

/**
 * A delivery: Helius posts an array, even for one transaction.
 *
 * Bounded, because this is an unauthenticated-until-the-header-is-checked body
 * on a route that then makes an RPC call per claim. Helius batches at well
 * under this; a body above it is not a Helius delivery.
 */
export const HELIUS_DELIVERY_MAX = 200
export const HeliusDeliverySchema = z.array(HeliusTransactionSchema).max(HELIUS_DELIVERY_MAX)
export type HeliusDelivery = z.infer<typeof HeliusDeliverySchema>

/**
 * A signature and an address, and nothing else.
 *
 * Not an {@link import('./deposits.js').ObservedTransfer} and not on its way to
 * becoming one by having fields added: it is a *claim that something happened
 * there*, which is answered by reading the chain. The two types are separate so
 * that no code path can mistake the first for the second.
 */
export interface TransferClaim {
  readonly signature: string
  readonly address: string
}

/**
 * The SOL claims in one delivery, deduplicated — D-106 (`#503`).
 *
 * **The token half was beside this and is gone** (`#506`). It read
 * `tokenTransfers` for the deposit path, which the Colony no longer has; keeping
 * the two apart is what made removing one a deletion rather than an edit.
 */
export function nativeClaimsInDelivery(delivery: HeliusDelivery): readonly TransferClaim[] {
  const seen = new Set<string>()
  const claims: TransferClaim[] = []

  for (const transaction of delivery) {
    for (const transfer of transaction.nativeTransfers ?? []) {
      const address = transfer.toUserAccount
      if (address === undefined) continue

      const key = `${transaction.signature}\0${address}`
      if (seen.has(key)) continue
      seen.add(key)

      claims.push({ signature: transaction.signature, address })
    }
  }

  return claims
}
