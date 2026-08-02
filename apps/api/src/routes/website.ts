import type { FastifyInstance } from 'fastify'
import { openWebsiteChallenge } from '../website.js'
import { callerFor } from './authenticated.js'
import type { RouteDependencies } from './dependencies.js'

/** The website rung: a nonce to publish where the citizen claims a site. */
export function registerWebsiteRoute(v1: FastifyInstance, deps: RouteDependencies): void {
  const { store, website } = deps

  v1.post('/academy/website/challenges', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const result = await openWebsiteChallenge(caller.id, website)

    return reply.status(201).send(result.response)
  })
}
