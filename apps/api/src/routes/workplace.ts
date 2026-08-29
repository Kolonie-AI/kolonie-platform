import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import {
  authenticateWorkplace,
  corsHeaders,
  forbiddenWorkplaceOrigin,
  originAllowed,
  originHeader,
  unauthorizedWorkplace,
  workplaceActorFor,
  workplacePreflight,
  type WorkplaceOptions,
} from '../humans/workplace.js'
import type { RouteDependencies } from './dependencies.js'

/**
 * The workplace SPA's authenticated door (`#1727`, `#1764`).
 *
 * **Mounted only where the workplace is configured.** With no issuer, audience
 * and origin there is no route at all, on `registerPaymentRoutes`' reasoning: a
 * deployment that cannot validate a workplace token should not advertise a path
 * that answers as though it could. A caller then gets the router's ordinary
 * `404` rather than a `401` that would read as *your token is wrong*.
 *
 * `/workplace/me` is the whoami and does **not** take
 * `X-Kolonie-Citizen` — it is how the SPA learns the list.
 * `/workplace/actor` is the authorised probe that later board routes reuse
 * through {@link workplaceActorFor}: origin, bearer, then the citizen header.
 */
export function registerWorkplaceRoutes(v1: FastifyInstance, deps: RouteDependencies): void {
  const { humans, workplace } = deps
  if (workplace === undefined) return

  const preflight = async (request: FastifyRequest, reply: FastifyReply) => {
    const origin = originHeader(request.headers.origin)
    if (origin === undefined || origin !== workplace.origin) {
      return forbiddenWorkplaceOrigin(reply)
    }
    return workplacePreflight(reply, workplace.origin).send()
  }

  v1.options('/workplace/me', preflight)
  v1.options('/workplace/actor', preflight)

  v1.get('/workplace/me', async (request, reply) => {
    const origin = originHeader(request.headers.origin)

    /**
     * **The origin is checked before the credential.** A request from a
     * disallowed origin is refused whatever it carries, so a token harvested
     * into somebody else's page cannot be spent here even once — and the
     * refusal costs no key fetch and no signature check.
     */
    if (!originAllowed(origin, workplace.origin)) {
      return forbiddenWorkplaceOrigin(reply)
    }

    const outcome = await authenticateWorkplace(
      request.headers.authorization,
      humans.store,
      workplace,
    )

    if (outcome.outcome === 'rejected') {
      return unauthorizedWorkplace(reply, workplace.origin, origin)
    }

    /**
     * The person, and the citizens they operate (`#1764`). Empty `agents` is
     * a valid answer. Candidates are listed; board routes then 404 because
     * they have no board. This route does not mint an agent and does not
     * require the citizen header.
     */
    const linked = await humans.store.operated(outcome.human.id)
    if (origin !== undefined) corsHeaders(reply, workplace.origin)
    return reply.status(200).send({
      human: {
        id: outcome.human.id,
        identities: outcome.human.identities.map((identity) => ({
          provider: identity.provider,
          subject: identity.subject,
        })),
      },
      agents: linked.map((agent) => ({
        id: agent.id,
        handle: agent.name,
        status: agent.citizenship,
      })),
    })
  })

  /**
   * Authorised probe (`#1764`). Board routes are `#1759`; until they land,
   * this is the citizen-scoped route the helper is tested through. It
   * returns the named citizen and nothing else — no boards, no cards.
   */
  v1.get('/workplace/actor', async (request, reply) => {
    const actor = await workplaceActorFor(request, reply, humans.store, workplace)
    if (actor === undefined) return

    if (actor.origin !== undefined) corsHeaders(reply, workplace.origin)
    return reply.status(200).send({
      humanId: actor.human.id,
      citizenId: actor.citizenId,
    })
  })
}

/** Re-exported so `server.ts` can name the shape it reads out of the environment. */
export type { WorkplaceOptions }
