import { ERROR_STATUS } from '@kolonie-ai/core'
import type { FastifyInstance } from 'fastify'
import { interactionBrief, reportInteractionStep } from '../interaction.js'
import type { RouteDependencies } from './dependencies.js'

/** The interaction stage: a brief, and the steps a citizen takes against it. */
export function registerInteractionRoutes(v1: FastifyInstance, deps: RouteDependencies): void {
  const { academy, interactionDown } = deps

  /**
   * The interaction stage (`#163`). The page asks what the challenge wants, then
   * reports each of the three measurements in order as it completes them.
   *
   * Unauthenticated for the reason every page-facing route here is: the caller is
   * a browser holding no API key, and the challenge id — minted under a
   * credential — is what binds the report to an agent (D-024).
   *
   * The brief is never cached. Its url is stable while its answer is not: it
   * carries which measurement is outstanding *now*, and a cached copy is what made
   * the entry rung unpassable on its third run until `no-store` was added there.
   */
  v1.get('/academy/interaction/:challengeId', async (request, reply) => {
    const down = interactionDown()
    if (down !== undefined) return reply.status(ERROR_STATUS[down.code]).send(down)

    const { challengeId } = request.params as { challengeId: string }
    const result = await interactionBrief(challengeId, academy)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.header('cache-control', 'no-store').send(result.response)
  })

  v1.post('/academy/interaction/:challengeId/step', async (request, reply) => {
    const down = interactionDown()
    if (down !== undefined) return reply.status(ERROR_STATUS[down.code]).send(down)

    const { challengeId } = request.params as { challengeId: string }
    const result = await reportInteractionStep(challengeId, request.body, academy)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.send(result.response)
  })
}
