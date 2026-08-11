import { describe, expect, it } from 'vitest'
import { REACHES, Unreachable, reachableFetch } from './reachable.js'

/** What undici actually throws, cause chain and all. It is the shape `#648` recorded. */
function fetchFailed(): Error {
  const cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
  return new TypeError('fetch failed', { cause })
}

describe('reaching a named service', () => {
  /**
   * The whole of `#648`: `ticket.triage.failed` carried `TypeError: fetch failed`
   * and named none of the four things this process talks to, so a transient
   * failure could not be told from a misconfiguration.
   */
  it('names what could not be reached, and keeps the reason underneath it', async () => {
    const doFetch = (async () => {
      throw fetchFailed()
    }) as unknown as typeof fetch

    const failure = await reachableFetch(
      REACHES.github,
      doFetch,
    )('https://example.invalid').then(
      () => undefined,
      (error: unknown) => error,
    )

    expect(failure).toBeInstanceOf(Unreachable)
    expect((failure as Error).message).toBe(
      'GitHub could not be reached: fetch failed ← connect ECONNREFUSED (ECONNREFUSED)',
    )
    // The original is kept as the cause, so the serialised log line still has the
    // stack that says which socket it was.
    expect((failure as Error).cause).toBeInstanceOf(TypeError)
  })

  it('tells the three services apart', async () => {
    const failing = (what: string) =>
      reachableFetch(what, (async () => {
        throw fetchFailed()
      }) as unknown as typeof fetch)('https://example.invalid').catch(
        (error: unknown) => (error as Error).message,
      )

    expect(await failing(REACHES.model)).toContain('the model endpoint could not be reached')
    expect(await failing(REACHES.logs)).toContain('the log store could not be reached')
  })

  /**
   * An answer that says no is an answer. Every caller reads `response.ok` and
   * says something better about a status than this could — wrapping one here
   * would replace a specific message with a vaguer one.
   */
  it('passes a refusal through untouched rather than calling it unreachable', async () => {
    const refusal = new Response('no', { status: 503 })
    const doFetch = (async () => refusal) as unknown as typeof fetch

    await expect(reachableFetch(REACHES.github, doFetch)('https://example.invalid')).resolves.toBe(
      refusal,
    )
  })

  it('does not retry: one call in, one call out', async () => {
    let calls = 0
    const doFetch = (async () => {
      calls++
      throw fetchFailed()
    }) as unknown as typeof fetch

    await reachableFetch(REACHES.logs, doFetch)('https://example.invalid').catch(() => undefined)

    expect(calls).toBe(1)
  })
})
