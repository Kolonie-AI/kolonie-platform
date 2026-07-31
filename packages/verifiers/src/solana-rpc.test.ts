import { describe, expect, it } from 'vitest'
import { DEFAULT_SOLANA_RPC_URL, httpSolanaHistory, httpSolanaRpc } from './solana-rpc.js'
import { USDC_MINT } from './solana-payment.js'

const TXID = '5wHu1qwD4kLmNbVcXzAsDfGhJkLpQwErTyUiOpAsDfGhJkLzXcVbNmQwErTyUiOp'

/** A `fetch` that answers one JSON-RPC body, and records what it was asked. */
function endpoint(body: unknown, status = 200) {
  const calls: Array<{ url: string; body: unknown }> = []

  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) })

    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch

  return { impl, calls }
}

const result = (value: unknown) => ({ jsonrpc: '2.0', id: 1, result: value })

describe('httpSolanaRpc', () => {
  it('asks for a confirmed, version-tolerant, parsed transaction', async () => {
    const { impl, calls } = endpoint(result(null))
    await httpSolanaRpc(DEFAULT_SOLANA_RPC_URL, impl).getTransaction(TXID)

    const sent = calls[0]?.body as { method: string; params: [string, Record<string, unknown>] }
    expect(sent.method).toBe('getTransaction')
    expect(sent.params[0]).toBe(TXID)
    expect(sent.params[1]).toMatchObject({
      encoding: 'jsonParsed',
      commitment: 'confirmed',
      // Without it the endpoint refuses every versioned transaction, which is
      // most of the chain since 2022.
      maxSupportedTransactionVersion: 0,
    })
  })

  it('reads a null result as not-found rather than as an outage', async () => {
    const { impl } = endpoint(result(null))
    const read = await httpSolanaRpc(DEFAULT_SOLANA_RPC_URL, impl).getTransaction(TXID)

    expect(read.outcome).toBe('not-found')
  })

  it('reads jsonParsed account keys, which are objects rather than strings', async () => {
    const { impl } = endpoint(
      result({
        transaction: { message: { accountKeys: [{ pubkey: 'AAA' }, { pubkey: 'BBB' }] } },
        meta: { err: null, preBalances: [10, 0], postBalances: [5, 5] },
      }),
    )
    const read = await httpSolanaRpc(DEFAULT_SOLANA_RPC_URL, impl).getTransaction(TXID)

    expect(read).toMatchObject({
      outcome: 'found',
      transaction: { accountKeys: ['AAA', 'BBB'], err: null },
    })
  })

  /**
   * The balance arrays are indexed over static keys *then* loaded writable
   * *then* loaded readonly. A reader that stopped at the static keys would hand
   * the verifier a delta belonging to whichever account sat at that index —
   * a wrong answer rather than a missing one.
   */
  it('appends addresses loaded from a lookup table, in the order balances use', async () => {
    const { impl } = endpoint(
      result({
        transaction: { message: { accountKeys: [{ pubkey: 'STATIC' }] } },
        meta: {
          err: null,
          preBalances: [10, 0, 7],
          postBalances: [5, 5, 7],
          loadedAddresses: { writable: ['WRITABLE'], readonly: ['READONLY'] },
        },
      }),
    )
    const read = await httpSolanaRpc(DEFAULT_SOLANA_RPC_URL, impl).getTransaction(TXID)

    expect(read).toMatchObject({
      outcome: 'found',
      transaction: { accountKeys: ['STATIC', 'WRITABLE', 'READONLY'] },
    })
  })

  it('reduces token balances to owner, mint and raw amount', async () => {
    const { impl } = endpoint(
      result({
        transaction: { message: { accountKeys: [{ pubkey: 'AAA' }] } },
        meta: {
          err: null,
          preBalances: [10],
          postBalances: [5],
          postTokenBalances: [
            {
              owner: 'BBB',
              mint: USDC_MINT,
              uiTokenAmount: { amount: '2500000', decimals: 6, uiAmount: 2.5 },
            },
            // Missing an owner: says nothing, and must not be read as a zero,
            // which would look like a balance that did not move.
            { mint: USDC_MINT, uiTokenAmount: { amount: '1' } },
          ],
        },
      }),
    )
    const read = await httpSolanaRpc(DEFAULT_SOLANA_RPC_URL, impl).getTransaction(TXID)

    expect(read).toMatchObject({
      outcome: 'found',
      transaction: {
        postTokenBalances: [{ owner: 'BBB', mint: USDC_MINT, amount: '2500000' }],
        preTokenBalances: [],
      },
    })
  })

  it('carries the chain-side error through rather than discarding it', async () => {
    const { impl } = endpoint(
      result({
        transaction: { message: { accountKeys: [] } },
        meta: { err: { InstructionError: [0, 'Custom'] }, preBalances: [], postBalances: [] },
      }),
    )
    const read = await httpSolanaRpc(DEFAULT_SOLANA_RPC_URL, impl).getTransaction(TXID)

    expect(read).toMatchObject({
      outcome: 'found',
      transaction: { err: { InstructionError: [0, 'Custom'] } },
    })
  })

  /**
   * A rate-limited free endpoint is the single most likely failure here, and it
   * is ours. None of these may produce a `fail`: an agent that was really paid
   * must not lose its attempt to our outage (#19).
   */
  it('reads a 429 as unavailable', async () => {
    const { impl } = endpoint({ error: 'slow down' }, 429)
    const read = await httpSolanaRpc(DEFAULT_SOLANA_RPC_URL, impl).getTransaction(TXID)

    expect(read).toMatchObject({ outcome: 'unavailable' })
  })

  it('reads a JSON-RPC error object as unavailable', async () => {
    const { impl } = endpoint({ jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'busy' } })
    const read = await httpSolanaRpc(DEFAULT_SOLANA_RPC_URL, impl).getTransaction(TXID)

    expect(read).toMatchObject({ outcome: 'unavailable' })
  })

  it('reads an unreachable endpoint as unavailable', async () => {
    const impl = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    const read = await httpSolanaRpc(DEFAULT_SOLANA_RPC_URL, impl).getTransaction(TXID)

    expect(read).toMatchObject({ outcome: 'unavailable' })
  })

  it('reads a transaction with no metadata as unavailable, not as a verdict', async () => {
    const { impl } = endpoint(result({ transaction: { message: { accountKeys: [] } } }))
    const read = await httpSolanaRpc(DEFAULT_SOLANA_RPC_URL, impl).getTransaction(TXID)

    expect(read).toMatchObject({ outcome: 'unavailable' })
  })

  it('defaults to the public mainnet endpoint', async () => {
    const { impl, calls } = endpoint(result(null))
    await httpSolanaRpc(undefined, impl).getTransaction(TXID)

    expect(calls[0]?.url).toBe(DEFAULT_SOLANA_RPC_URL)
  })
})

