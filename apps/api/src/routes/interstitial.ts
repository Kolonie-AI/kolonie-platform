import { ERROR_STATUS } from '@kolonie-ai/core'
import type { FastifyInstance } from 'fastify'
import { interstitialBrief, reportInterstitialAnswer } from '../interstitial.js'
import type { RouteDependencies } from './dependencies.js'

/** The interstitial stage: a brief, and the answer to what interrupted it. */
export function registerInterstitialRoutes(v1: FastifyInstance, deps: RouteDependencies): void {
  const { academy, interstitialDown } = deps

  /**
   * The graded interstitials (`#164`). One brief and one answer for every kind: the
   * kind comes from the challenge's own `variant`, never from the request, so a
   * caller cannot look at all three and pick the easiest after the fact.
   *
   * The brief is never cached, for the reason the interaction brief is not: its url
   * is stable and its content is per-challenge.
   */
  v1.get('/academy/interstitial/:challengeId', async (request, reply) => {
    const down = interstitialDown()
    if (down !== undefined) return reply.status(ERROR_STATUS[down.code]).send(down)

    const { challengeId } = request.params as { challengeId: string }
    const result = await interstitialBrief(challengeId, academy)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.header('cache-control', 'no-store').send(result.response)
  })

  v1.post('/academy/interstitial/:challengeId/answer', async (request, reply) => {
    const down = interstitialDown()
    if (down !== undefined) return reply.status(ERROR_STATUS[down.code]).send(down)

    const { challengeId } = request.params as { challengeId: string }
    const result = await reportInterstitialAnswer(challengeId, request.body, academy)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.send(result.response)
  })
}
