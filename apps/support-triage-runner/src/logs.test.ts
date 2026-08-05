import { describe, expect, it } from 'vitest'
import { silentLog } from '@kolonie-ai/core'
import { lokiLogs, signatureOf, SAMPLE_LINES } from './logs.js'

/**
 * The queries this seam sends, captured.
 *
 * **These tests are about the text of the query and not about the answer**
 * (`#435`). One unparseable line anywhere in the window made Loki answer 400 for
 * the whole query, and the runner caught it by design — so the log half of the
 * runner filed nothing at all from `#407` until `#435`, and nothing looked
 * wrong. What is pinned here is the one property that failure had no way to
 * announce: a `| json` with no error filter after it.
 */
function capturing(body: unknown = { data: { result: [] } }): {
  queries: string[]
  fetchImpl: typeof fetch
} {
  const queries: string[] = []
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input))
    const query = url.searchParams.get('query')
    if (query !== null) queries.push(query)
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch

  return { queries, fetchImpl }
}

const options = (fetchImpl: typeof fetch) => ({
  url: 'http://loki:3100',
  user: '',
  token: '',
  log: silentLog,
  fetchImpl,
  now: () => Date.parse('2026-08-06T12:00:00.000Z'),
})

describe('every query that parses JSON skips the lines it cannot parse', () => {
  it('the counting query filters parser errors', async () => {
    const { queries, fetchImpl } = capturing()
    await lokiLogs(options(fetchImpl)).signatures(3600)

    expect(queries).toHaveLength(1)
    expect(queries[0]).toContain('| json | __error__=""')
  })

  it('the evidence query filters parser errors before it matches the event', async () => {
    const { queries, fetchImpl } = capturing()
    await lokiLogs(options(fetchImpl)).evidence(
      {
        signature: signatureOf('api', 'poll.failed'),
        service: 'api',
        event: 'poll.failed',
        count: 3,
      },
      3600,
    )

    expect(queries[0]).toContain('| json | __error__="" | event="poll.failed"')
  })

  it('the last-start query filters parser errors', async () => {
    const { queries, fetchImpl } = capturing()
    await lokiLogs(options(fetchImpl)).lastStart('api', '2026-08-06T11:00:00.000Z')

    expect(queries[0]).toContain('| json | __error__=""')
  })

  /**
   * The invariant, rather than three assertions about three lines. A fourth
   * query added later without the filter fails here, which is where `#435`
   * would have been caught: the defect was not in any one of the three, it was
   * in what all three had in common.
   */
  it('no query anywhere in the seam parses JSON without the filter', async () => {
    const { queries, fetchImpl } = capturing()
    const logs = lokiLogs(options(fetchImpl))

    await logs.signatures(3600)
    await logs.evidence(
      {
        signature: signatureOf('api', 'poll.failed'),
        service: 'api',
        event: 'poll.failed',
        count: 3,
      },
      3600,
    )
    await logs.evidence(
      {
        signature: signatureOf('traefik', '«no event field»'),
        service: 'traefik',
        event: '«no event field»',
        count: 3,
      },
      3600,
    )
    await logs.lastStart('api', '2026-08-06T11:00:00.000Z')

    expect(queries.length).toBeGreaterThan(3)
    for (const query of queries) {
      if (!query.includes('| json')) continue
      expect(query, query).toMatch(/\| json \| __error__=""/)
    }
  })

  /**
   * The rejection case, and it is the shape of the original defect: a store that
   * answers 400 must leave the runner with nothing rather than with a wrong
   * something. The catch is what hid `#435` for as long as it hid, so it is
   * worth pinning that it is a catch and not a crash.
   */
  it('a store that refuses the query yields no signatures and no evidence', async () => {
    const refusing = (async () =>
      new Response('pipeline error: JSONParserErr', { status: 400 })) as unknown as typeof fetch
    const logs = lokiLogs(options(refusing))

    expect(await logs.signatures(3600)).toEqual([])
    expect(
      await logs.evidence(
        {
          signature: signatureOf('api', 'poll.failed'),
          service: 'api',
          event: 'poll.failed',
          count: 3,
        },
        3600,
      ),
    ).toEqual({ firstAt: null, lastAt: null, samples: [] })
    expect(await logs.lastStart('api', '2026-08-06T11:00:00.000Z')).toBeNull()
  })

  it('the evidence query asks for no more lines than it will show', async () => {
    const { queries, fetchImpl } = capturing()
    const captured: string[] = []
    const spy = (async (input: string | URL | Request, init?: RequestInit) => {
      captured.push(new URL(String(input)).searchParams.get('limit') ?? '')
      return fetchImpl(input as never, init as never)
    }) as unknown as typeof fetch

    await lokiLogs(options(spy)).evidence(
      {
        signature: signatureOf('api', 'poll.failed'),
        service: 'api',
        event: 'poll.failed',
        count: 3,
      },
      3600,
    )

    void queries
    expect(captured[0]).toBe(String(SAMPLE_LINES))
  })
})
