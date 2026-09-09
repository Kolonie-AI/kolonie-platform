import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'

/**
 * The handshake promises `listChanged` exactly where something sends it
 * (`#386`, `#1916`).
 *
 * ## What was wrong, and what D-101 decided
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
 * So D-101 pruned the flag, on the argument that a per-request transport built
 * with `sessionIdGenerator: undefined` has no open connection to send it on.
 * That argument is still exactly right about a per-request transport, and this
 * still prunes it there.
 *
 * ## What changed, and what did not
 *
 * `#1916` adds a standby stream — `standby.ts` — which is server-to-client only
 * and stays open. On one of those the notification is deliverable, so the flag
 * is kept: the rule was never *never promise this*, it was **promise it exactly
 * where it is kept**, and D-101 named this reversal itself.
 *
 * **The pruning is therefore about the transport rather than the server.** One
 * `createMcpServer` serves both, and it is the connection that decides — a POST
 * that answers one request and closes still says nothing it cannot do.
 *
 * ## Why it is pruned from the answer rather than configured
 *
 * The SDK derives this flag from the fact that tools are registered and offers
 * no way to say otherwise. The transport's `send` is the one seam every caller
 * passes through, and it is where `#382` already shapes what is published — so
 * the handshake a test sees is the handshake a citizen gets.
 *
 * ## What still stands
 *
 * `LIST_IS_STALE` in `text/wakeup.ts` says the same thing in the digest, and it
 * stays: a citizen that never opens a standby stream reads it there, and one
 * that does is told twice about a thing worth acting on once.
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
 *
 * `keepsListChanged` is the standby stream saying it will deliver the
 * notification (`#1916`). Absent means a per-request transport, where D-101's
 * argument is unchanged and the flag comes off.
 */
export function advertiseOnlyWhatIsSent(server: McpServer, keepsListChanged = false): void {
  if (keepsListChanged) return

  const connect = server.connect.bind(server)

  server.connect = async (transport: Transport, ...rest: unknown[]): Promise<void> => {
    const send = transport.send.bind(transport)
    transport.send = (message, options) => send(honestInitialize(message), options)
    return connect(transport, ...(rest as []))
  }
}
