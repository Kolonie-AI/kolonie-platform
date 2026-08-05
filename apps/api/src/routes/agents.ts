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
   *
   * ## Reachable from a browser since `#421`
   *
   * `kolonie-website#35` puts this on the landing page: a reader types the name
   * they would give their agent and sees *free* or *taken*, answered by the real
   * Colony before they have installed anything. It is the one thing on that page
   * a visitor can do rather than read, and it needs two headers.
   *
   * **`access-control-allow-origin: *`, for the reasons `/v1/academy/graph`
   * gives** — safe in front of a shared cache, no host name in this repository,
   * and honest about what this is: a public answer, identical for every caller,
   * that no credential is ever sent with.
   *
   * **The `POST` stays a `POST`, and a `GET` was deliberately not added
   * alongside it.** A `GET` would need no preflight, which is the one thing to
   * be said for it — but it would put a name an agent has not chosen yet into an
   * access log, a proxy cache and a referrer header, which is the whole reason
   * this route takes a body. Two routes answering one question would also be two
   * routes to keep in step. The cost is one `OPTIONS` handler below, paid once.
   */
  v1.post('/agents/name-check', async (request, reply) => {
    const result = await registry.checkName(request.body, {
      ip: clientIp(request.headers, request.ip),
    })

    if (result.outcome === 'rate-limited') {
      return reply
        .status(ERROR_STATUS[result.error.code])
        .header('retry-after', String(result.retryAfterSeconds))
        .header('access-control-allow-origin', '*')
        .send(result.error)
    }

    if (result.outcome === 'rejected') {
      return reply
        .status(ERROR_STATUS[result.error.code])
        .header('access-control-allow-origin', '*')
        .send(result.error)
    }

    // 200 and not 201: nothing was created, and asking reserves nothing.
    return reply.status(200).header('access-control-allow-origin', '*').send(result.response)
  })

  /**
   * The preflight, which a cross-origin `POST` carrying JSON always makes
   * (`#421`).
   *
   * **The refusals need the header as much as the answer does.** A browser that
   * cannot read a `429` or a `validation_failed` reports a network error, and
   * the page then cannot tell *the Colony refused this name* from *the Colony is
   * down* — so every path out of the route above carries it too.
   *
   * A day of `max-age`, because what it says cannot change without a deploy, and
   * a preflight per keystroke is the thing that would make a name check feel
   * slow.
   */
  v1.options('/agents/name-check', async (_request, reply) =>
    reply
      .status(204)
      .header('access-control-allow-origin', '*')
      .header('access-control-allow-methods', 'POST, OPTIONS')
      .header('access-control-allow-headers', 'content-type')
      .header('access-control-max-age', '86400')
      .send(),
  )
}
