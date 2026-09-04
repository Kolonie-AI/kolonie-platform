import { describe, expect, it, vi } from 'vitest'
import { httpPayoutChain } from './payout-chain.js'
import { ChainUnreachableError } from './payouts.js'

const URL = 'https://rpc.example/'

/** A JSON-RPC answer the reader accepts, so a test only has to vary the failures. */
const ok = (result: unknown): Response =>
  new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

const status = (code: number): Response => new Response('', { status: code })

/**
 * A `fetch` that answers a queue, then repeats its last answer forever.
 *
 * Repeating rather than running out: a test about giving up after three tries
 * should fail because the code gave up, not because the fake did.
 */
function queue(...answers: readonly Response[]): {
  readonly fetch: typeof fetch
  readonly calls: () => number
} {
  let n = 0
  const fetchImpl = (async () => {
    const answer = answers[Math.min(n, answers.length - 1)]
    n += 1
    return (answer as Response).clone()
  }) as unknown as typeof fetch

  return { fetch: fetchImpl, calls: () => n }
}

describe('the payout chain reader', () => {
  it('retries a Cloudflare 522 and returns the answer it eventually gets', async () => {
    // The exact shape of `#764`: one 522 in front of the RPC provider, which
    // 500'd a whole payout run because nothing asked twice.
    const q = queue(status(522), ok({ value: 42 }))
    const chain = httpPayoutChain(URL, q.fetch)

    await expect(chain.balance('an-address')).resolves.toBe(42)
    expect(q.calls()).toBe(2)
  })

  it('gives up as unreachable rather than as an ordinary error', async () => {
    const q = queue(status(522))
    const chain = httpPayoutChain(URL, q.fetch)

    await expect(chain.balance('an-address')).rejects.toBeInstanceOf(ChainUnreachableError)
    // Three tries and no more: the real retry is the timer's next pass.
    expect(q.calls()).toBe(3)
  })

  it('retries an HTTP 500 and returns the answer it eventually gets', async () => {
    const q = queue(status(500), ok({ value: 42 }))
    const chain = httpPayoutChain(URL, q.fetch)

    await expect(chain.balance('an-address')).resolves.toBe(42)
    expect(q.calls()).toBe(2)
  })

  it('gives up after three HTTP 500 answers as unreachable', async () => {
    const q = queue(status(500))
    const chain = httpPayoutChain(URL, q.fetch)

    await expect(chain.balance('an-address')).rejects.toBeInstanceOf(ChainUnreachableError)
    expect(q.calls()).toBe(3)
  })

  it.each([408, 429, 502, 503, 504, 520, 529])('retries %i', async (code) => {
    const q = queue(status(code), ok({ value: 1 }))
    await expect(httpPayoutChain(URL, q.fetch).balance('an-address')).resolves.toBe(1)
    expect(q.calls()).toBe(2)
  })

  it('does not retry an answer that would say the same thing again', async () => {
    // A 400 is this repository's own bug. Retrying it would turn a bug into a
    // slow bug, and it must not arrive as `unreachable` either — that would let
    // a real defect be reported as the world being flaky.
    const q = queue(status(400))
    const chain = httpPayoutChain(URL, q.fetch)

    await expect(chain.balance('an-address')).rejects.not.toBeInstanceOf(ChainUnreachableError)
    expect(q.calls()).toBe(1)
  })

  it('treats a fetch that never reached anybody as unreachable', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch

    await expect(httpPayoutChain(URL, fetchImpl).balance('an-address')).rejects.toBeInstanceOf(
      ChainUnreachableError,
    )
  })

  /**
   * **The one call that must not be retried.**
   *
   * A `sendTransaction` whose response was lost may well have been accepted by
   * the cluster. The safe retry is the payout runner's own, against an
   * obligation it can see; a retry decided here can see neither.
   */
  it('never retries the write', async () => {
    const q = queue(status(500))
    const chain = httpPayoutChain(URL, q.fetch)

    await expect(chain.send('a-transaction')).rejects.toBeInstanceOf(ChainUnreachableError)
    expect(q.calls()).toBe(1)
  })

  it('falls back for the rent minimum only after it has retried', async () => {
    const q = queue(status(503))
    const chain = httpPayoutChain(URL, q.fetch)

    // The fallback exists so a caller has a number to refuse against, and it is
    // still right here — but it is reached after three tries, not on the first.
    await expect(chain.rentExemptMinimum()).resolves.toBeTypeOf('number')
    expect(q.calls()).toBe(3)
  })
})

// The backoff is real time, and three tries of it is 1.25s. Kept honest rather
// than mocked: the numbers are small on purpose and the suite can afford them.
vi.setConfig({ testTimeout: 15_000 })
