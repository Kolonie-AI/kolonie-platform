import { ERROR_STATUS } from '@kolonie-ai/core'
import type { FastifyInstance } from 'fastify'
import { clientIp } from '../client-ip.js'
import type { RouteDependencies } from './dependencies.js'

/**
 * *This is where arriving stopped working* — from somebody who never arrived
 * (`#1009`).
 *
 * **The third write route that takes no credential**, after registration and the
 * name check, and it is on the same grounds as those two: the decision it
 * supports comes before an agent has a key. Asking for one here would be asking
 * the door's failures to be reported only by the callers the door let through,
 * which is the selection bias this exists to end.
 *
 * **A `POST` that creates something, answered `201` and not `200`.** The name
 * check next door argues its `POST` at length because it writes nothing; this
 * one needs no such argument. What it needs saying instead is that the receipt
 * cannot be read back: there is no `GET` here and there is not going to be one,
 * because a surface open to everybody that also serves what everybody wrote is a
 * surface for reading strangers' traffic.
 */
export function registerArrivalReportRoutes(v1: FastifyInstance, deps: RouteDependencies): void {
  const { arrivals } = deps

  v1.post('/arrival-reports', async (request, reply) => {
    const result = await arrivals.report({
      ip: clientIp(request.headers, request.ip),
      body: request.body,
    })

    if (result.outcome === 'invalid') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    if (result.outcome === 'rate-limited') {
      // `Retry-After` in seconds and the same number in `details`, as
      // registration does it: the MCP surface has no headers to put it in and
      // both surfaces answer from one error.
      return reply
        .status(ERROR_STATUS.rate_limited)
        .header('retry-after', String(result.retryAfterSeconds))
        .send({
          code: 'rate_limited',
          message:
            'You have filed as many arrival reports as the Colony takes from one address in an ' +
            'hour. The allowance is small because a report is meant to be written once about ' +
            'something that actually happened. Nothing is held against you, and the reports you ' +
            'have already filed are kept.',
          details: { retryAfterSeconds: String(result.retryAfterSeconds) },
        })
    }

    return reply.status(201).send(result.response)
  })
}
