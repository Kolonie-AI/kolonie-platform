/**
 * The reconciliation's eyes: what an address has received, read from the chain.
 *
 * `reconcileDeposits` has had a port and no implementation since `#219` landed,
 * which made a missed webhook delivery a permanent loss rather than a delay
 * (kolonie-infra#72). This is the implementation.
 *
 * **It is a second reader rather than a reuse of `packages/verifiers`, and the
 * reason is one word in the request.** `httpSolanaRpc` reads at `confirmed`,
 * deliberately and correctly — an earning rung should not make an agent wait
 * twenty extra seconds for a fact that will not change. `DEPOSIT_COMMITMENT` is
 * `finalized`, equally deliberately, because this reader credits a balance with
 * somebody's money. A shared reader would have to be right at both commitments
 * at once, and the version that ended up shared would be whichever caller
 * changed it last.
 */

import type { ObservedTransfer } from '@kolonie-ai/core'
import { DEPOSIT_COMMITMENT, SPL_TOKEN_PROGRAM } from '@kolonie-ai/core'
import type { DepositWatcher } from './deposits.js'

/** The environment variable the Solana endpoint arrives in. */
export const DEPOSIT_RPC_URL_VAR = 'RPC_URL'

/**
 * How far back one pass looks.
 *
 * The pass runs hourly and a sponsor's address receives approximately nothing —
 * one deposit, once, at the moment it funds a quest. Twenty-five signatures is
 * three weeks of a busy address and one RPC page, so the limit is never the
 * thing that loses a deposit; an endpoint that is down for three weeks is.
 */
export const SIGNATURE_PAGE = 25

/**
 * Token programs a balance entry may legitimately belong to.
 *
 * Both are listed even though `depositRejection` accepts only the first,
 * because this reader's job is to report what the chain said and the decision
 * about what may be credited belongs in one place (`packages/core`). A reader
 * that filtered Token-2022 out here would make *wrong-token-program* — a
 * rejection a sponsor can be told about and act on — indistinguishable from a
 * transfer that never happened.
 */
const TOKEN_PROGRAMS: readonly string[] = [
  SPL_TOKEN_PROGRAM,
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
]

interface RpcAnswer {
  readonly outcome: 'ok'
  readonly result: unknown
}

type RpcResult = RpcAnswer | { readonly outcome: 'unavailable'; readonly reason: string }

/**
 * Read deposits over Solana's JSON-RPC.
 *
 * The URL arrives as an argument rather than being read from `process.env` here,
 * so the server's wiring stays the single place it is named — the rule
 * `httpSolanaRpc` already follows.
 *
 * **Every failure is thrown, not returned.** `reconcileDeposits` catches per
 * address and counts a failure, which is the behaviour its own doc comment
 * promises: one unreachable address must not stop the pass over the others. A
 * watcher that returned an empty array on an outage would be indistinguishable
 * from one that looked and found nothing, and the pass would report a clean run
 * it never had.
 */
export function httpDepositWatcher(url: string, fetchImpl: typeof fetch = fetch): DepositWatcher {
  /**
   * One signature, read at `finalized`.
   *
   * Shared by both halves of the port on purpose (`#321`): the webhook and the
   * reconciliation must agree about what a signature moved, and two readers
   * would eventually be two answers.
   */
  const transfersIn = async (
    signature: string,
    address: string,
  ): Promise<readonly ObservedTransfer[]> => {
    const answer = await rpcCall(url, fetchImpl, 'getTransaction', [
      signature,
      {
        encoding: 'jsonParsed',
        commitment: DEPOSIT_COMMITMENT,
        // Without this the endpoint refuses every versioned transaction,
        // which is what any wallet built since 2022 sends.
        maxSupportedTransactionVersion: 0,
      },
    ])
    if (answer.outcome === 'unavailable') throw new Error(answer.reason)

    // `null` is the endpoint saying it holds no finalized transaction under
    // that signature. For the reconciliation, between two calls, that is
    // ordinary; for the webhook it is the usual case of a delivery arriving
    // before the cluster finalized, and the hourly pass picks it up.
    if (answer.result === null || answer.result === undefined) return []

    return arrivalsIn(answer.result, address, signature)
  }

  return {
    transfersIn,

    transfersAt: async (address): Promise<readonly ObservedTransfer[]> => {
      const history = await rpcCall(url, fetchImpl, 'getSignaturesForAddress', [
        address,
        { limit: SIGNATURE_PAGE, commitment: DEPOSIT_COMMITMENT },
      ])
      if (history.outcome === 'unavailable') throw new Error(history.reason)

      const signatures = Array.isArray(history.result)
        ? history.result.flatMap((entry) => {
            const signature = (entry as { signature?: unknown }).signature
            // An entry the chain reports as failed moved no money, and reading
            // its balances would report the amounts it *would* have moved.
            const failed = (entry as { err?: unknown }).err
            if (typeof signature !== 'string' || (failed !== null && failed !== undefined)) {
              return []
            }
            return [signature]
          })
        : []

      const transfers: ObservedTransfer[] = []

      for (const signature of signatures) {
        transfers.push(...(await transfersIn(signature, address)))
      }

      return transfers
    },
  }
}

