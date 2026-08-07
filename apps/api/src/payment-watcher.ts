/**
 * The payment reconciliation's eyes: what the Colony wallet has received, read
 * from the chain — D-106 (`#503`).
 *
 * **Native SOL rather than a token, which makes this a simpler reader than
 * `httpDepositWatcher` and not a copy of it.** A token balance lives in an
 * account the wallet owns, so the deposit reader had to match on `owner` across
 * `preTokenBalances` and `postTokenBalances`. Lamports live on the account
 * itself, so the answer is `postBalances[i] - preBalances[i]` at the wallet's
 * own index in `accountKeys` — and the fee is already inside those numbers,
 * which is what makes them the amount that actually arrived.
 *
 * It reads at `finalized`, for the reason `DEPOSIT_COMMITMENT` gives: a quest
 * that went live on money that then evaporated is worse than one that went live
 * thirteen seconds later.
 */

import { PAYMENT_COMMITMENT, type ObservedPayment } from '@kolonie-ai/core'
import type { PaymentWatcher } from './payments.js'

/** The environment variable the Solana endpoint arrives in — shared with the deposit reader. */
export const PAYMENT_RPC_URL_VAR = 'RPC_URL'

/**
 * How far back one pass looks.
 *
 * **Larger than the deposit reader's page, because the address is busier.** A
 * sponsor's deposit address received approximately one transfer ever; the Colony
 * wallet receives every invoice payment *and* is the account `#505` pays every
 * citizen from, so its signature history moves. A hundred is a comfortable
 * multiple of an hour's traffic at any volume the Colony has, and the pass runs
 * hourly.
 *
 * This is the one number that could silently lose a payment: an hour that
 * produces more than a page of signatures would push an unseen arrival off the
 * end. It is not a theoretical failure, so it is measured rather than assumed —
 * `reconcilePayments` reports what it saw, and a pass that consistently returns
 * a full page is the signal to raise this.
 */
export const PAYMENT_SIGNATURE_PAGE = 100

interface RpcAnswer {
  readonly outcome: 'ok'
  readonly result: unknown
}

type RpcResult = RpcAnswer | { readonly outcome: 'unavailable'; readonly reason: string }

/**
 * Read arrivals over Solana's JSON-RPC.
 *
 * The URL arrives as an argument rather than being read from `process.env`, so
 * the server's wiring stays the single place it is named.
 *
 * **Every failure is thrown, not returned.** A reader that answered "no
 * payments" during an outage would be indistinguishable from one that looked and
 * found none, and the pass would report a clean run it never had.
 */
export function httpPaymentWatcher(url: string, fetchImpl: typeof fetch = fetch): PaymentWatcher {
  /** One signature, read at `finalized`. Shared by both halves of the port. */
  const paymentsIn = async (
    signature: string,
    address: string,
  ): Promise<readonly ObservedPayment[]> => {
    const answer = await rpcCall(url, fetchImpl, 'getTransaction', [
      signature,
      {
        encoding: 'jsonParsed',
        commitment: PAYMENT_COMMITMENT,
        // Without this the endpoint refuses every versioned transaction, which
        // is what any wallet built since 2022 sends.
        maxSupportedTransactionVersion: 0,
      },
    ])
    if (answer.outcome === 'unavailable') throw new Error(answer.reason)

    // `null` is the endpoint saying it holds no finalized transaction under that
    // signature — ordinary for the webhook, which fires before finalization.
    if (answer.result === null || answer.result === undefined) return []

    return arrivalsIn(answer.result, address, signature)
  }

  return {
    paymentsIn,

    paymentsAt: async (address): Promise<readonly ObservedPayment[]> => {
      const history = await rpcCall(url, fetchImpl, 'getSignaturesForAddress', [
        address,
        { limit: PAYMENT_SIGNATURE_PAGE, commitment: PAYMENT_COMMITMENT },
      ])
      if (history.outcome === 'unavailable') throw new Error(history.reason)

      const signatures = Array.isArray(history.result)
        ? history.result.flatMap((entry) => {
            const signature = (entry as { signature?: unknown }).signature
            // A transaction the chain reports as failed moved no money.
            const failed = (entry as { err?: unknown }).err
            if (typeof signature !== 'string' || (failed !== null && failed !== undefined)) {
              return []
            }
            return [signature]
          })
        : []

      const payments: ObservedPayment[] = []

      for (const signature of signatures) {
        payments.push(...(await paymentsIn(signature, address)))
      }

      return payments
    },
  }
}

