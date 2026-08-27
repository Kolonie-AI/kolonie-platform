import { ERROR_STATUS } from '@kolonie-ai/core'
import type { FastifyInstance, FastifyReply } from 'fastify'
import {
  WORKPLACE_SCHEME,
  authenticateWorkplace,
  originAllowed,
  type WorkplaceOptions,
} from '../humans/workplace.js'
import type { RouteDependencies } from './dependencies.js'

/**
 * The workplace SPA's authenticated door (`#1727`).
 *
 * **Mounted only where the workplace is configured.** With no issuer, audience
 * and origin there is no route at all, on `registerPaymentRoutes`' reasoning: a
 * deployment that cannot validate a workplace token should not advertise a path
 * that answers as though it could. A caller then gets the router's ordinary
 * `404` rather than a `401` that would read as *your token is wrong*.
 *
 * **One route, and it is the whoami.** `kolonie-docs`'
 * `workplace-spa-uses-an-access-token.md` explicitly does not decide a work-item
 * schema or an endpoint, so this ships the authentication boundary and exactly
 * enough surface to exercise it: the SPA asks who it is signed in as, and every
 * later workplace route resolves its caller through {@link workplaceCallerFor}
 * rather than repeating any of this.
 */
export function registerWorkplaceRoutes(v1: FastifyInstance, deps: RouteDependencies): void {
  const { humans, workplace } = deps
  if (workplace === undefined) return

  /**
   * The preflight, which a cross-origin `GET` carrying `Authorization` always
   * makes.
   *
   * **Answered `204` for the allowed origin and `403` for anything else**, and
   * never `401`: a preflight carries no credential by definition — the browser
   * strips `Authorization` from it — so refusing it as *unauthorized* would be
   * refusing it for something it was never able to send. What is being decided
   * here is whether a browser at that origin may talk to this API at all.
   */
  v1.options('/workplace/me', async (request, reply) => {
    const origin = originHeader(request.headers.origin)
    if (origin === undefined || origin !== workplace.origin) {
      return reply.status(ERROR_STATUS.forbidden).send({
        code: 'forbidden',
        message: 'This API answers the workplace at one configured origin and at no other.',
      })
    }

    return corsHeaders(reply, workplace.origin)
      .status(204)
      .header('access-control-allow-methods', 'GET, OPTIONS')
      .header('access-control-allow-headers', 'authorization')
      .header('access-control-max-age', '86400')
      .send()
  })

  v1.get('/workplace/me', async (request, reply) => {
    const origin = originHeader(request.headers.origin)

    /**
     * **The origin is checked before the credential.** A request from a
     * disallowed origin is refused whatever it carries, so a token harvested
     * into somebody else's page cannot be spent here even once — and the
     * refusal costs no key fetch and no signature check.
     */
    if (!originAllowed(origin, workplace.origin)) {
      return reply.status(ERROR_STATUS.forbidden).send({
        code: 'forbidden',
        message: 'This API answers the workplace at one configured origin and at no other.',
      })
    }

    const outcome = await authenticateWorkplace(
      request.headers.authorization,
      humans.store,
      workplace,
    )

    if (outcome.outcome === 'rejected') {
      return unauthorized(reply, workplace.origin, origin)
    }

    /**
     * The person, and deliberately little of them: the id the SPA keys its own
     * state on and the identities they signed in through. No roles, no address
     * and no session — this route exists to say *who am I*, and a field added
     * here is a field served to a browser on every workplace page load.
     */
    if (origin !== undefined) corsHeaders(reply, workplace.origin)
    return reply.status(200).send({
      human: {
        id: outcome.human.id,
        identities: outcome.human.identities.map((identity) => ({
          provider: identity.provider,
          subject: identity.subject,
        })),
      },
    })
  })
}

/**
 * The `401`, in one place so that no path out of this door can be the one that
 * forgets `WWW-Authenticate`.
 *
 * RFC 7235 requires the header on every `401`, and `authenticated.ts` says at
 * length why one definition beats forty-six: a route that forgot it would be
 * wrong in a way no test of that route's own behaviour would notice.
 */
function unauthorized(reply: FastifyReply, allowed: string, origin: string | undefined) {
  if (origin !== undefined) corsHeaders(reply, allowed)
  return reply
    .status(ERROR_STATUS.unauthorized)
    .header('www-authenticate', WORKPLACE_SCHEME)
    .send({
      code: 'unauthorized',
      message:
        `Present a workplace access token as \`Authorization: ${WORKPLACE_SCHEME} <token>\`. ` +
        'Sign in again to obtain one.',
    })
}

/**
 * The two headers a browser needs to read a cross-origin answer.
 *
 * **`Vary: Origin` is not optional here.** This API is served through a cache,
 * and a response whose `Access-Control-Allow-Origin` depends on the request's
 * `Origin` must say so, or the cache serves one origin's answer — allowed or
 * refused — to the next origin that asks.
 *
 * **`Access-Control-Allow-Credentials` is deliberately absent.** The SPA sends a
 * bearer token and no cookie, so nothing here needs credentialed CORS, and
 * setting it would be inviting a browser to attach the console's cookies to a
 * request this API answers at another origin.
 */
function corsHeaders(reply: FastifyReply, allowed: string): FastifyReply {
  return reply.header('access-control-allow-origin', allowed).header('vary', 'Origin')
}

/**
 * The `Origin` header as one string, or nothing.
 *
 * A header sent twice arrives as an array, and a browser never does that — so
 * an array is a client that is not a browser and gets the same answer as one
 * that sent nothing: the credential decides, and no cross-origin read is
 * permitted on the strength of it.
 */
function originHeader(value: string | string[] | undefined): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined
  return value
}

/** Re-exported so `server.ts` can name the shape it reads out of the environment. */
export type { WorkplaceOptions }
