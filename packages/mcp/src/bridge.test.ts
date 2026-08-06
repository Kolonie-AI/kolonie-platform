import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import {
  API_KEY_VAR,
  DEFAULT_ENDPOINT,
  ENDPOINT_VAR,
  endpointFrom,
  headersFrom,
  startBridge,
  transportError,
} from './bridge.js'

/**
 * The bridge, against a stub server rather than against the Colony (`#444`).
 *
 * A test that reaches `mcp.kolonie.ai` measures the Colony's uptime, not this
 * package. The stub speaks just enough streamable HTTP to answer, which is all
 * a transport has to be handed.
 */

/** A transport that records what it was given, standing in for the client. */
class FakeLocal implements Transport {
  sent: JSONRPCMessage[] = []
  closed = false
  onmessage?: (message: JSONRPCMessage) => void
  onerror?: (error: Error) => void
  onclose?: () => void

  async start(): Promise<void> {}
  async send(message: JSONRPCMessage): Promise<void> {
    this.sent.push(message)
  }
  async close(): Promise<void> {
    this.closed = true
    this.onclose?.()
  }
  /** What the client would have written to the bridge's stdin. */
  receive(message: JSONRPCMessage): void {
    this.onmessage?.(message)
  }
}

describe('the endpoint', () => {
  it('defaults to production and is overridden by one variable', () => {
    expect(endpointFrom({})).toBe(DEFAULT_ENDPOINT)
    expect(endpointFrom({ [ENDPOINT_VAR]: 'http://127.0.0.1:9/mcp' })).toBe(
      'http://127.0.0.1:9/mcp',
    )
    // An empty or whitespace value is a variable somebody meant to unset, not
    // an instruction to connect to nothing.
    expect(endpointFrom({ [ENDPOINT_VAR]: '   ' })).toBe(DEFAULT_ENDPOINT)
  })

  it('names the path form, because the bare host answers 404', () => {
    expect(DEFAULT_ENDPOINT).toBe('https://mcp.kolonie.ai/mcp')
  })
})

describe('the API key', () => {
  it('is forwarded as a bearer header and nowhere else', () => {
    expect(headersFrom({ [API_KEY_VAR]: 'kol_secret' })).toEqual({
      authorization: 'Bearer kol_secret',
    })
  })

  it('is absent rather than empty when unset', () => {
    // Absent is valid: the Colony has an unauthenticated tier and
    // `kolonie.register` is in it. An `Authorization: Bearer ` header would
    // turn "I have not registered yet" into "my credential is malformed".
    expect(headersFrom({})).toEqual({})
    expect(headersFrom({ [API_KEY_VAR]: '' })).toEqual({})
  })

  it('never appears in an error the bridge produces', () => {
    const error = transportError(1, 'fetch failed')
    expect(JSON.stringify(error)).not.toContain('kol_secret')
    expect(JSON.stringify(error)).toContain('fetch failed')
  })
})

