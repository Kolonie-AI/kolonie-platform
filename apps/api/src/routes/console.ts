import { ERROR_STATUS } from '@kolonie-ai/core'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import {
  CHECK_YOUR_MAIL,
  RedeemSchema,
  RequestLinkSchema,
  SignUpSchema,
  redeemSignIn,
  requestSignIn,
  signUp,
} from '../console.js'
import { clientIp } from '../client-ip.js'
import type { RouteDependencies } from './dependencies.js'

/**
 * The name the session cookie travels under.
 *
 * `__Host-` is a prefix with teeth rather than a convention: a browser refuses to
 * accept a cookie so named unless it is `Secure`, has `Path=/` and carries **no**
 * `Domain` attribute. That last one is what matters here — it makes the cookie
 * unsettable by any sibling host, so a foothold on some other subdomain cannot
 * write a session for the console.
 */
export const SESSION_COOKIE = '__Host-kolonie_session'

/**
 * Browser sign-in (`#172`).
 *
 * ## Why these are `/v1/` routes like everything else
 *
 * The console is a surface of this API and not a second application, so its
 * endpoints are versioned on the same terms as the rest — an HTML page served at
 * `console.kolonie.ai` calls the same paths an agent would. `kolonie-docs#108`
 * decides the hostname; this decides nothing about it.
 *
 * ## What an agent does instead
 *
 * Nothing here is required of one. An agent drives every console API route with
 * its ordinary API key, and only the HTML pages need a session — which is
 * deliberate, because an agent must never be told to open a browser in order to
 * be a sponsor.
 */
export function registerConsoleRoutes(v1: FastifyInstance, deps: RouteDependencies): void {
  const { console: consoleDeps } = deps

  /**
   * Ask for a sign-in link.
   *
   * Always `202`, and always the same body. A `200` for a known address and a
   * `202` for an unknown one would be the disclosure this endpoint is shaped to
   * avoid, written in the status line instead of the body.
   */
  v1.post('/console/sign-in', async (request, reply) => {
    const parsed = RequestLinkSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(ERROR_STATUS.validation_failed).send({
        code: 'validation_failed',
        message: 'A sign-in request carries one field: `email`.',
      })
    }

    const result = await requestSignIn(parsed.data.email, callerKey(request), consoleDeps)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.status(202).send(CHECK_YOUR_MAIL)
  })

  /**
   * Sign up, which is the same call with a name on it.
   *
   * A taken address answers exactly as a fresh one does. A taken *name* is said
   * plainly — names are already public through `POST /v1/agents/name-check`, and
   * a sign-up that failed silently would leave somebody waiting for mail that is
   * never coming.
   */
  v1.post('/console/sign-up', async (request, reply) => {
    const parsed = SignUpSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(ERROR_STATUS.validation_failed).send({
        code: 'validation_failed',
        message: 'A sign-up carries two fields: `name` and `email`.',
      })
    }

    const result = await signUp(parsed.data, callerKey(request), consoleDeps)

    if (result.outcome === 'name-taken') {
      return reply.status(ERROR_STATUS.conflict).send({
        code: 'conflict',
        message: `The name "${result.name}" is taken.`,
      })
    }

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.status(202).send(CHECK_YOUR_MAIL)
  })

  /**
   * Follow the link.
   *
   * The session leaves in `Set-Cookie` and the body carries nothing but the
   * identity it belongs to. Putting the value in the body as well would be
   * convenient for a test and would put a bearer secret into every proxy log
   * between here and the browser.
   */
  v1.post('/console/sign-in/redeem', async (request, reply) => {
    const parsed = RedeemSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(ERROR_STATUS.validation_failed).send({
        code: 'validation_failed',
        message: 'Redeeming a link carries one field: `token`.',
      })
    }

    const result = await redeemSignIn(parsed.data.token, callerKey(request), consoleDeps)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    setSessionCookie(reply, result.session, result.maxAgeSeconds)

    return reply.status(200).send({ agentId: result.agentId })
  })
}

/**
 * The key both limiters that are not per-address run on.
 *
 * `clientIp` resolves the caller through the same precedence every other
 * front-door route uses, so a change there reaches this without a second
 * implementation. The literal fallback is what a caller whose address cannot be
 * resolved shares, and until `kolonie-infra#56` lands that is most of them.
 */
function callerKey(request: FastifyRequest): string {
  return clientIp(request.headers, request.socket.remoteAddress ?? '')
}

/**
 * Write the session cookie.
 *
 * Every attribute here is doing something:
 *
 * - `Secure` — the `__Host-` prefix requires it, and a session on a plaintext
 *   hop is a session anyone on the path holds
 * - `HttpOnly` — script on the page cannot read it, so an injected script cannot
 *   exfiltrate it
 * - `SameSite=Lax` — a cross-site `POST` carries no cookie, which is what makes
 *   a session-authenticated mutation safe from a form on somebody else's page.
 *   `Strict` was considered and rejected: it also strips the cookie from an
 *   ordinary top-level link, so a sponsor following a link from its own mail
 *   would arrive signed out
 * - `Max-Age` — an absolute lifetime, matching the row's `expires_at`. The
 *   browser and the database agree on when this ends, and the database is the
 *   one that decides
 * - `Path=/` — required by the prefix
 *
 * Set by hand rather than through a cookie plugin: this is the only cookie the
 * API sets, and a dependency whose defaults could change is a worse deal than
 * six attributes written out where they can be read.
 */
function setSessionCookie(reply: FastifyReply, session: string, maxAgeSeconds: number): void {
  reply.header(
    'set-cookie',
    `${SESSION_COOKIE}=${session}; Max-Age=${maxAgeSeconds}; Path=/; Secure; HttpOnly; SameSite=Lax`,
  )
}
