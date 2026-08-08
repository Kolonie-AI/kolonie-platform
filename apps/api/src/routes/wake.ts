import { ERROR_STATUS } from '@kolonie-ai/core'
import type { FastifyInstance } from 'fastify'
import { openWakeChallenge } from '../wake.js'
import { callerFor } from './authenticated.js'
import type { RouteDependencies } from './dependencies.js'

/**
 * The `wake` rung's mint (#518): the citizen names a URL, the Colony issues a
 * secret and later knocks.
 *
 * **This endpoint mints and does not report**, which is where it differs from
 * `web-server`'s. There, calling again returns the open challenge, because a
 * citizen halfway through must not reset the hour it has waited. Here the
 * response carries a secret that is shown once — so a route that answered with
 * an existing challenge would either have to disclose the secret again, which
 * defeats the point of showing it once, or answer without it, which is useless.
 * Minting again is the recovery path and it is cheap.
 *
 * **There is deliberately no route that sends a wake.** The delivery half has no
 * surface at all: nothing takes an agent id and a wish, not for an operator and
 * not for the Colony's own console. See `wake.ts`.
 */
export function registerWakeRoute(v1: FastifyInstance, deps: RouteDependencies): void {
  const { store, wake } = deps

  v1.post('/academy/wake/challenges', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const result = await openWakeChallenge(caller.id, request.body, wake)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.status(201).send({ challenge: result.challenge })
  })
}
