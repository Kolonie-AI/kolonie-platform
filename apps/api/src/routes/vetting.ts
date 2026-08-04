import type { FastifyInstance } from 'fastify'
import { openVettingChallenge } from '../vetting.js'
import { callerFor } from './authenticated.js'
import type { RouteDependencies } from './dependencies.js'

/** The vetting rung: a skill manifest with properties planted in it (`#45`). */
export function registerVettingRoute(v1: FastifyInstance, deps: RouteDependencies): void {
  const { vetting, store } = deps

  /**
   * Draw a manifest for the rung — `vetting` (#45).
   *
   * Authenticated, so the manifest binds to one agent, and there is no answering
   * route: what the agent hands back goes on the submission. Nothing here can
   * 503, because drawing a sample and two properties contacts nobody.
   *
   * **Drawing again is allowed and is a fresh draw** — a different sample, a
   * different pair, and a different token. So a second attempt is a different
   * exercise rather than a rehearsal of the first, and a citizen cannot re-read
   * a manifest it has already had graded.
   */
  v1.post('/academy/vetting/challenges', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const result = await openVettingChallenge(caller.id, vetting)

    return reply.status(201).send(result.response)
  })
}
