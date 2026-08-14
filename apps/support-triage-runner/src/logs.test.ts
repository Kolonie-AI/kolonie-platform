import { describe, expect, it } from 'vitest'
import { silentLog } from '@kolonie-ai/core'
import {
  causeChain,
  CAUSE_MESSAGE_LENGTH,
  lokiLogs,
  MAX_CAUSE_DEPTH,
  signatureOf,
  SAMPLE_LINES,
} from './logs.js'

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
        route: null,
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
        route: null,
        count: 3,
      },
      3600,
    )
    await logs.evidence(
      {
        signature: signatureOf('traefik', '«no event field»'),
        service: 'traefik',
        event: '«no event field»',
        route: null,
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
          route: null,
          count: 3,
        },
        3600,
      ),
    ).toEqual({ firstAt: null, lastAt: null, samples: [], causes: [] })
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
        route: null,
        count: 3,
      },
      3600,
    )

    void queries
    expect(captured[0]).toBe(String(SAMPLE_LINES))
  })
})

/**
 * One endpoint is one defect (`#896`).
 *
 * `api` logs one event — `request.failed` — for every failing endpoint it has,
 * so on `<service>/<event>` alone the whole API is one signature. The
 * measurement: `#896`, a failed query on `GET /v1/agents/me`, was filed as a
 * *regression* of `#764`, a payout balance check answering 522. Worse than the
 * mislabel is what the dedupe does with it — while either is open, a genuinely
 * new endpoint failure is quiet.
 */
describe('an HTTP failure is keyed on the route it failed', () => {
  const counting = (result: unknown) =>
    capturing({
      data: {
        result,
      },
    })

  it('two endpoints failing are two signatures', async () => {
    const { fetchImpl } = counting([
      {
        metric: { service: 'api', event: 'request.failed', route: '/v1/agents/me' },
        value: [0, '1'],
      },
      {
        metric: { service: 'api', event: 'request.failed', route: '/v1/payouts/run' },
        value: [0, '2'],
      },
    ])

    const found = await lokiLogs(options(fetchImpl)).signatures(3600)

    expect(found.map((one) => one.signature)).toEqual([
      'api/request.failed /v1/agents/me',
      'api/request.failed /v1/payouts/run',
    ])
  })

  it('asks the store to count by route, or nothing above could be true', async () => {
    const { queries, fetchImpl } = counting([])
    await lokiLogs(options(fetchImpl)).signatures(3600)

    expect(queries[0]).toContain('sum by (service, event, route)')
  })

  /**
   * The rejection case, and it is the ordinary one: a runner's `poll.failed`
   * has no route, and a key that invented one for it would draw a distinction
   * the line does not make. Loki renders an absent label as an empty string.
   */
  it('a line with no route keys exactly as it did before', async () => {
    const { fetchImpl } = counting([
      { metric: { service: 'verifier-runner', event: 'poll.failed' }, value: [0, '3'] },
      { metric: { service: 'api', event: 'request.failed', route: '' }, value: [0, '1'] },
    ])

    const found = await lokiLogs(options(fetchImpl)).signatures(3600)

    expect(found.map((one) => one.signature)).toEqual([
      'verifier-runner/poll.failed',
      'api/request.failed',
    ])
    expect(found.every((one) => one.route === null)).toBe(true)
  })

  it('the evidence for one route is not sampled from another', async () => {
    const { queries, fetchImpl } = capturing()
    await lokiLogs(options(fetchImpl)).evidence(
      {
        signature: signatureOf('api', 'request.failed', '/v1/agents/me'),
        service: 'api',
        event: 'request.failed',
        route: '/v1/agents/me',
        count: 1,
      },
      3600,
    )

    expect(queries[0]).toContain('| event="request.failed" | route="/v1/agents/me"')
  })

  it('a signature with no route asks for no route', async () => {
    const { queries, fetchImpl } = capturing()
    await lokiLogs(options(fetchImpl)).evidence(
      {
        signature: signatureOf('api', 'poll.failed'),
        service: 'api',
        event: 'poll.failed',
        route: null,
        count: 1,
      },
      3600,
    )

    expect(queries[0]).not.toContain('route=')
  })
})

