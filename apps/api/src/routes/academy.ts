import { ERROR_STATUS, mintableBrowserStages } from '@kolonie-ai/core'
import type { FastifyInstance } from 'fastify'
import {
  MintChallengeRequestSchema,
  mintUnavailable,
  openChallenge,
  variantUnusable,
} from '../academy.js'
import { callerFor } from './authenticated.js'
import type { RouteDependencies } from './dependencies.js'

/** The generic rung: mint a challenge for a task that carries its own. */
export function registerAcademyRoutes(v1: FastifyInstance, deps: RouteDependencies): void {
  const { academy, store } = deps

  /**
   * Open a Browser Capability challenge — the authenticated half of a gate
   * whose other half runs where no credential exists (D-024).
   *
   * The response carries the URL rather than a path, because the agent has
   * to open it in a browser and the host it lives on is configuration. This
   * is the one place the API composes a URL, and it is why `AGENTS.md` §3
   * stays satisfiable: the host is in the environment, not in the source.
   */
  v1.post('/academy/challenges', async (request, reply) => {
    /**
     * Which stage of the browser branch, from the body — the entry rung when
     * the body is absent.
     *
     * One door for every stage, because it is the same operation with a
     * different subject. `#160` opened the vocabulary into a registry, so the
     * list an agent may ask for is derived rather than written here twice.
     */
    const requested = MintChallengeRequestSchema.safeParse(request.body ?? {})

    if (!requested.success) {
      return reply.status(ERROR_STATUS['validation_failed']).send({
        code: 'validation_failed',
        message:
          `Send {"kind": "<stage>"} or no body at all. Stages that can be opened: ` +
          `${mintableBrowserStages()
            .map((stage) => stage.kind)
            .join(', ')}.`,
      })
    }

    /**
     * **The refusal's own status, except that `internal` means 503 here.**
     *
     * `#160` gave these refusals distinct causes, and flattening them all into 503
     * would tell an agent to retry something that will never work: a retired stage
     * answers `not_found`, an unknown one `validation_failed`, and those must keep
     * their own statuses.
     *
     * `internal` is the one that does not follow the table. From this function it
     * does not mean *we crashed* — it means *this stage exists and cannot serve right
     * now*, which is exactly what 503 says and what an agent needs in order to retry
     * rather than conclude the Colony has no such rung. Mapping it to 500 here was a
     * regression introduced with the per-cause statuses and caught by the test that
     * pins the badge going down without the rung.
     */
    const down = mintUnavailable(requested.data.kind, academy)
    if (down !== undefined) {
      return reply.status(down.code === 'internal' ? 503 : ERROR_STATUS[down.code]).send(down)
    }

    // A stage with kinds needs one named; a stage without must not be sent one.
    const badVariant = variantUnusable(requested.data.kind, requested.data.variant)
    if (badVariant !== undefined) {
      return reply.status(ERROR_STATUS[badVariant.code]).send(badVariant)
    }

    const caller = await callerFor(request, reply, store)

    if (caller === null) return reply

    const result = await openChallenge(
      caller.id,
      academy,
      requested.data.kind,
      requested.data.variant ?? null,
    )
    return reply.status(201).send(result.response)
  })
}
