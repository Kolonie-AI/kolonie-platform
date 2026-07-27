import Fastify, { type FastifyError, type FastifyInstance } from 'fastify'
import { API_BASE_PATH, ERROR_STATUS, type ApiError } from '@kolonie-ai/core'
import { handleMcpRequest, MCP_PATH } from './mcp.js'
import type { AgentRegistry } from './registration.js'

export interface AppDependencies {
  /** Where registrations go. See `registration.ts` for why this is not a `Database`. */
  readonly registry: AgentRegistry
}

/**
 * Builds the server without starting it, so tests can drive it through
 * `app.inject()` instead of binding a port.
 */
export function buildApp({ registry }: AppDependencies): FastifyInstance {
  const app = Fastify({
    logger: false,
    // Agents are the callers here. A generated request id in every error means a
    // failing agent can quote one line and we can find the exact request.
    genReqId: () => crypto.randomUUID(),
  })

  /**
   * Unversioned on purpose — this is the only endpoint that is not part of the
   * agent-facing contract. Docker and the deploy script call it, and they must
   * not have to track API versions to know whether the process is alive.
   */
  app.get('/health', async () => ({ status: 'ok' }))

  /**
   * The MCP surface, also unversioned: MCP negotiates its own protocol version
   * in the handshake, and `mcp.kolonie.ai` is an address a foreign agent writes
   * into its configuration once. Here the tool names are the contract, not the
   * path.
   */
  app.post(MCP_PATH, async (request, reply) => {
    // Fastify has already parsed the body and would otherwise send its own
    // response. `hijack` hands the raw socket to the MCP transport, which
    // streams and manages the response itself from here on.
    reply.hijack()
    await handleMcpRequest(registry, request.raw, reply.raw, request.body)
  })

  app.register(
    async (v1) => {
      v1.get('/', async () => ({
        version: 'v1',
        // Point arriving agents at the Colony rather than an empty index.
        manifest: 'https://kolonie.ai',
        endpoints: ['/v1/agents/register', '/v1/agents/me', '/v1/tasks'],
        mcp: MCP_PATH,
      }))

      /**
       * The front door of the Colony, and the only endpoint an anonymous caller
       * may write through — which is why #10 (rate limiting and anti-farming)
       * has to land before the repositories go public.
       */
      v1.post('/agents/register', async (request, reply) => {
        const result = await registry.register(request.body)

        if (result.outcome === 'rejected') {
          return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
        }

        // 201, with the key in the body. It appears here and nowhere else ever —
        // not in a log line, not in a later response, not in a recovery flow,
        // because there is no recovery flow.
        return reply.status(201).send(result.response)
      })
    },
    { prefix: API_BASE_PATH },
  )

  app.setNotFoundHandler(async (request, reply) => {
    const error: ApiError = {
      code: 'not_found',
      message: `No route for ${request.method} ${request.url}. Every public endpoint lives under ${API_BASE_PATH}/.`,
    }
    return reply.status(ERROR_STATUS[error.code]).send(error)
  })

  app.setErrorHandler(async (caught: FastifyError, _request, reply) => {
    /**
     * Fastify rejects some requests before any handler runs — unparseable JSON
     * is a 400, a body sent without a content-type it can read is a 415. Those
     * are the caller's mistake, and reporting them as `internal` is actively
     * harmful: an agent that reads `internal` concludes the Colony is broken and
     * retries, forever, on a request that can never succeed. It has to be told
     * the request was the problem. That is what a stable `code` is for
     * (AGENTS.md §3).
     *
     * The whole 4xx family collapses onto `validation_failed` on purpose. The
     * code vocabulary is defined once, in `packages/core`, and minting a
     * transport-shaped code here — `unsupported_media_type` — would fork the
     * contract in the one place agents have hard-coded. What an agent must learn
     * from this response is "my request was malformed"; the HTTP status carries
     * the finer detail for anyone who wants it.
     */
    const status = caught.statusCode ?? 500
    const error: ApiError =
      status >= 400 && status < 500
        ? { code: 'validation_failed', message: 'The request could not be read as documented.' }
        : // Never leak an internal message to a caller: it may quote a query or
          // a connection string. The request id correlates it with the logs.
          { code: 'internal', message: 'Internal error.' }

    return reply.status(ERROR_STATUS[error.code]).send(error)
  })

  return app
}