/**
 * What this address gained in this transaction, and who paid.
 *
 * **The sender is the fee payer, which is `accountKeys[0]`.** That is a claim
 * worth being precise about, because the whole attribution rests on it: Solana
 * requires the first account of a transaction to be the fee payer and a signer,
 * so it is the one account that provably authorised the transaction rather than
 * merely appearing in it. A transfer routed through a program still has the
 * paying wallet there.
 *
 * The alternative — the account whose balance *fell* — is wrong in the ordinary
 * case rather than the exotic one: the fee payer's balance falls by the transfer
 * plus the fee, and any intermediate account a router touched falls too.
 *
 * A gain of zero or less is not a payment and is skipped. The Colony wallet
 * paying somebody out (`#505`) is exactly that case, and it must not appear here
 * as income.
 */
function arrivalsIn(
  result: unknown,
  address: string,
  signature: string,
): readonly ObservedPayment[] {
  const meta = (result as { meta?: { err?: unknown } | null }).meta
  if (meta === null || meta === undefined) return []

  // A failed transaction's balances describe what did not happen.
  if (meta.err !== null && meta.err !== undefined) return []

  const keys = accountKeysIn(result)
  const index = keys.indexOf(address)
  if (index < 0) return []

  const before = lamportsAt((meta as { preBalances?: unknown }).preBalances, index)
  const after = lamportsAt((meta as { postBalances?: unknown }).postBalances, index)
  if (before === null || after === null) return []

  const gained = after - before
  if (gained <= 0n) return []

  // Beyond `Number.MAX_SAFE_INTEGER` the amount cannot be stated exactly, and
  // `ObservedPaymentSchema` requires an integer. That is nine million SOL;
  // reporting an approximation of somebody's money is worse than reporting
  // nothing and letting a human find it.
  if (gained > BigInt(Number.MAX_SAFE_INTEGER)) return []

  const sender = keys[0]
  // A transaction with no account keys is not one the Colony can attribute, and
  // guessing a sender is the one mistake that credits the wrong citizen.
  if (sender === undefined || sender === address) return []

  return [
    {
      signature,
      sender,
      recipient: address,
      lamports: Number(gained),
      commitment: PAYMENT_COMMITMENT,
    },
  ]
}

/**
 * The transaction's account keys, in order, however the endpoint spells them.
 *
 * `jsonParsed` returns objects carrying `pubkey`; the base encodings return
 * plain strings. Both are read rather than one being required, because the
 * difference is the endpoint's choice and not the Colony's.
 *
 * **Address-table lookups are appended in the order the runtime resolves
 * them** — writable then readonly — which is the order `preBalances` and
 * `postBalances` are indexed in. A wallet receiving through a versioned
 * transaction appears there and nowhere else.
 */
function accountKeysIn(result: unknown): readonly string[] {
  const message = (result as { transaction?: { message?: { accountKeys?: unknown } } }).transaction
    ?.message
  const keys = Array.isArray(message?.accountKeys) ? message.accountKeys : []

  const named = keys.flatMap((key) => {
    if (typeof key === 'string') return [key]
    const pubkey = (key as { pubkey?: unknown }).pubkey
    return typeof pubkey === 'string' ? [pubkey] : []
  })

  const loaded = (result as { meta?: { loadedAddresses?: unknown } | null }).meta?.loadedAddresses
  const writable = (loaded as { writable?: unknown })?.writable
  const readonly_ = (loaded as { readonly?: unknown })?.readonly

  return [
    ...named,
    ...(Array.isArray(writable) ? writable.filter((key) => typeof key === 'string') : []),
    ...(Array.isArray(readonly_) ? readonly_.filter((key) => typeof key === 'string') : []),
  ]
}

/** One entry of a balance array, as a bigint, or null if it is not a number. */
function lamportsAt(value: unknown, index: number): bigint | null {
  if (!Array.isArray(value)) return null

  const entry = value[index]
  // A missing entry says nothing and must not be read as a zero — a zero would
  // look like an account that received its whole balance in this transaction.
  if (typeof entry !== 'number' || !Number.isInteger(entry) || entry < 0) return null

  return BigInt(entry)
}

/** One JSON-RPC call, with every failure turned into a reason a human can read. */
async function rpcCall(
  url: string,
  fetchImpl: typeof fetch,
  method: string,
  params: readonly unknown[],
): Promise<RpcResult> {
  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
  } catch (error) {
    return { outcome: 'unavailable', reason: `${method} could not be reached (${String(error)}).` }
  }

  if (!response.ok) {
    return { outcome: 'unavailable', reason: `${method} answered ${response.status}.` }
  }

  let body: { readonly result?: unknown; readonly error?: { readonly message?: unknown } }
  try {
    body = (await response.json()) as typeof body
  } catch {
    return { outcome: 'unavailable', reason: `${method} answered with something that is not JSON.` }
  }

  if (body.error !== undefined && body.error !== null) {
    return {
      outcome: 'unavailable',
      reason: `${method} reported an error (${String(body.error.message ?? 'no message')}).`,
    }
  }

  return { outcome: 'ok', result: body.result }
}
