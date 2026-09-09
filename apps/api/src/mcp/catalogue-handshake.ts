import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { tierFingerprint } from './catalogue-tier.js'

/**
 * The catalogue fingerprint, carried in the `initialize` result (`#1917`).
 *
 * ## The question this answers, and where it used to have to be asked
 *
 * `#1392` put `catalogueFingerprint` in `kolonie.wakeup`'s `structuredContent`,
 * and keeping it out of the rendered digest was right. But the digest was the
 * only door, and it is the wrong one for this fact: it is a heavy answer —
 * standing, `open`, commitment, delegation, vault shares, wake channel, operator
 * standing, workplace — to settle a one-field question, and a client reads it at
 * a moment it did not choose.
 *
 * Worse, the fact was delivered *inside* the surface it describes. A client
 * whose binding is stale read a current fingerprint through possibly-stale
 * schemas. `initialize` is when a client binds those schemas, so it is when the
 * string describing them is worth having.
 *
 * **`kolonie.wakeup` keeps carrying it.** This is a second door onto one fact,
 * not a move: a citizen that reads it on every waking should not have to
 * reconnect to keep doing so, and `#1392`'s reasoning about the rendered digest
 * is untouched. No tool is added either — a tool answering *is the catalogue
 * current* would grow the thing being measured.
 *
 * ## Why on the way out rather than in the constructor
 *
 * The SDK builds the `initialize` result itself and takes only `instructions` as
 * a hand-written field. The transport's `send` is the seam every caller passes
 * through — the same one `publishLeanSchemas` (`#382`) and `advertiseOnlyWhatIsSent`
 * (`#386`, `#1916`) already shape — so the handshake a test reads is the
 * handshake a citizen gets, over HTTP and over an in-memory pair alike.
 *
 * ## Where it sits in the result
 *
 * MCP reserves `_meta` for implementation-specific result data, so the field is
 * `_meta["ai.kolonie/catalogueFingerprint"]`: the same namespacing convention
 * the tool-docs route already follows. A client that never looks for it is
 * unaffected, and no protocol-level field has been invented for a Colony fact.
 */

/**
 * The key a client reads under `initialize.result._meta`.
 *
 * Namespaced because this is the Colony's fact and not the protocol's, on the
 * same terms as `TOOL_DOCS_META_KEY`.
 */
export const CATALOGUE_FINGERPRINT_META_KEY = 'ai.kolonie/catalogueFingerprint'

/** An `initialize` result with the fingerprint of the served tier added. */
const withFingerprint = (message: JSONRPCMessage, fingerprint: string): JSONRPCMessage => {
  if (!('result' in message) || message.result === undefined) return message

  const result = message.result as Record<string, unknown>
  // Only the handshake carries it. `capabilities` and `serverInfo` are the two
  // fields every `initialize` result has and no other result has, so this is
  // what tells one apart from a `tools/list` or a `tools/call` on the same seam.
  if (!('capabilities' in result) || !('serverInfo' in result)) return message

  return {
    ...message,
    result: {
      ...result,
      _meta: {
        ...((result['_meta'] as Record<string, unknown> | undefined) ?? {}),
        [CATALOGUE_FINGERPRINT_META_KEY]: fingerprint,
      },
    },
  } as JSONRPCMessage
}

/**
 * Carry this server's catalogue fingerprint in its handshake.
 *
 * Called once by `createMcpServer`, beside the other two rules about what leaves
 * the server, so a tool registered afterwards is covered without its author
 * doing anything.
 *
 * The fingerprint is computed once per connection rather than per message: the
 * catalogue cannot change while a server is connected — the tiers are decided
 * when it is built — and `initialize` is answered once anyway.
 */
export function publishCatalogueFingerprint(server: McpServer): void {
  const connect = server.connect.bind(server)

  server.connect = async (transport: Transport, ...rest: unknown[]): Promise<void> => {
    const fingerprint = await tierFingerprint(server)
    if (fingerprint !== undefined) {
      const send = transport.send.bind(transport)
      transport.send = (message, options) => send(withFingerprint(message, fingerprint), options)
    }

    return connect(transport, ...(rest as []))
  }
}
