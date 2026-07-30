import type { SolanaReadResult, SolanaRpc, SolanaTokenBalance } from './solana-payment.js'

/**
 * The environment variable the Solana endpoint arrives in.
 *
 * The name belongs to whoever provisions it, the same rule
 * {@link GITHUB_VERIFIER_TOKEN_VAR} states at length: a variable set on the host
 * under one name and read here under another is kolonie-infra#7 exactly.
 */
export const SOLANA_RPC_URL_VAR = 'SOLANA_RPC_URL'

/**
 * Solana's own public mainnet endpoint, and the default.
 *
 * **This differs from every other reader in the package by needing no
 * credential**, which is what lets the earning rungs ship without an infra
 * ticket blocking them. It is rate-limited and the Colony should expect to
 * outgrow it — but the failure mode when it does is `unavailable`, which
 * re-queues rather than failing an agent, so outgrowing it is a deploy and not
 * an incident.
 */
export const DEFAULT_SOLANA_RPC_URL = 'https://api.mainnet-beta.solana.com'

/** The subset of Solana's `getTransaction` payload a verdict is built from. */
interface RpcTransactionPayload {
  readonly meta?: {
    readonly err?: unknown
    readonly preBalances?: unknown
    readonly postBalances?: unknown
    readonly preTokenBalances?: unknown
    readonly postTokenBalances?: unknown
    readonly loadedAddresses?: {
      readonly writable?: unknown
      readonly readonly?: unknown
    } | null
  } | null
  readonly transaction?: {
    readonly message?: {
      readonly accountKeys?: unknown
    } | null
  } | null
}

/**
 * Read Solana over its public JSON-RPC.
 *
 * `jsonParsed` encoding, `confirmed` commitment. Confirmed rather than finalized
 * is a deliberate choice about what an agent is made to wait for: finalization
 * takes roughly another twenty seconds and adds nothing this rung depends on.
 * The Colony is not settling a trade, it is reading whether a payment happened,
 * and a confirmed transaction that later forks away is a case Solana's consensus
 * makes vanishingly rare and which no earning rung is a target for.
 *
 * The URL arrives as an argument rather than being read from `process.env` in
 * here, so that nothing in this package has to be trusted about where it came
 * from and the runner's wiring stays the single place it is named.
 */
export function httpSolanaRpc(
  url: string = DEFAULT_SOLANA_RPC_URL,
  fetchImpl: typeof fetch = fetch,
): SolanaRpc {
  return {
    getTransaction: async (txid): Promise<SolanaReadResult> => {
      let response: Response
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'user-agent': 'kolonie-verifier-runner' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getTransaction',
            params: [
              txid,
              {
                encoding: 'jsonParsed',
                commitment: 'confirmed',
                // Without this, the endpoint refuses every versioned
                // transaction with an error rather than returning it — and
                // versioned is what any wallet built since 2022 sends. Omitting
                // it would make this reader answer `unavailable` for most of the
                // chain.
                maxSupportedTransactionVersion: 0,
              },
            ],
          }),
        })
      } catch (error) {
        return {
          outcome: 'unavailable',
          reason: `the endpoint could not be reached (${error instanceof Error ? error.message : String(error)}).`,
        }
      }

      /**
       * Every non-2xx is ours, not the agent's — 429 above all, which is what a
       * free endpoint answers under load and is the single most likely failure
       * here. None of them is evidence about a payment, so none may produce a
       * `fail` (#19).
       */
      if (!response.ok) {
        return { outcome: 'unavailable', reason: `the endpoint answered ${response.status}.` }
      }

      let body: { readonly result?: unknown; readonly error?: { readonly message?: unknown } }
      try {
        body = (await response.json()) as typeof body
      } catch {
        return {
          outcome: 'unavailable',
          reason: 'the endpoint answered with something that is not JSON.',
        }
      }

      if (body.error !== undefined && body.error !== null) {
        return {
          outcome: 'unavailable',
          reason: `the endpoint reported an error (${String(body.error.message ?? 'no message')}).`,
        }
      }

      // A null result is Solana's way of saying it has no confirmed transaction
      // under that signature — which is a fact about the chain right now, not
      // forever, and is why the verifier reads it as `pending`.
      if (body.result === null || body.result === undefined) {
        return { outcome: 'not-found', reason: 'The endpoint returned no transaction for it.' }
      }

      const payload = body.result as RpcTransactionPayload
      const meta = payload.meta
      if (meta === null || meta === undefined) {
        return {
          outcome: 'unavailable',
          reason:
            'the endpoint returned a transaction with no metadata, so no balance moved in it can be read.',
        }
      }

      const preBalances = numbers(meta.preBalances)
      const postBalances = numbers(meta.postBalances)
      if (preBalances === null || postBalances === null) {
        return {
          outcome: 'unavailable',
          reason: 'the endpoint returned balances that are not numbers.',
        }
      }

      return {
        outcome: 'found',
        transaction: {
          signature: txid,
          err: meta.err ?? null,
          accountKeys: accountKeys(payload),
          preBalances,
          postBalances,
          preTokenBalances: tokenBalances(meta.preTokenBalances),
          postTokenBalances: tokenBalances(meta.postTokenBalances),
        },
      }
    },
  }
}

/**
 * Every account the transaction touched, in the order the balance arrays use.
 *
 * **Loaded addresses are appended, and leaving them out would be a silent
 * wrong answer rather than a missing feature.** A versioned transaction may
 * carry most of its accounts in an address lookup table; Solana returns those
 * separately in `meta.loadedAddresses` but indexes `preBalances` and
 * `postBalances` over the concatenation — static keys, then loaded writable,
 * then loaded readonly. A reader that stopped at the static keys would hand the
 * verifier balance deltas belonging to whichever account happened to sit at that
 * index, which is worse than no answer.
 */
function accountKeys(payload: RpcTransactionPayload): readonly string[] {
  const message = payload.transaction?.message
  const statics = Array.isArray(message?.accountKeys)
    ? message.accountKeys.map((key) =>
        typeof key === 'string' ? key : String((key as { pubkey?: unknown })?.pubkey ?? ''),
      )
    : []

  const loaded = payload.meta?.loadedAddresses
  const writable = Array.isArray(loaded?.writable) ? loaded.writable.map(String) : []
  const readonlyKeys = Array.isArray(loaded?.readonly) ? loaded.readonly.map(String) : []

  return [...statics, ...writable, ...readonlyKeys]
}

/** Solana's token balance entries, reduced to owner, mint and raw amount. */
function tokenBalances(value: unknown): readonly SolanaTokenBalance[] {
  if (!Array.isArray(value)) return []

  return value.flatMap((entry) => {
    const balance = entry as {
      owner?: unknown
      mint?: unknown
      uiTokenAmount?: { amount?: unknown }
    }
    const owner = balance.owner
    const mint = balance.mint
    const amount = balance.uiTokenAmount?.amount

    // An entry missing any of the three says nothing and must not be read as a
    // zero — a zero would look like a balance that did not move.
    if (typeof owner !== 'string' || typeof mint !== 'string' || typeof amount !== 'string') {
      return []
    }

    return [{ owner, mint, amount }]
  })
}

/** An array of finite numbers, or `null` if it is anything else. */
function numbers(value: unknown): readonly number[] | null {
  if (!Array.isArray(value)) return null
  if (!value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))) return null

  return value
}
