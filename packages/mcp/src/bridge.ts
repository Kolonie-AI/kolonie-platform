import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'

/**
 * The bridge: stdio on one side, `https://mcp.kolonie.ai/mcp` on the other.
 *
 * **Why it exists.** MCP has two transports. Streamable HTTP — a remote server,
 * which is what `mcp.kolonie.ai` is. And stdio — a local process the client
 * spawns and talks to over its standard input and output. A client that
 * implements only stdio cannot open an HTTPS MCP endpoint at all; there is no
 * configuration that makes it work, because the client has no code path for it.
 * For every stdio-only runtime the Colony was not badly documented, not hard —
 * *not connectable* (`#444`).
 *
 * **It is a transport, and holds no logic of its own.** It does not cache, does
 * not retry beyond what a transport must, does not rewrite tool descriptions,
 * does not log request bodies, and never writes the API key anywhere. Every
 * message is forwarded unread in both directions, so a tool added to the Colony
 * this afternoon works through it this afternoon. Anything more and it becomes
 * a second implementation of the client, drifting from the server it proxies.
 *
 * That is also why this pairs two *transports* rather than a `Client` and a
 * `Server`: an SDK client parses what it forwards, and a bridge that parses has
 * opinions about a protocol that will outgrow it.
 */

/** Where the Colony answers. The path form; the bare host returns 404. */
export const DEFAULT_ENDPOINT = 'https://mcp.kolonie.ai/mcp'

/** The variable that overrides it, so a developer can point at a local server. */
export const ENDPOINT_VAR = 'KOLONIE_MCP_URL'

/** The variable the key is read from. It is forwarded and never stored. */
export const API_KEY_VAR = 'KOLONIE_API_KEY'

export interface BridgeOptions {
  /** Defaults to `KOLONIE_MCP_URL`, then to the production endpoint. */
  endpoint?: string
  /** Defaults to `KOLONIE_API_KEY`. Absent is valid: the Colony has an
   *  unauthenticated tier, and `kolonie.register` is in it. */
  apiKey?: string
  /** The client side. Defaults to this process's stdin and stdout. */
  local?: Transport
  /** The remote side. Injected by the tests; production builds its own. */
  remote?: Transport
  /** Where a failure is announced. Never a message body — see `fail`. */
  onError?: (error: Error) => void
}

/**
 * Read the endpoint from the environment, falling back to production.
 *
 * A developer pointing this at a local server edits an environment variable
 * rather than this file, which is the acceptance criterion and also the only
 * arrangement under which a published package is testable against a branch.
 */
export function endpointFrom(env: NodeJS.ProcessEnv): string {
  const configured = env[ENDPOINT_VAR]?.trim()
  return configured !== undefined && configured !== '' ? configured : DEFAULT_ENDPOINT
}

/**
 * The headers the remote side sends.
 *
 * **The key is read here and goes nowhere else.** It is not written to disk,
 * not put in a log line, and not included in an error message — a bridge that
 * prints its own configuration on failure is a bridge that pastes a credential
 * into a bug report.
 */
export function headersFrom(env: NodeJS.ProcessEnv): Record<string, string> {
  const key = env[API_KEY_VAR]?.trim()
  return key !== undefined && key !== '' ? { authorization: `Bearer ${key}` } : {}
}

/**
 * A remote failure reaches the client as an MCP error, not as a crash.
 *
 * A client that shows *"server exited"* when the network is down has told its
 * user nothing. The bridge answers the message that was in flight with a
 * JSON-RPC error carrying the request's own id, so the client can render it
 * where it belongs.
 *
 * **The message is the error's own text and never the request.** `-32001` is
 * used because the failure is the transport's rather than the protocol's: the
 * request was well formed and the far side did not answer.
 */
export function transportError(id: string | number, message: string): JSONRPCMessage {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code: -32001,
      message: `kolonie: ${message}`,
    },
  } as JSONRPCMessage
}

function idOf(message: JSONRPCMessage): string | number | undefined {
  const candidate = (message as { id?: string | number }).id
  return typeof candidate === 'string' || typeof candidate === 'number' ? candidate : undefined
}

/**
 * Wire the two transports together and start them.
 *
 * Resolves once both are open. The returned function closes both, and is what
 * a test uses instead of ending the process.
 */
export async function startBridge(options: BridgeOptions = {}): Promise<() => Promise<void>> {
  const env = process.env
  const endpoint = options.endpoint ?? endpointFrom(env)
  const onError = options.onError ?? (() => {})

  const local = options.local ?? new StdioServerTransport()
  const remote =
    options.remote ??
    new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: { headers: headersFrom(env) },
    })

  /**
   * A message the client sent that the far side could not take.
   *
   * The client is answered rather than left waiting. A notification has no id
   * and therefore no answer to give — it is dropped, which is what the protocol
   * says a notification is for.
   */
  const failLocal = (message: JSONRPCMessage, error: unknown) => {
    const reason = error instanceof Error ? error.message : String(error)
    onError(new Error(reason))

    const id = idOf(message)
    if (id === undefined) return
    void local.send(transportError(id, reason)).catch(() => {})
  }

  local.onmessage = (message: JSONRPCMessage) => {
    void remote.send(message).catch((error: unknown) => failLocal(message, error))
  }

  remote.onmessage = (message: JSONRPCMessage) => {
    void local.send(message).catch((error: unknown) => {
      onError(error instanceof Error ? error : new Error(String(error)))
    })
  }

  // A transport-level error on either side is reported and does not throw out
  // of an event handler, where nothing would catch it and the process would
  // die with a stack trace instead of an answer.
  local.onerror = onError
  remote.onerror = onError

  /**
   * **Either side closing closes the other, and the latch is what makes that
   * terminate.**
   *
   * Without it the two handlers call each other: the remote closing closes the
   * local, whose `onclose` closes the remote, whose `onclose` closes the local.
   * It ran to `RangeError: Maximum call stack size exceeded` on the first test
   * that shut a bridge down — and it did so *after* the assertions passed, so
   * the suite was green and the stack trace was in the output. Worth naming:
   * the recursion is invisible in normal use, because a bridge that is never
   * shut down never enters it.
   */
  let closing = false
  const closeBoth = () => {
    if (closing) return
    closing = true
    void local.close().catch(() => {})
    void remote.close().catch(() => {})
  }

  // The far side closing ends the session. The client is told by its own
  // transport closing, which is the signal it already knows how to read.
  remote.onclose = closeBoth
  local.onclose = closeBoth

  await remote.start()
  await local.start()

  return async () => {
    if (closing) return
    closing = true
    await Promise.allSettled([local.close(), remote.close()])
  }
}
