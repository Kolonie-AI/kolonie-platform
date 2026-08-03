import { describe, expect, it } from 'vitest'
import { SPL_TOKEN_PROGRAM, USDC_MINT, depositRejection } from '@kolonie-ai/core'
import { httpDepositWatcher, SIGNATURE_PAGE } from './deposit-watcher.js'

const ADDRESS = 'DepositAddressOfASponsor11111111111111111111'
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'

/** One `getTransaction` payload, with the two balance arrays that decide it. */
const transaction = (
  pre: readonly unknown[],
  post: readonly unknown[],
  err: unknown = null,
): unknown => ({ meta: { err, preTokenBalances: pre, postTokenBalances: post } })

const balance = (amount: string, overrides: Record<string, unknown> = {}) => ({
  owner: ADDRESS,
  mint: USDC_MINT,
  programId: SPL_TOKEN_PROGRAM,
  uiTokenAmount: { amount },
  ...overrides,
})

/**
 * A fake endpoint that answers by method name.
 *
 * The calls are recorded so a test can assert *what was asked of the chain*,
 * which is the half of this reader that costs money on a paid RPC plan.
 */
function endpoint(answers: Record<string, unknown | ((params: readonly unknown[]) => unknown)>) {
  const calls: { method: string; params: readonly unknown[] }[] = []

  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; params: readonly unknown[] }
    calls.push({ method: body.method, params: body.params })

    const answer = answers[body.method]
    const result = typeof answer === 'function' ? answer(body.params) : answer

    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: result ?? null }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch

  return { fetchImpl, calls }
}

describe('httpDepositWatcher', () => {
  it('reports the rise in this address’s balance as a finalized transfer', async () => {
    const { fetchImpl } = endpoint({
      getSignaturesForAddress: [{ signature: 'sig-1', err: null }],
      getTransaction: transaction([balance('0')], [balance('2500000')]),
    })

    const [transfer, ...rest] = await httpDepositWatcher('http://rpc', fetchImpl).transfersAt(
      ADDRESS,
    )

    expect(rest).toEqual([])
    expect(transfer).toEqual({
      signature: 'sig-1',
      address: ADDRESS,
      mint: USDC_MINT,
      tokenProgram: SPL_TOKEN_PROGRAM,
      baseUnits: 2_500_000,
      commitment: 'finalized',
    })
    // The whole point: what comes out of here is creditable by the same
    // function the webhook is checked by.
    expect(depositRejection(transfer!)).toBeUndefined()
  })

  it('asks the chain at finalized, which is the commitment a credit requires', async () => {
    const { fetchImpl, calls } = endpoint({
      getSignaturesForAddress: [{ signature: 'sig-1', err: null }],
      getTransaction: transaction([balance('0')], [balance('1000000')]),
    })

    await httpDepositWatcher('http://rpc', fetchImpl).transfersAt(ADDRESS)

    expect(calls[0]?.params[1]).toMatchObject({
      commitment: 'finalized',
      limit: SIGNATURE_PAGE,
    })
    expect(calls[1]?.params[1]).toMatchObject({
      commitment: 'finalized',
      maxSupportedTransactionVersion: 0,
    })
  })

  it('counts an arrival into a balance that did not exist before', async () => {
    const { fetchImpl } = endpoint({
      getSignaturesForAddress: [{ signature: 'sig-1', err: null }],
      // No pre-balance at all: the token account was opened by this transfer,
      // which is what a first-ever deposit looks like.
      getTransaction: transaction([], [balance('1000000')]),
    })

    const transfers = await httpDepositWatcher('http://rpc', fetchImpl).transfersAt(ADDRESS)

    expect(transfers[0]?.baseUnits).toBe(1_000_000)
  })

  it('ignores a fall, which is a withdrawal and not this endpoint’s business', async () => {
    const { fetchImpl } = endpoint({
      getSignaturesForAddress: [{ signature: 'sig-1', err: null }],
      getTransaction: transaction([balance('5000000')], [balance('1000000')]),
    })

    expect(await httpDepositWatcher('http://rpc', fetchImpl).transfersAt(ADDRESS)).toEqual([])
  })

  it('ignores a balance belonging to somebody else', async () => {
    const { fetchImpl } = endpoint({
      getSignaturesForAddress: [{ signature: 'sig-1', err: null }],
      getTransaction: transaction([], [balance('9000000', { owner: 'somebody-else' })]),
    })

    expect(await httpDepositWatcher('http://rpc', fetchImpl).transfersAt(ADDRESS)).toEqual([])
  })

  it('reads a failed transaction as no money, at both places it is said', async () => {
    const failedInHistory = endpoint({
      getSignaturesForAddress: [{ signature: 'sig-1', err: { InstructionError: [0, 'x'] } }],
      getTransaction: transaction([], [balance('1000000')]),
    })
    expect(
      await httpDepositWatcher('http://rpc', failedInHistory.fetchImpl).transfersAt(ADDRESS),
    ).toEqual([])
    // It was never fetched: the history already said it moved nothing.
    expect(failedInHistory.calls.map((call) => call.method)).toEqual(['getSignaturesForAddress'])

    const failedInMeta = endpoint({
      getSignaturesForAddress: [{ signature: 'sig-1', err: null }],
      getTransaction: transaction([], [balance('1000000')], { InstructionError: [0, 'x'] }),
    })
    expect(
      await httpDepositWatcher('http://rpc', failedInMeta.fetchImpl).transfersAt(ADDRESS),
    ).toEqual([])
  })

  it('carries the token program it was told, so the wrong one is refused rather than credited', async () => {
    const { fetchImpl } = endpoint({
      getSignaturesForAddress: [{ signature: 'sig-1', err: null }],
      getTransaction: transaction([], [balance('1000000', { programId: TOKEN_2022 })]),
    })

    const [transfer] = await httpDepositWatcher('http://rpc', fetchImpl).transfersAt(ADDRESS)

    expect(transfer?.tokenProgram).toBe(TOKEN_2022)
    expect(depositRejection(transfer!)).toBe('wrong-token-program')
  })

  it('refuses rather than guesses when the endpoint omits the program', async () => {
    const { fetchImpl } = endpoint({
      getSignaturesForAddress: [{ signature: 'sig-1', err: null }],
      getTransaction: transaction([], [balance('1000000', { programId: undefined })]),
    })

    const [transfer] = await httpDepositWatcher('http://rpc', fetchImpl).transfersAt(ADDRESS)

    // Not credited on a guess. `wrong-token-program` is a rejection a sponsor
    // is told about, which is the recoverable direction.
    expect(depositRejection(transfer!)).toBe('wrong-token-program')
  })

  it('skips a transaction the endpoint has not finalized yet', async () => {
    const { fetchImpl } = endpoint({
      getSignaturesForAddress: [{ signature: 'sig-1', err: null }],
      getTransaction: null,
    })

    expect(await httpDepositWatcher('http://rpc', fetchImpl).transfersAt(ADDRESS)).toEqual([])
  })

  it('throws when the endpoint cannot answer, so the pass counts a failure', async () => {
    const down = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch

    // Silence here would be indistinguishable from *looked and found nothing*,
    // and the pass would report a clean run it never had.
    await expect(httpDepositWatcher('http://rpc', down).transfersAt(ADDRESS)).rejects.toThrow(
      'answered 503',
    )
  })

  it('throws when the endpoint reports an error in the body', async () => {
    const erroring = (async () =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'rate limited' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch

    await expect(httpDepositWatcher('http://rpc', erroring).transfersAt(ADDRESS)).rejects.toThrow(
      'rate limited',
    )
  })
})