/**
 * Reading the cause off a line before the line is truncated (`#898`).
 *
 * The case is `#895`: two samples cut at the same column, both of them mid-SQL,
 * and `42809` — the one field that says what was actually wrong — in neither
 * issue. What is pinned here is that the chain is read from the whole line, and
 * that the odd shapes a `cause` can hold produce a row rather than an exception.
 */
describe('the cause chain', () => {
  const lineWith = (err: unknown): string =>
    JSON.stringify({ level: 'error', service: 'api', event: 'mcp.tool.threw', err })

  it('carries the cause of a query that failed, whatever length the message is', () => {
    const line = lineWith({
      name: 'Error',
      message: `Failed query: select ${'"column", '.repeat(80)}from "provider_recipes"`,
      cause: {
        name: 'PostgresError',
        code: '42809',
        message: 'op ANY/ALL (array) requires array on right side',
      },
    })

    expect(causeChain(line)).toEqual([
      {
        name: 'PostgresError',
        code: '42809',
        message: 'op ANY/ALL (array) requires array on right side',
      },
    ])
  })

  it('follows a nested chain, and stops where the logger stopped serialising it', () => {
    const nest = (depth: number): unknown =>
      depth === 0
        ? { name: 'Deepest', message: 'the bottom' }
        : { name: `L${depth}`, message: `at ${depth}`, cause: nest(depth - 1) }

    const chain = causeChain(lineWith({ name: 'Error', message: 'outer', cause: nest(8) }))

    expect(chain).toHaveLength(MAX_CAUSE_DEPTH)
    expect(chain[0]?.name).toBe('L8')
  })

  /** The rejection case: most errors have no cause, and file what they filed before. */
  it('an error with no cause has no chain — not a row of nothings', () => {
    expect(causeChain(lineWith({ name: 'ZodError', message: 'invalid' }))).toEqual([])
    expect(causeChain(JSON.stringify({ level: 'error', event: 'poll.failed' }))).toEqual([])
  })

  /**
   * The rejection case that would cost the most. This runs inside the pass that
   * reports every other signature, so a `cause` that is a string, a number or an
   * object with none of the expected fields must not throw.
   */
  it('a cause that is not an object does not throw, and says what it was', () => {
    expect(
      causeChain(lineWith({ name: 'Error', message: 'm', cause: 'the socket closed' })),
    ).toEqual([{ name: null, code: null, message: 'the socket closed' }])
    expect(causeChain(lineWith({ name: 'Error', message: 'm', cause: 42 }))).toEqual([
      { name: null, code: null, message: '42' },
    ])
    expect(causeChain(lineWith({ name: 'Error', message: 'm', cause: { odd: true } }))).toEqual([
      { name: null, code: null, message: null },
    ])
    expect(causeChain(lineWith({ name: 'Error', message: 'm', cause: null }))).toEqual([])
  })

  it('a line that is not JSON at all is a line with no chain', () => {
    expect(causeChain('    at Object.<anonymous> (/app/dist/main.js:1:1)')).toEqual([])
    expect(causeChain('')).toEqual([])
  })

  /**
   * A client that cannot reach its server quotes the connection string, and a
   * connection string carries a password. The writer redacts the hosts it was
   * configured with; nothing configured this reader, so it quotes no URL at all.
   */
  it('a URL in a cause message is not quoted', () => {
    const chain = causeChain(
      lineWith({
        name: 'Error',
        message: 'm',
        cause: {
          name: 'ConnectionError',
          code: 'ECONNREFUSED',
          message: 'could not connect to postgres://someone:letmein@somewhere/db now',
        },
      }),
    )

    expect(chain[0]?.message).toBe('could not connect to <url> now')
    expect(chain[0]?.message).not.toContain('letmein')
  })

  it('a message long enough to be a document is bounded', () => {
    const chain = causeChain(
      lineWith({ name: 'Error', message: 'm', cause: { name: 'X', message: 'y'.repeat(5_000) } }),
    )

    expect(chain[0]?.message?.length).toBeLessThanOrEqual(CAUSE_MESSAGE_LENGTH + 20)
    expect(chain[0]?.message).toContain('truncated')
  })
})
