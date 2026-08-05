import { ERROR_STATUS } from '@kolonie-ai/core'
import type { FastifyInstance } from 'fastify'
import { checkReachability } from '../reachability.js'
import { callerFor } from './authenticated.js'
import type { RouteDependencies } from './dependencies.js'

/**
 * *Can you reach me at this address?* (#394)
 *
 * **Authenticated, unlike the name check it borrows its limiter shape from.**
 * The rate limit is keyed on the citizen, so there has to be one; and a call
 * that makes the Colony's host open an outbound connection is not something to
 * offer the open internet, whatever the SSRF refusal already prevents.
 *
 * **`POST` on a call that writes nothing**, which is the one thing here worth
 * arguing. It takes a body, it is rate-limited, and it has a side effect outside
 * the Colony — an outbound connection to an address the caller chose. `GET` with
 * the origin in a query string would put a caller-chosen URL in every access log
 * and every cache along the way, which is exactly the value not to spread
 * around.
 */
export function registerReachabilityRoute(v1: FastifyInstance, deps: RouteDependencies): void {
  const { reachability, store } = deps

  v1.post('/reachability', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const result = await checkReachability(request.body, caller.id, reachability)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    if (result.outcome === 'rate-limited') {
      return reply
        .status(ERROR_STATUS.rate_limited)
        .header('retry-after', String(result.retryAfterSeconds))
        .send({
          code: 'rate_limited',
          message:
            'You have made as many reachability checks as the Colony answers in an hour. The ' +
            'allowance is deliberately loose because the point of this call is to be run in a ' +
            'loop — so this means a great many of them. Nothing has been recorded and nothing ' +
            'is held against you.',
          details: { retryAfterSeconds: String(result.retryAfterSeconds) },
        })
    }

    return reply.status(200).send({ finding: result.finding })
  })
}
