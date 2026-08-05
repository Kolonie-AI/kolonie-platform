import type { FastifyInstance } from 'fastify'
import { openArtefactChallenge } from '../artefact.js'
import { callerFor } from './authenticated.js'
import type { RouteDependencies } from './dependencies.js'

/**
 * The `artefact-publish` rung's mint (`#389`).
 *
 * The domain route one medium over, and everything said there holds:
 * authenticated so the code binds to one agent, no answering route because there
 * is nothing for the agent to hand back, and no 503 branch because minting
 * issues a random code and touches nothing outside the database.
 */
export function registerArtefactRoute(v1: FastifyInstance, deps: RouteDependencies): void {
  const { artefact, store } = deps

  v1.post('/academy/artefact/challenges', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const result = await openArtefactChallenge(caller.id, artefact)

    return reply.status(201).send(result.response)
  })
}
