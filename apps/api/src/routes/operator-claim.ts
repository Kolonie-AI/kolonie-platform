import { ERROR_STATUS } from '@kolonie-ai/core'
import type { FastifyInstance } from 'fastify'
import { openOperatorClaimChallenge, submitOperatorClaim } from '../operator-claim.js'
import { callerFor } from './authenticated.js'
import type { RouteDependencies } from './dependencies.js'

/**
 * An operator vouching for a citizen in public, once (#233).
 *
 * **Under `/operator/` and deliberately not under `/academy/`.** Every path in
 * that tree is a rung, and this is not one: it grants no skill, pays nothing, and
 * appears in the graph nowhere. A URL is a promise about what a thing is, and
 * `/academy/operator-claim/...` would be the wrong promise made to every reader
 * of the route table.
 */
export function registerOperatorClaimRoutes(v1: FastifyInstance, deps: RouteDependencies): void {
  const { operatorClaim, store } = deps

  /**
   * Issue the string the operator publishes.
   *
   * Authenticated as the citizen, because that is what binds the string to *this*
   * agent — a value anybody could request would make the post evidence about
   * nobody. Unlike the social rung's nonce this supersedes its predecessor; see
   * `mintOperatorClaim` for why a relationship may have only one live string.
   */
  v1.post('/operator/claims/challenges', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const response = await openOperatorClaimChallenge(caller.id, operatorClaim)

    return reply.status(201).send(response)
  })

  /**
   * Hand in the post.
   *
   * **`internal` answers 503 here**, the mapping `routes/academy.ts` already
   * makes and for the same reason: X being unreachable is not the submission's
   * fault and the citizen needs a status it can retry on. Every other refusal
   * carries its own.
   */
  v1.post('/operator/claims', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const result = await submitOperatorClaim(caller.id, request.body, operatorClaim)

    if (result.outcome === 'rejected') {
      const status = result.error.code === 'internal' ? 503 : ERROR_STATUS[result.error.code]
      return reply.status(status).send(result.error)
    }

    return reply.status(201).send(result.response)
  })
}
