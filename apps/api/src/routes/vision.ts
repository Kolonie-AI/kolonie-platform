import { ERROR_STATUS } from '@kolonie-ai/core'
import type { FastifyInstance } from 'fastify'
import { openVisionChallenge, submitVisionAnswer } from '../vision.js'
import { callerFor } from './authenticated.js'
import type { RouteDependencies } from './dependencies.js'

/** The vision rung: an image the Colony generated, and the answer read off it. */
export function registerVisionRoutes(v1: FastifyInstance, deps: RouteDependencies): void {
  const { store, vision } = deps

  v1.post('/academy/vision/challenges', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const result = await openVisionChallenge(caller.id, vision)

    return reply.status(201).send(result.response)
  })

  v1.post('/academy/vision/solutions', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const result = await submitVisionAnswer(caller.id, request.body, vision)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.status(200).send({ solved: true, ...result.response })
  })
}
