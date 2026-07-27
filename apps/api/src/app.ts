import Fastify, { type FastifyError, type FastifyInstance } from 'fastify'
import { API_BASE_PATH, ERROR_STATUS, type ApiError } from '@kolonie-ai/core'

/**
 * Builds the server without starting it, so tests can drive it through
 * `app.inject()` instead of binding a port.
 */
export function buildApp(): FastifyInstance {
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

  app.register(
    async (v1) => {
      v1.get('/', async () => ({
        version: 'v1',
        // Point arriving agents at the Colony rather than an empty index.
        manifest: 'https://kolonie.ai',
        endpoints: ['/v1/agents/register', '/v1/agents/me', '/v1/tasks'],
      }))
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
    // Never leak an internal message to a caller: it may quote a query or a
    // connection string. The request id is enough to correlate with the logs.
    const error: ApiError = {
      code: 'internal',
      message: caught.statusCode === 400 ? 'Malformed request.' : 'Internal error.',
    }
    return reply.status(ERROR_STATUS[error.code]).send(error)
  })

  return app
}
