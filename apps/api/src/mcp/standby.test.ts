import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, describe, expect, it } from 'vitest'
import { fakeColony } from '../__fixtures__/colony/index.js'
import { mcpStandbyStreams } from './standby.js'

/**
 * The standby stream, end to end (`#1916`).
 *
 * **Against a real socket and a real client**, because every part of this is a
 * property of the transport rather than of a function: whether `GET` with
 * `Accept: text/event-stream` is answered with a stream at all, whether the
 * handshake on it advertises the capability, and whether a notification pushed
 * from the server reaches a client that is sitting still. A fake would assert
 * that this file calls the SDK, which is not the question.
 */
describe('the standby stream a persistent citizen holds open', () => {
  let server: Server | undefined
  let standby: ReturnType<typeof mcpStandbyStreams> | undefined

  afterEach(async () => {
    await standby?.closeAll()
    await new Promise<void>((resolve) => {
      if (server === undefined) return resolve()
      server.close(() => resolve())
    })
    server = undefined
    standby = undefined
  })

  /** One HTTP server serving both MCP doors, as the route module wires them. */
  const listening = async (): Promise<URL> => {
    const streams = mcpStandbyStreams()
    standby = streams

    const node = createServer((request, response) => {
      if (
        request.method === 'GET' &&
        (request.headers.accept ?? '').includes('text/event-stream')
      ) {
        void streams.open(fakeColony(), undefined, undefined, false, request, response)
        return
      }

      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        void import('./transport.js').then(({ handleMcpRequest }) =>
          handleMcpRequest(
            fakeColony(),
            undefined,
            undefined,
            false,
            request,
            response,
            chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString('utf8')),
            true,
          ),
        )
      })
    })

    server = node
    await new Promise<void>((resolve) => node.listen(0, '127.0.0.1', resolve))
    const { port } = node.address() as AddressInfo

    return new URL(`http://127.0.0.1:${port}/mcp`)
  }

  /**
   * Wait until the client's standby stream has actually reached the server.
   *
   * A conformant client opens it *after* its `initialized` notification is
   * accepted, so it is not open when `connect()` resolves. Polling rather than
   * sleeping a fixed time: the wait is over when the condition holds, and a
   * fixed sleep is either slower than it needs to be or flaky on a loaded host.
   */
  const streamsOpen = async (count: number): Promise<void> => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (standby?.open_count === count) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(standby?.open_count).toBe(count)
  }

  it('accepts and maintains a standard MCP stream, and says so in the handshake', async () => {
    const endpoint = await listening()
    const client = new Client({ name: 'persistent', version: '0' })
    await client.connect(new StreamableHTTPClientTransport(endpoint))

    const capabilities = client.getServerCapabilities() as Record<string, unknown>
    const tools = capabilities['tools'] as Record<string, unknown> | undefined

    expect(tools?.['listChanged']).toBe(true)
    await streamsOpen(1)

    await client.close()
  })

  /**
   * The acceptance criterion in full: connect, mutate the catalogue, and see the
   * client refresh without anything dropping the session.
   */
  it('delivers list_changed to a connected client, which then refreshes its tools', async () => {
    const endpoint = await listening()
    const client = new Client({ name: 'persistent', version: '0' })

    const told = new Promise<void>((resolve) => {
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => resolve())
    })

    await client.connect(new StreamableHTTPClientTransport(endpoint))
    await streamsOpen(1)
    await standby?.notifyToolsChanged()
    await told

    // The refresh a runtime performs on being told, over the same connection.
    const { tools } = await client.listTools()
    expect(tools.length).toBeGreaterThan(0)

    await client.close()
  })

  /** A stream the client dropped is forgotten rather than retried forever. */
  it('drops a stream whose client has gone, and keeps broadcasting to the rest', async () => {
    const endpoint = await listening()
    const leaving = new Client({ name: 'leaving', version: '0' })
    const staying = new Client({ name: 'staying', version: '0' })

    const told = new Promise<void>((resolve) => {
      staying.setNotificationHandler(ToolListChangedNotificationSchema, () => resolve())
    })

    await leaving.connect(new StreamableHTTPClientTransport(endpoint))
    await staying.connect(new StreamableHTTPClientTransport(endpoint))
    await streamsOpen(2)

    await leaving.close()
    await streamsOpen(1)

    await standby?.notifyToolsChanged()
    await told

    await staying.close()
  })
})
