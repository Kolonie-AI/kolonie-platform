/**
 * The chain, as the payout runner needs it — D-106 (`#505`).
 *
 * Four reads and one write, over Solana's JSON-RPC. It is a separate file from
 * `payment-watcher.ts` for the reason that reader is separate from the deposit
 * one: this is the half that *sends*, and the half that sends should be
 * reviewable on its own.
 */

import { RENT_EXEMPT_MINIMUM_FALLBACK } from '@kolonie-ai/core'
import type { PayoutChain } from './payouts.js'

/** The environment variable the Solana endpoint arrives in — shared with the readers. */
export const PAYOUT_RPC_URL_VAR = 'RPC_URL'

/**
 * The commitment a payout is submitted at.
 *
 * `confirmed` rather than `finalized`, and the asymmetry with the receiving side
 * is deliberate. Money coming *in* is read at `finalized` because a quest that
 * went live on a transfer that then vanished is worse than one that went live
 * thirteen seconds later. Money going *out* is the Colony's own transaction:
 * waiting for finalization before recording it would leave a window in which the
 * transfer exists on chain and the obligation still reads unpaid, which is the
 * window a retry would pay twice in.
 */
const SEND_COMMITMENT = 'confirmed'

export function httpPayoutChain(url: string, fetchImpl: typeof fetch = fetch): PayoutChain {
  const call = async (method: string, params: readonly unknown[]): Promise<unknown> => {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })

    if (!response.ok) throw new Error(`${method} answered ${response.status}.`)

    const body = (await response.json()) as {
      readonly result?: unknown
      readonly error?: { readonly message?: unknown }
    }
    if (body.error !== undefined && body.error !== null) {
      throw new Error(
        `${method} reported an error (${String(body.error.message ?? 'no message')}).`,
      )
    }

    return body.result
  }

  const lamportsAt = async (address: string): Promise<number> => {
    const result = await call('getBalance', [address, { commitment: SEND_COMMITMENT }])
    const value = (result as { value?: unknown })?.value

    // A balance that is not a number is not a zero: reading it as one would make
    // *the endpoint answered strangely* indistinguishable from *the wallet is
    // empty*, and one of those stops every payout.
    if (typeof value !== 'number') throw new Error('getBalance answered no numeric value.')

    return value
  }

  return {
    balance: lamportsAt,

    /**
     * Whether the address exists on chain.
     *
     * An account that has never held SOL has no account at all, and
     * `getAccountInfo` answers `null` for it. That is the fact `#505`'s
     * rent-exempt rule turns on, and it is asked rather than inferred from a
     * zero balance — the two are the same number and different states.
     */
    funded: async (address) => {
      const result = await call('getAccountInfo', [address, { commitment: SEND_COMMITMENT }])
      return (result as { value?: unknown })?.value !== null
    },

    /**
     * The rent-exempt minimum, from the chain.
     *
     * **Read and never hard-coded**, because it is a function of account size and
     * rent parameters rather than a constant this repository owns. The fallback
     * is used only when the endpoint cannot answer, and it exists so that a
     * caller has a number to *refuse* against — refusing to pay is safe, and
     * paying into nothing is not.
     */
    rentExemptMinimum: async () => {
      try {
        const result = await call('getMinimumBalanceForRentExemption', [0])
        return typeof result === 'number' ? result : RENT_EXEMPT_MINIMUM_FALLBACK
      } catch {
        return RENT_EXEMPT_MINIMUM_FALLBACK
      }
    },

    latestBlockhash: async () => {
      const result = await call('getLatestBlockhash', [{ commitment: SEND_COMMITMENT }])
      const blockhash = (result as { value?: { blockhash?: unknown } })?.value?.blockhash

      if (typeof blockhash !== 'string')
        throw new Error('getLatestBlockhash answered no blockhash.')

      return blockhash
    },

    /**
     * Submit the transaction.
     *
     * **`skipPreflight: false`**, so the cluster simulates before accepting: a
     * transfer that would fail is refused here, where the obligation stays owed
     * and is retried, rather than accepted and lost. `maxRetries: 0` because the
     * retry that matters is this Colony's own, against an obligation it can see.
     */
    send: async (transaction) => {
      const signature = await call('sendTransaction', [
        transaction,
        {
          encoding: 'base64',
          skipPreflight: false,
          maxRetries: 0,
          preflightCommitment: SEND_COMMITMENT,
        },
      ])

      if (typeof signature !== 'string') throw new Error('sendTransaction answered no signature.')

      return signature
    },
  }
}
