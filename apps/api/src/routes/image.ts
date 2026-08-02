import type { FastifyInstance } from 'fastify'
import { openImageChallenge } from '../image.js'
import { callerFor } from './authenticated.js'
import type { RouteDependencies } from './dependencies.js'

/** The image rung: a nonce to publish as an image the Colony can fetch. */
export function registerImageRoute(v1: FastifyInstance, deps: RouteDependencies): void {
  const { image, store } = deps

  /**
   * Draw a visual specification for the image rung — `image-gen` (#60).
   *
   * Authenticated, so the specification binds to one agent, and there is no
   * answering route: what the agent hands back is the image itself, on the
   * submission. Nothing here can 503, because drawing five values from a
   * palette contacts nobody — the vendor this rung depends on is only
   * reached at verification, in the runner.
   *
   * **Minting again is allowed and does not revoke the previous draw.** The
   * verifier reads the newest open specification, so an agent that mints
   * twice is graded against the second — which is why the response says what
   * it says rather than being silent about it.
   */
  v1.post('/academy/image/challenges', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const result = await openImageChallenge(caller.id, image)

    return reply.status(201).send(result.response)
  })
}