/**
 * What this address gained in this transaction, per mint.
 *
 * **A delta rather than a parsed transfer instruction**, for the reason
 * `SolanaTransaction` gives at length: USDC may arrive bare, through a router,
 * through an escrow, or through a token account the payer opened on the spot,
 * and enumerating the programs the Colony is willing to be paid through means
 * refusing a sponsor for using a wallet we had not heard of. What every route
 * has in common is that the balance is higher afterwards.
 *
 * A fall is not a deposit and is skipped rather than reported as a negative:
 * `ObservedTransfer.baseUnits` is a non-negative integer and a withdrawal is not
 * this endpoint's business.
 */
function arrivalsIn(
  result: unknown,
  address: string,
  signature: string,
): readonly ObservedTransfer[] {
  const meta = (result as { meta?: { err?: unknown } | null }).meta
  if (meta === null || meta === undefined) return []

  // A failed transaction's balances describe what did not happen.
  if (meta.err !== null && meta.err !== undefined) return []

  const before = balancesOwnedBy((meta as { preTokenBalances?: unknown }).preTokenBalances, address)
  const after = balancesOwnedBy(
    (meta as { postTokenBalances?: unknown }).postTokenBalances,
    address,
  )

  const transfers: ObservedTransfer[] = []

  for (const [mint, entry] of after) {
    const gained = entry.amount - (before.get(mint)?.amount ?? 0n)
    if (gained <= 0n) continue

    // Beyond `Number.MAX_SAFE_INTEGER` the base units cannot be stated exactly,
    // and `ObservedTransferSchema` requires an integer. At six decimals this is
    // nine billion USDC; reporting an approximation of somebody's money is
    // worse than reporting nothing and letting the next pass — or a human —
    // find it.
    if (gained > BigInt(Number.MAX_SAFE_INTEGER)) continue

    transfers.push({
      signature,
      address,
      mint,
      tokenProgram: entry.tokenProgram,
      baseUnits: Number(gained),
      commitment: DEPOSIT_COMMITMENT,
    })
  }

  return transfers
}

interface OwnedBalance {
  readonly amount: bigint
  readonly tokenProgram: string
}

/**
 * This owner's token balances, by mint.
 *
 * `owner` and not the account address, because an SPL balance lives in an
 * account the wallet owns rather than in the wallet — the deposit address the
 * Colony generated never appears as the holder of a USDC balance.
 *
 * **An entry that does not name a token program is reported as having none, and
 * is never guessed at.** Defaulting to `SPL_TOKEN_PROGRAM` would credit a
 * Token-2022 transfer as though the program had been checked, which is the one
 * failure that costs the Colony money rather than a sponsor a round trip. The
 * empty string is refused by `depositRejection` as `wrong-token-program` — a
 * rejection the sponsor is shown and can act on, and one that appears in
 * `deposits` rather than vanishing.
 *
 * Every endpoint the Colony is known to run against returns `programId` on
 * these entries. If one is ever found that does not, the fix is a note here and
 * a decision about that endpoint, not a default in this function.
 */
function balancesOwnedBy(value: unknown, address: string): Map<string, OwnedBalance> {
  const balances = new Map<string, OwnedBalance>()
  if (!Array.isArray(value)) return balances

  for (const raw of value) {
    const entry = raw as {
      owner?: unknown
      mint?: unknown
      programId?: unknown
      uiTokenAmount?: { amount?: unknown }
    }

    if (entry.owner !== address) continue
    if (typeof entry.mint !== 'string') continue

    const amount = entry.uiTokenAmount?.amount
    // A missing amount says nothing and must not be read as a zero — a zero
    // would look like a balance that did not move.
    if (typeof amount !== 'string' || !/^\d+$/.test(amount)) continue

    const tokenProgram =
      typeof entry.programId === 'string' && TOKEN_PROGRAMS.includes(entry.programId)
        ? entry.programId
        : ''

    balances.set(entry.mint, { amount: BigInt(amount), tokenProgram })
  }

  return balances
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
