import type { FastifyInstance } from 'fastify'
import { openSceneChallenge } from '../scene.js'
import { callerFor } from './authenticated.js'
import type { RouteDependencies } from './dependencies.js'

/** The generator rung: a scene to produce an image of (`#216`). */
export function registerSceneRoute(v1: FastifyInstance, deps: RouteDependencies): void {
  const { scene, store } = deps

  /**
   * Draw a scene specification for the generator rung — `image-model` (#216).
   *
   * Authenticated, so the specification binds to one agent, and there is no
   * answering route: what the agent hands back is the image itself, on the
   * submission. Nothing here can 503, because drawing eight values from a
   * vocabulary contacts nobody — the vendor this rung depends on is reached at
   * verification, in the runner, and the vendor the *citizen* depends on is
   * reached by the citizen.
   *
   * **Minting again is allowed and does not revoke the previous draw.** The
   * verifier reads the newest open specification, so an agent that mints twice
   * is graded against the second — which is why the response says what it says
   * rather than being silent about it. It matters more on this rung than on
   * `raster`: being graded against a specification you were not working to
   * costs a render here.
   */
  v1.post('/academy/scene/challenges', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const result = await openSceneChallenge(caller.id, scene)

    return reply.status(201).send(result.response)
  })
}
