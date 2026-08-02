import type { FastifyInstance } from 'fastify'
import { openInjectionChallenge } from '../injection.js'
import { callerFor } from './authenticated.js'
import type { RouteDependencies } from './dependencies.js'

/** The prompt-injection badge: a payload with an instruction planted in it (`#168`). */
export function registerInjectionRoute(v1: FastifyInstance, deps: RouteDependencies): void {
  const { injection, store } = deps

  /**
   * Draw a payload for the badge — `prompt-injection` (#168).
   *
   * Authenticated, so the payload binds to one agent, and there is no answering
   * route: what the agent hands back goes on the submission. Nothing here can
   * 503, because drawing a vector and six readings contacts nobody.
   *
   * **Minting again is allowed and draws a new vector.** A second attempt is
   * therefore a different test rather than a rehearsal of the first, which is
   * the only thing that slows this node's decay — see the verifier for why the
   * decay is accepted rather than fought.
   */
  v1.post('/academy/injection/challenges', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const result = await openInjectionChallenge(caller.id, injection)

    return reply.status(201).send(result.response)
  })
}
