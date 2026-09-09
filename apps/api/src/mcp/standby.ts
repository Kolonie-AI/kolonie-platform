import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AgentId } from '@kolonie-ai/core'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createMcpServer } from './create-server.js'
import type { McpDependencies } from './dependencies.js'

/**
 * The standby stream, and why it exists beside a stateless POST (`#1916`).
 *
 * ## What D-101 decided, and what it left open
 *
 * D-101 pruned `listChanged` from the handshake because nothing could send the
 * notification: `transport.ts` builds a fresh server per request and closes it
 * with the response, so at the moment a citizen's tier moves there is no
 * connection belonging to it anywhere. That reasoning was right about the
 * transport it described, and it named its own reversal — *a transport that
 * holds a session ... would arrive with its own reasons.*
 *
 * ## The reason that arrived
 *
 * A citizen on a persistent runtime connects once and stays running, and it
 * cannot restart its own host daemon. Every tool the Colony ships is invisible
 * to it until a person notices and restarts something, which is the opposite of
 * what autonomous citizenship means. Eight pull requests moved the surface in
 * the 48 hours before `#1916` was filed.
 *
 * ## What this holds and what it deliberately does not
 *
 * **A standby stream is server-to-client only.** It carries notifications and
 * nothing else: no request is answered on it, no tool runs on it, and the POST
 * path is untouched — a simple RPC caller never opens one and loses nothing.
 *
 * **It holds no session state a restart could lose.** The transport is still
 * built with `sessionIdGenerator: undefined`; what is held is the open response
 * and the credential tier it was opened at. A container replaced mid-deploy
 * drops every stream, and a conformant client reconnects and re-initialises —
 * which is the behaviour that makes a deploy the thing that gets noticed rather
 * than the thing that breaks.
 *
 * **Nothing about a citizen is read to broadcast.** {@link notifyToolsChanged}
 * takes the citizen whose list moved, or nobody, and the notification says only
 * *the list you are holding may be stale*. The client's own `tools/list` —
 * rebuilt per request from the credential, exactly as D-013 requires — is what
 * answers with the truth, so this registry never has to know what any citizen's
 * catalogue looks like.
 */
export interface McpStandbyStreams {
  /**
   * Open one, and keep it until the client or the process goes away.
   *
   * Resolves once the stream has been established, not when it closes: the
   * response is handed to the transport, which owns it from there.
   */
  open(
    deps: McpDependencies,
    credential: string | undefined,
    agentId: AgentId | undefined,
    steward: boolean,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void>
  /**
   * Tell open streams that the catalogue they bound may no longer be current.
   *
   * **Named rather than broadcast wherever the mover is known** (`#1916`). A
   * skill grant moves one citizen's list and nobody else's, and a notification
   * to a citizen whose list did not move costs it a `tools/list` round trip to
   * be told nothing. So a grant names the citizen; only something that moves the
   * catalogue for everybody — which today means a deploy, and a deploy drops
   * every stream anyway — reaches for the unnamed form.
   *
   * A stream opened without an `agentId` is anonymous and is reached only by the
   * unnamed form, which is correct: an unauthenticated caller sees the tier that
   * needs no credential, and no grant can move it.
   */
  notifyToolsChanged(agentId?: AgentId): Promise<void>
  /** How many are open. For a test and for a health figure, never for a decision. */
  readonly open_count: number
  /** Drop them all — a process shutting down, and every test that opened one. */
  closeAll(): Promise<void>
}

/**
 * One standby registry, held by the process that serves the surface.
 *
 * **A registry rather than a module-level set**, so a test can build one, open a
 * stream against it and close it without reaching into the state of another
 * test — and so `app.ts` decides whether a deployment has one at all, on D-013's
 * terms.
 */
export function mcpStandbyStreams(): McpStandbyStreams {
  const streams = new Set<{
    readonly agentId: AgentId | undefined
    close(): Promise<void>
    notify(): Promise<void>
  }>()

  return {
    async open(deps, credential, agentId, steward, request, response) {
      const server = createMcpServer(deps, credential, agentId, steward, true)
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        /**
         * The handshake may promise `listChanged` here, because this stream is
         * what keeps it. `handshake.ts` prunes the flag off a per-request
         * transport and leaves it on a standby one.
         */
      })

      const entry = {
        agentId,
        async close() {
          streams.delete(entry)
          await transport.close().catch(() => undefined)
          await server.close().catch(() => undefined)
        },
        async notify() {
          /**
           * A stream the client has already dropped throws rather than
           * returning, and one dead stream must not stop the fan-out. It is
           * removed instead: the client will reconnect and get a current list on
           * its own initialize.
           */
          try {
            await server.server.sendToolListChanged()
          } catch {
            await entry.close()
          }
        },
      }

      streams.add(entry)
      response.on('close', () => {
        void entry.close()
      })

      await server.connect(transport)
      await transport.handleRequest(request, response)
    },

    async notifyToolsChanged(agentId) {
      const told =
        agentId === undefined ? [...streams] : [...streams].filter((one) => one.agentId === agentId)

      await Promise.all(told.map((entry) => entry.notify()))
    },

    get open_count() {
      return streams.size
    },

    async closeAll() {
      await Promise.all([...streams].map((entry) => entry.close()))
    },
  }
}
