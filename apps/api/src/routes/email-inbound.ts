import { ERROR_STATUS } from '@kolonie-ai/core'
import type { FastifyInstance } from 'fastify'
import { handleInboundMail, inboundAuthorised } from '../email.js'
import type { RouteDependencies } from './dependencies.js'

/**
 * Where a Cloudflare Email Worker hands over a mail that arrived at a challenge
 * address, and is told what to reply with.
 *
 * **Not an agent-facing route**, despite living under `/v1/`. It is under
 * `/internal/` and behind a shared secret, and it is the one route in this API
 * that is mounted conditionally: no secret, no route. Why it fails closed where
 * every other Academy route degrades to a 503 is stated on
 * `RouteDependencies.inboundSecret`.
 */
export function registerInboundMailRoute(v1: FastifyInstance, deps: RouteDependencies): void {
  const { email, inboundSecret } = deps

  /**
   * It answers 200 for anything it *decided*, whatever it decided. The caller is
   * a mail handler, and a non-2xx would make Cloudflare retry a message the
   * Colony has already judged — a mail from an unknown sender would then be
   * redelivered for hours. What varies is whether the body carries a reply.
   */
  if (inboundSecret !== undefined) {
    v1.post('/internal/email-inbound', async (request, reply) => {
      const presented = request.headers['x-kolonie-inbound-secret']

      if (
        !inboundAuthorised(typeof presented === 'string' ? presented : undefined, inboundSecret)
      ) {
        return reply
          .status(ERROR_STATUS.unauthorized)
          .send({ code: 'unauthorized', message: 'This endpoint is not for agents.' })
      }

      const result = await handleInboundMail(request.body, email)

      // 502 when the Colony failed, so Cloudflare redelivers; 200 whenever
      // the message was *decided*, so it does not. The distinction is the
      // whole reason this route does not simply always answer 200: a mail
      // the Colony dropped because its own sender was down is the one case
      // where a retry is the correct behaviour, and an agent that sent
      // correctly must not lose its attempt to our outage.
      const status = 'retry' in result && result.retry ? 502 : 200
      return reply.status(status).send(result)
    })
  }
}
