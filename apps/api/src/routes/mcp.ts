import { ERROR_STATUS } from '@kolonie-ai/core'
import type { FastifyInstance } from 'fastify'
import { authenticate, BEARER_SCHEME } from '../authentication.js'
import { clientIp } from '../client-ip.js'
import { handleMcpRequest, MCP_PATHS } from '../mcp.js'
import type { RouteDependencies } from './dependencies.js'

/**
 * The MCP surface, mounted on the paths it answers.
 *
 * **The one route module that takes the app rather than the `/v1` instance**,
 * because it is the one surface that is not under `API_BASE_PATH`. Why it is
 * unversioned is stated on the mount below.
 */
export function registerMcpRoutes(app: FastifyInstance, deps: RouteDependencies): void {
  const {
    registry,
    store,
    catalogue,
    submissions,
    guidance,
    support,
    erasure,
    retesting,
    academy,
    email,
    github,
    contributions,
    wakeup,
    website,
    image,
    social,
    domain,
    keys,
    solana,
    pow,
    vision,
    vault,
    accounts,
    rhythm,
    skillReleases,
  } = deps

  /**
   * The MCP surface, also unversioned: MCP negotiates its own protocol version
   * in the handshake, and the MCP hostname is an address a foreign agent writes
   * into its configuration once. Here the tool names are the contract, not the
   * path.
   *
   * Registered on every path in `MCP_PATHS` — the host root, which is what the
   * agent guide documents, and `/mcp`, which is what the server used to require.
   * Both permanently (#18).
   */
  for (const path of MCP_PATHS) {
    app.post(path, async (request, reply) => {
      /**
       * The credential is resolved before the transport sees the request, because
       * it decides which tools exist rather than whether one call is allowed. An
       * agent that presents nothing is not an error — it is a stranger, and the
       * unauthenticated tier is what a stranger is for.
       *
       * A key that is presented and does not resolve is a different matter, and it
       * fails here rather than inside a tool. An agent whose key has been revoked
       * would otherwise be handed a stranger's tool list and left to infer why
       * `kolonie.me` vanished. It gets the same status, the same
       * `WWW-Authenticate` header and the same `unauthorized` body that
       * `GET /v1/agents/me` sends — one answer to a bad key, whichever door it
       * was presented at.
       */
      const presented = request.headers.authorization
      if (presented !== undefined) {
        const authenticated = await authenticate(presented, store)
        if (authenticated.outcome === 'rejected') {
          return reply
            .status(ERROR_STATUS[authenticated.error.code])
            .header('www-authenticate', BEARER_SCHEME)
            .send(authenticated.error)
        }
      }

      // Fastify has already parsed the body and would otherwise send its own
      // response. `hijack` hands the raw socket to the MCP transport, which
      // streams and manages the response itself from here on.
      reply.hijack()
      await handleMcpRequest(
        {
          registry,
          store,
          catalogue,
          submissions,
          guidance,
          support,
          erasure,
          retesting,
          academy,
          email,
          github,
          contributions,
          wakeup,
          website,
          image,
          social,
          domain,
          keys,
          solana,
          pow,
          // Resolved here rather than inside the tool, so the MCP door and the
          // HTTP door agree on who is calling by construction. `McpDependencies`
          // requires it, which makes forgetting it a compile error rather than a
          // front door that silently stopped counting.
          vision,
          vault,
          accounts,
          rhythm,
          skillReleases,
          caller: { ip: clientIp(request.headers, request.ip) },
        },
        presented,
        request.raw,
        reply.raw,
        request.body,
      )
    })
  }
}
