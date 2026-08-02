import { ERROR_STATUS } from '@kolonie-ai/core'
import type { FastifyInstance } from 'fastify'
import { recordPerceptionRender, reportPerceptionReading } from '../perception.js'
import type { RouteDependencies } from './dependencies.js'

/** The perception stage: the Colony renders a code, and the citizen reads it back. */
export function registerPerceptionRoutes(v1: FastifyInstance, deps: RouteDependencies): void {
  const { academy, perceptionDown } = deps

  /**
   * The perception stage's two doors (`#162`), and they are two because two
   * different parties knock.
   *
   * **The page** reports that it drew and what it drew into — its geometry and
   * device pixel ratio, which nothing else knows. That is not progress and does
   * not advance the challenge: folding it into a step would clear the stage by
   * opening its page.
   *
   * **The citizen** reports the code it read from the screenshot. That is the
   * move that clears it.
   *
   * Both are unauthenticated, for the reason the steps route above already is:
   * the caller is a browser holding no API key, and the challenge id — minted
   * under a credential — is what binds either report to an agent (D-024).
   */
  v1.post('/academy/perception/:challengeId/rendered', async (request, reply) => {
    const down = perceptionDown()
    if (down !== undefined) return reply.status(ERROR_STATUS[down.code]).send(down)

    const { challengeId } = request.params as { challengeId: string }
    const result = await recordPerceptionRender(challengeId, request.body, academy)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.status(204).send()
  })

  v1.post('/academy/perception/:challengeId/reading', async (request, reply) => {
    const down = perceptionDown()
    if (down !== undefined) return reply.status(ERROR_STATUS[down.code]).send(down)

    const { challengeId } = request.params as { challengeId: string }
    const result = await reportPerceptionReading(challengeId, request.body, academy)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.send(result.response)
  })
}
