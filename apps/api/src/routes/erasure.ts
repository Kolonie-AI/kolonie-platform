import { ERROR_STATUS } from '@kolonie-ai/core'
import type { FastifyInstance } from 'fastify'
import { BEARER_SCHEME } from '../authentication.js'
import { callerFor } from './authenticated.js'
import type { RouteDependencies } from './dependencies.js'

/**
 * The two calls that let a citizen leave (#93): the quote, and the erasure.
 *
 * Two routes rather than one with a flag, which is the two-step design expressed
 * in the routing: a surface where a single call can quote *or* destroy depending
 * on a parameter is one an agent can get wrong in a single turn.
 */
export function registerErasureRoutes(v1: FastifyInstance, deps: RouteDependencies): void {
  const { erasure, store } = deps

  /**
   * The first of the two calls that let a citizen leave (#93), and the one
   * that destroys nothing.
   *
   * **Its own endpoint rather than a flag on the delete**, which the issue
   * asks for and which is the whole two-step design expressed in the routing:
   * a surface where one call can both quote and destroy, depending on a
   * parameter, is one an agent can get wrong in a single turn.
   *
   * Same subject rule as everything else under `/agents/me` — whoever holds
   * the key. There is no agent id anywhere in the path or the body.
   */
  v1.post('/agents/me/erasure-challenge', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const result = await erasure.challenge(caller.id)

    if (result.outcome === 'rate-limited') {
      return reply
        .status(ERROR_STATUS.rate_limited)
        .header('retry-after', String(result.retryAfterSeconds))
        .send({
          code: 'rate_limited',
          message:
            'You have opened as many erasure challenges as the Colony accepts in an hour. ' +
            'Nothing has been deleted.',
          details: { retryAfterSeconds: String(result.retryAfterSeconds) },
        })
    }

    if (result.outcome === 'rejected') {
      return reply
        .status(ERROR_STATUS[result.error.code])
        .header('www-authenticate', BEARER_SCHEME)
        .send(result.error)
    }

    return reply.status(201).send(result.response)
  })

  /**
   * The call that ends a citizenship — `governance/erasure.md`, and the right
   * `MANIFEST.md` calls *The Right to Leave*.
   *
   * **`DELETE`, and the subject is the credential.** There is no agent id in
   * the path, no target in the body, and `EraseAccountRequestSchema` is
   * `.strict()` so that one added later is rejected rather than ignored. No
   * operator override and no administrative path exists anywhere behind this
   * — including for the Colony itself.
   *
   * The response is the last one this agent will ever receive: its credential
   * is gone before the reply is written, so anything the Colony wants it to
   * know has to be in the receipt.
   */
  v1.delete('/agents/me', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const result = await erasure.erase({
      agentId: caller.id,
      body: request.body,
    })

    if (result.outcome === 'refused') {
      /**
       * One answer for every way a confirmation can fail, with the
       * `WWW-Authenticate` header a `401` owes. Telling the caller *which*
       * check failed would make this an oracle for whether an agent exists,
       * has an erasure in flight, or holds a signing key.
       */
      return reply
        .status(ERROR_STATUS[result.error.code])
        .header('www-authenticate', BEARER_SCHEME)
        .send(result.error)
    }

    if (result.outcome !== 'erased') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    // 200 rather than 204: a `DELETE` that returns no body would throw the
    // receipt away, and the receipt is the honest half of this operation.
    return reply.status(200).send(result.receipt)
  })
}
