/**
 * The chain, as the payout runner needs it — D-106 (`#505`).
 *
 * Four reads and one write, over Solana's JSON-RPC. It is a separate file from
 * `payment-watcher.ts` for the reason that reader is separate from the deposit
 * one: this is the half that *sends*, and the half that sends should be
 * reviewable on its own.
 */

import { RENT_EXEMPT_MINIMUM_FALLBACK } from '@kolonie-ai/core'
import { ChainUnreachableError, type PayoutChain } from './payouts.js'

/** The environment variable the Solana endpoint arrives in — shared with the readers. */
export const PAYOUT_RPC_URL_VAR = 'RPC_URL'

/**
 * The answers that mean *ask again*, rather than *this is what is true* — `#764`.
 *
 * A payout run 500'd on 2026-08-12 because `getBalance` answered 522: a
 * Cloudflare connection timeout in front of the RPC provider, which is the
 * network between here and the endpoint failing rather than the endpoint saying
 * anything about the wallet. One line in Loki, one failed pass, and nothing was
 * paid that quarter of an hour.
 *
 * **520–529 is Cloudflare's own range** and is the one that actually fired.
 * `408`, `429`, `500`, `502`, `503` and `504` are here beside it because they are
 * the same statement made by a different hop, and a Solana provider rate-limiting a
 * read is the most ordinary of them.
 *
 * **Nothing in the 400s except 408 and 429.** A malformed request answered 400
 * is answered 400 again on every retry, and retrying it would turn a bug into a
 * slow bug.
 */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504])
const CLOUDFLARE_RANGE = { first: 520, last: 529 } as const

const retryable = (status: number): boolean =>
  RETRYABLE_STATUSES.has(status) ||
  (status >= CLOUDFLARE_RANGE.first && status <= CLOUDFLARE_RANGE.last)

/**
 * Three tries, then give up and let the pass say it could not ask.
 *
 * **Short on purpose.** The caller is a systemd timer firing every quarter of an
 * hour, so the real retry is the next pass and this one only has to cover the
 * blip that would otherwise waste it. Waiting minutes here would hold a request
 * open across the timer's own next firing.
 */
const READ_ATTEMPTS = 3
const BACKOFF_MS = [250, 1_000] as const

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

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

    if (!response.ok) {
      // Thrown as unreachable only where it *is* unreachable: a 400 from the
      // endpoint is this repository's own bug and keeps the plain error, so it
      // still reaches somebody as a failure rather than as a quiet pass.
      if (retryable(response.status))
        throw new ChainUnreachableError(method, `answered ${response.status}`)
      throw new Error(`${method} answered ${response.status}.`)
    }

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

  /**
   * A read, retried — and **only** a read.
   *
   * `sendTransaction` deliberately does not go through this. A write whose
   * response was lost may well have been accepted by the cluster, and *ask
   * again* is the wrong instinct about money leaving: the retry that is safe is
   * the one the payout runner already does, against an obligation it can see and
   * a row that says whether it was settled. Retrying here would be a second
   * submission decided by a layer that cannot see either.
   */
  const read = async (method: string, params: readonly unknown[]): Promise<unknown> => {
    let last: ChainUnreachableError | undefined

    for (let attempt = 0; attempt < READ_ATTEMPTS; attempt += 1) {
      try {
        return await call(method, params)
      } catch (error) {
        // A `fetch` that throws never reached anybody — DNS, a refused
        // connection, a socket closed mid-body. Same statement as a 522, made
        // one layer down.
        last =
          error instanceof ChainUnreachableError
            ? error
            : error instanceof TypeError
              ? new ChainUnreachableError(method, error.message)
              : undefined

        if (last === undefined) throw error

        const backoff = BACKOFF_MS[attempt]
        if (backoff !== undefined) await pause(backoff)
      }
    }

    throw last ?? new ChainUnreachableError(method, `failed ${String(READ_ATTEMPTS)} times`)
  }

  const lamportsAt = async (address: string): Promise<number> => {
    const result = await read('getBalance', [address, { commitment: SEND_COMMITMENT }])
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
      const result = await read('getAccountInfo', [address, { commitment: SEND_COMMITMENT }])
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
        const result = await read('getMinimumBalanceForRentExemption', [0])
        return typeof result === 'number' ? result : RENT_EXEMPT_MINIMUM_FALLBACK
      } catch {
        return RENT_EXEMPT_MINIMUM_FALLBACK
      }
    },

    latestBlockhash: async () => {
      const result = await read('getLatestBlockhash', [{ commitment: SEND_COMMITMENT }])
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