describe('httpSolanaHistory', () => {
  it('asks for the address history at the limit it was given', async () => {
    const { impl, calls } = endpoint(result([]))
    await httpSolanaHistory(DEFAULT_SOLANA_RPC_URL, impl).signaturesFor('ADDR', 120)

    const sent = calls[0]?.body as { method: string; params: [string, Record<string, unknown>] }
    expect(sent.method).toBe('getSignaturesForAddress')
    expect(sent.params[0]).toBe('ADDR')
    expect(sent.params[1]).toMatchObject({ limit: 120, commitment: 'confirmed' })
  })

  it('reads signatures and their block times', async () => {
    const { impl } = endpoint(
      result([
        { signature: 'one', blockTime: 1_780_000_000, slot: 1 },
        // Solana returns null for a slot it has no time for. Dropped to null
        // here rather than guessed — the verifier's window is a claim, and a
        // row nothing can date cannot support it.
        { signature: 'two', blockTime: null, slot: 2 },
        { slot: 3 },
      ]),
    )
    const read = await httpSolanaHistory(DEFAULT_SOLANA_RPC_URL, impl).signaturesFor('ADDR', 10)

    expect(read).toMatchObject({
      outcome: 'found',
      signatures: [
        { signature: 'one', blockTime: 1_780_000_000 },
        { signature: 'two', blockTime: null },
      ],
    })
  })

  it('reads an empty history as an answer, not as an outage', async () => {
    const { impl } = endpoint(result([]))
    const read = await httpSolanaHistory(DEFAULT_SOLANA_RPC_URL, impl).signaturesFor('ADDR', 10)

    expect(read).toMatchObject({ outcome: 'found', signatures: [] })
  })

  /**
   * An address the chain has never seen answers with an empty array, so a null
   * is the endpoint misbehaving. Reading it as "no history" would fail an agent
   * for our own bad read.
   */
  it('reads a null history as unavailable', async () => {
    const { impl } = endpoint(result(null))
    const read = await httpSolanaHistory(DEFAULT_SOLANA_RPC_URL, impl).signaturesFor('ADDR', 10)

    expect(read).toMatchObject({ outcome: 'unavailable' })
  })

  it('reads a 429 as unavailable, like every other read', async () => {
    const { impl } = endpoint({ error: 'slow down' }, 429)
    const read = await httpSolanaHistory(DEFAULT_SOLANA_RPC_URL, impl).signaturesFor('ADDR', 10)

    expect(read).toMatchObject({ outcome: 'unavailable' })
  })
})
