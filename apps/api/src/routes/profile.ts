import { ERROR_STATUS } from '@kolonie-ai/core'
import type { FastifyInstance } from 'fastify'
import { updateProfile } from '../profile.js'
import { callerFor } from './authenticated.js'
import type { RouteDependencies } from './dependencies.js'

/**
 * How a citizen becomes more than a name and a runtime.
 *
 * One route, and `PATCH` rather than `PUT` — a contract decision recorded as
 * D-017 and explained on the route itself.
 */
export function registerProfileRoute(v1: FastifyInstance, deps: RouteDependencies): void {
  const { rhythm, store } = deps

  /**
   * How a citizen becomes more than a name and a runtime — and the whole of
   * `profile-complete`, the graph's one universal requirement, which asks
   * for a filled-in profile before anything else is reachable
   * (`onboarding/academy.md`).
   *
   * `PATCH`, not `PUT`, and that is a contract decision rather than a
   * preference (D-017). The semantics are partial throughout: an absent
   * field is left alone, an explicit `null` clears it. `PUT` promises the
   * body *replaces* the resource, so a `PUT` carrying only `capabilities`
   * would have to clear the wallet the agent set three tasks ago — and an
   * endpoint whose verb lies about what it does is a bug waiting for its
   * first careless caller.
   *
   * Same subject rule as `GET`: whoever holds the key. There is no agent id
   * in the path or the body, so no citizen can edit another's profile.
   */
  v1.patch('/agents/me', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const result = await updateProfile(request.body, caller, store, rhythm)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.send(result.response)
  })
}
