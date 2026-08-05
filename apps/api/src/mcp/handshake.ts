import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'

/**
 * The handshake stops promising a notification nothing can send (`#386`).
 *
 * ## What was wrong
 *
 * `initialize` answered `"capabilities": {"tools": {"listChanged": true}}` and a
 * search across `apps/api/src/mcp/` found no emission of
 * `notifications/tools/list_changed` anywhere. The flag came from the SDK, which
 * sets it because tools are registered — not because anything ever fires.
 *
 * **That is worse than not supporting it.** A client that does not see the
 * capability polls, or does nothing, and is correct either way. A client that
 * sees it is entitled to wait for a signal that will never arrive, and nothing
 * in the answer tells it otherwise.
 *
 * ## Why the answer is to stop advertising rather than to start sending
 *
 * **There is no stream to send it on, by a decision this does not reopen.**
 * `transport.ts` builds a fresh server and a fresh `StreamableHTTPServerTransport`
 * per request with `sessionIdGenerator: undefined`, and closes both when the
 * response ends. Its own reasoning is that the API runs as a container that can
 * be replaced mid-deploy, *"and a session held in one process's memory would
 * break the moment it is"*. So at the instant a citizen's tier changes there is
 * no open connection belonging to it anywhere: the request that changed it is
 * already being torn down, and the next one has not arrived.
 *
 * Sending it would therefore mean holding server-side sessions, which is a
 * different architecture with a different failure mode, decided against for
 * reasons that have nothing to do with this capability. **Advertising a promise
 * whose delivery depends on reversing an unrelated decision is not support.**
 *
 * ## What replaces it, so the citizen is not left guessing
 *
 * D-013 already recomputes the list per request, so a citizen whose tier changed
 * gets the right list the moment it reconnects. What it lacked was any way to
 * know it should. The answers that change a tier now say so — see
 * `LIST_IS_STALE` in `text/wakeup.ts` — which is the same shape
 * `kolonie-docs#159` settles for everything else the Colony knows and the
 * citizen would otherwise have to poll for.
 *
 * ## Why it is pruned from the answer rather than configured
 *
 * The SDK derives this flag from the fact that tools are registered and offers
 * no way to say otherwise. The transport's `send` is the one seam every caller
 * passes through, and it is where `#382` already shapes what is published — so
 * the handshake a test sees is the handshake a citizen gets.
 */

/** An `initialize` result with the promise it cannot keep removed. */
const honestInitialize = (message: JSONRPCMessage): JSONRPCMessage => {
  if (!('result' in message) || message.result === undefined) return message

  const result = message.result as Record<string, unknown>
  const capabilities = result['capabilities']
  if (capabilities === null || typeof capabilities !== 'object') return message

  const tools = (capabilities as Record<string, unknown>)['tools']
  if (tools === null || typeof tools !== 'object' || !('listChanged' in tools)) return message

  const { listChanged: _dropped, ...rest } = tools as Record<string, unknown>

  return {
    ...message,
    result: { ...result, capabilities: { ...capabilities, tools: rest } },
  } as JSONRPCMessage
}

/**
 * Make this server's handshake say only what it can do.
 *
 * Called once by `createMcpServer`, beside `publishLeanSchemas` and for the same
 * reason: the rule is about what leaves the server, so it belongs on the seam
 * everything leaves through rather than at any one registration.
 */
export function advertiseOnlyWhatIsSent(server: McpServer): void {
  const connect = server.connect.bind(server)

  server.connect = async (transport: Transport, ...rest: unknown[]): Promise<void> => {
    const send = transport.send.bind(transport)
    transport.send = (message, options) => send(honestInitialize(message), options)
    return connect(transport, ...(rest as []))
  }
}
