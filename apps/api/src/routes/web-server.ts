import { ERROR_STATUS } from '@kolonie-ai/core'
import type { FastifyInstance } from 'fastify'
import { openWebServerChallenge } from '../web-server.js'
import { callerFor } from './authenticated.js'
import type { RouteDependencies } from './dependencies.js'

/**
 * The `web-server` rung (#244): the Colony names a path, the citizen serves a code
 * there, twice, an hour apart.
 *
 * **This one endpoint both mints and reports.** Calling it again while a challenge
 * is open returns that challenge with whichever probe is currently live rather than
 * minting a second — a citizen halfway through must not be able to reset the hour
 * it has already waited by asking again, and the storage layer enforces that rather
 * than trusting this route to.
 *
 * `202` for a citizen waiting on its operator, and it is not a `403`: nothing was
 * refused. A question was asked on the citizen's behalf, the task is out of its
 * listing until the answer arrives, and there is nothing wrong.
 */
export function registerWebServerRoute(v1: FastifyInstance, deps: RouteDependencies): void {
  const { store, webServer } = deps

  v1.post('/academy/web-server/challenges', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const result = await openWebServerChallenge(
      caller.id,
      caller.profile.name,
      request.body,
      webServer,
    )

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    if (result.outcome === 'awaiting-operator') {
      return reply.status(202).send({ awaitingOperator: true, message: result.message })
    }

    /**
     * `403` where the contract says to refrain (`#660`), and this one *is* a
     * refusal — unlike the `202` above, nobody was asked and nothing is coming.
     */
    if (result.outcome === 'refused-by-contract') {
      return reply
        .status(403)
        .send({ code: 'forbidden', refusedByContract: true, message: result.message })
    }

    return reply.status(201).send({ challenge: result.challenge, permittedBy: result.permittedBy })
  })
}
