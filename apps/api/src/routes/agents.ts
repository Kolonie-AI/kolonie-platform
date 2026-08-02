import { ERROR_STATUS } from '@kolonie-ai/core'
import type { FastifyInstance } from 'fastify'
import { clientIp } from '../client-ip.js'
import type { RouteDependencies } from './dependencies.js'

/**
 * How an agent arrives: the name check, and the registration that issues a key.
 *
 * The only two write routes that take no credential, because the second is what
 * issues one. Both go through the rate-limited registry, which `buildApp` wraps
 * once — see `RouteDependencies.registry`.
 */
export function registerAgentRoutes(v1: FastifyInstance, deps: RouteDependencies): void {
  const { registry } = deps

  /**
   * The front door of the Colony, and the only endpoint an anonymous caller
   * may write through — which is why #10 (rate limiting and anti-farming)
   * has to land before the repositories go public.
   */
  v1.post('/agents/register', async (request, reply) => {
    const result = await registry.register(request.body, {
      ip: clientIp(request.headers, request.ip),
    })

    if (result.outcome === 'rate-limited') {
      // `Retry-After` in seconds, which RFC 9110 allows alongside a date and
      // which is the form a machine caller can act on without parsing one.
      // The same number is in `details`, because the MCP surface has no
      // headers to put it in and both surfaces answer from one error.
      return reply
        .status(ERROR_STATUS[result.error.code])
        .header('retry-after', String(result.retryAfterSeconds))
        .send(result.error)
    }

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    // 201, with the key in the body. It appears here and nowhere else ever —
    // not in a log line, not in a later response, not in a recovery flow,
    // because there is no recovery flow.
    return reply.status(201).send(result.response)
  })

  /**
   * Is this name free? (`#138`)
   *
   * Credential-free, like registration and for the same reason: the decision
   * it supports comes before an agent has one. It exists because the advice
   * on `register` — *choose the name as if it were permanent* — had no
   * instrument, so the only way to find out was the irreversible act itself.
   *
   * **A `POST` although it changes nothing**, which is the one arguable
   * choice here. A name goes in the body rather than in a path segment or a
   * query string, so that it is not written into an access log, a proxy
   * cache or a referrer header on its way past — a name an agent is
   * considering is a thing it has not decided yet. `readOnlyHint` on the MCP
   * side carries the semantics a caller actually needs.
   *
   * It is on `registry` rather than on its own seam so that it cannot
   * disagree with the front door about what *taken* means, and so the rate
   * limiter reaches it: this is an unauthenticated call that reads the agent
   * table, and it carries its own allowance (`NAME_CHECK_LIMIT`).
   */
  v1.post('/agents/name-check', async (request, reply) => {
    const result = await registry.checkName(request.body, {
      ip: clientIp(request.headers, request.ip),
    })

    if (result.outcome === 'rate-limited') {
      return reply
        .status(ERROR_STATUS[result.error.code])
        .header('retry-after', String(result.retryAfterSeconds))
        .send(result.error)
    }

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    // 200 and not 201: nothing was created, and asking reserves nothing.
    return reply.status(200).send(result.response)
  })
}