describe('the bridge, end to end against a stub', () => {
  let server: Server
  let endpoint: string
  let requests: { headers: Record<string, string | string[] | undefined>; body: string }[]
  /** What the stub answers with; a test replaces it to force a failure. */
  let respond: (body: string) => { status: number; payload: string }
  let stop: (() => Promise<void>) | undefined
  let local: FakeLocal

  beforeEach(async () => {
    requests = []
    respond = (body) => {
      const request = JSON.parse(body) as { id?: number; method?: string }
      return {
        status: 200,
        payload: JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: { tools: [{ name: 'kolonie.about', inputSchema: { type: 'object' } }] },
        }),
      }
    }

    server = createServer((request, response) => {
      let body = ''
      request.on('data', (chunk) => (body += chunk))
      request.on('end', () => {
        requests.push({ headers: request.headers, body })
        const answer = respond(body)
        response.writeHead(answer.status, { 'content-type': 'application/json' })
        response.end(answer.payload)
      })
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`
    local = new FakeLocal()
  })

  afterEach(async () => {
    await stop?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('forwards a request to the remote and the answer back', async () => {
    stop = await startBridge({ endpoint, local })

    local.receive({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} } as JSONRPCMessage)
    await vi.waitFor(() => expect(local.sent.length).toBeGreaterThan(0))

    expect(JSON.parse(requests[0]!.body)).toMatchObject({ method: 'tools/list', id: 1 })

    // **The same tool set as a direct HTTP call to the same endpoint**, which
    // is the criterion `#444` states and is stronger than *the answer came
    // back*: the bridge is compared against the thing it stands in for, so a
    // future version that rewrote a description would fail here.
    const direct = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })

    const bridged = local.sent[0] as unknown as { result: { tools: unknown } }
    expect(bridged.result.tools).toEqual(
      ((await direct.json()) as { result: { tools: unknown } }).result.tools,
    )
    expect(bridged.result.tools).toEqual([
      { name: 'kolonie.about', inputSchema: { type: 'object' } },
    ])
  })

  it('carries the key the environment gave it', async () => {
    process.env[API_KEY_VAR] = 'kol_test_key'
    try {
      stop = await startBridge({ endpoint, local })
      local.receive({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} } as JSONRPCMessage)
      await vi.waitFor(() => expect(requests.length).toBeGreaterThan(0))

      expect(requests[0]!.headers['authorization']).toBe('Bearer kol_test_key')
    } finally {
      delete process.env[API_KEY_VAR]
    }
  })

  /**
   * The rejection case `#444` asks for.
   *
   * A missing or rejected key must produce a clean MCP error rather than an
   * unhandled exception. A client that shows *"server exited"* when the far
   * side refuses has told its user nothing at all.
   */
  it('turns a rejected key into an MCP error rather than a crash', async () => {
    respond = () => ({
      status: 401,
      payload: JSON.stringify({ code: 'unauthorized', message: 'no credential' }),
    })

    const errors: Error[] = []
    stop = await startBridge({ endpoint, local, onError: (error) => errors.push(error) })

    local.receive({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} } as JSONRPCMessage)
    await vi.waitFor(() => expect(local.sent.length).toBeGreaterThan(0))

    const answer = local.sent[0] as { id?: number; error?: { code: number; message: string } }
    expect(answer.id).toBe(7)
    expect(answer.error?.code).toBe(-32001)
    expect(answer.error?.message).toContain('kolonie:')
    expect(errors.length).toBeGreaterThan(0)
  })

  it('turns an unreachable server into an MCP error rather than a crash', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    server = createServer()

    stop = await startBridge({ endpoint, local, onError: () => {} })
    local.receive({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} } as JSONRPCMessage)
    await vi.waitFor(() => expect(local.sent.length).toBeGreaterThan(0))

    expect(local.sent[0]).toMatchObject({ id: 9, error: { code: -32001 } })
  })

  it('drops a failed notification rather than answering one', async () => {
    respond = () => ({ status: 500, payload: '{}' })

    stop = await startBridge({ endpoint, local, onError: () => {} })
    // A notification has no id and so has no answer to give. Inventing one
    // would put a response on the wire that the client never asked for.
    local.receive({ jsonrpc: '2.0', method: 'notifications/initialized' } as JSONRPCMessage)
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(local.sent).toEqual([])
  })
})

describe('shutting down', () => {
  /**
   * The regression test for a stack overflow that a green suite hid.
   *
   * `remote.onclose` closed the local transport and `local.onclose` closed the
   * remote one, so either close recursed until the stack ran out. Every
   * assertion above still passed — the failure arrived after them, in teardown,
   * as a `RangeError` printed beside a green summary.
   */
  it('closes each side exactly once', async () => {
    const closes: string[] = []
    const side = (name: string): Transport => {
      const transport: Transport = {
        start: async () => {},
        send: async () => {},
        close: async () => {
          closes.push(name)
          transport.onclose?.()
        },
      }
      return transport
    }

    const local = side('local')
    const remote = side('remote')
    const stop = await startBridge({ endpoint: 'http://127.0.0.1:1/mcp', local, remote })

    await stop()
    expect(closes).toEqual(['local', 'remote'])

    // And a second stop is not a second close.
    await stop()
    expect(closes).toEqual(['local', 'remote'])
  })
})
