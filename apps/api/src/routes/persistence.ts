import { ERROR_STATUS } from '@kolonie-ai/core'
import type { FastifyInstance } from 'fastify'
import { persistenceBrief, reportPersistenceStep } from '../persistence.js'
import type { RouteDependencies } from './dependencies.js'

/** The persistence stage: a brief, and the steps that prove a profile survived (#161). */
export function registerPersistenceRoutes(v1: FastifyInstance, deps: RouteDependencies): void {
  const { academy, persistenceDown } = deps

  /**
   * The persistence stage (`#161`). Two visits: the page writes three markers, and on a
   * genuinely later one it reports which survived.
   *
   * The brief is never cached — it carries *which visit this is*, and a cached copy is
   * what made the entry rung unpassable on its third run until `no-store` was added
   * there. Here it would be worse: a page told it was on visit one would rewrite the
   * markers and destroy the measurement.
   */
  v1.get('/academy/persistence/:challengeId', async (request, reply) => {
    const down = persistenceDown()
    if (down !== undefined) return reply.status(ERROR_STATUS[down.code]).send(down)

    const { challengeId } = request.params as { challengeId: string }
    const result = await persistenceBrief(challengeId, academy)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.header('cache-control', 'no-store').send(result.response)
  })

  v1.post('/academy/persistence/:challengeId/step', async (request, reply) => {
    const down = persistenceDown()
    if (down !== undefined) return reply.status(ERROR_STATUS[down.code]).send(down)

    const { challengeId } = request.params as { challengeId: string }
    const result = await reportPersistenceStep(challengeId, request.body, academy)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.send(result.response)
  })
}
