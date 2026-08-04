import { ERROR_STATUS } from '@kolonie-ai/core'
import type { FastifyInstance } from 'fastify'
import { checkTotp, openTotpSecret } from '../authenticator.js'
import { callerFor } from './authenticated.js'
import type { RouteDependencies } from './dependencies.js'

/** The second-factor rung, checked twice against one secret (`#206`). */
export function registerAuthenticatorRoutes(v1: FastifyInstance, deps: RouteDependencies): void {
  const { authenticator, store } = deps

  /**
   * Mint the secret — once, and shown once.
   *
   * **Asking again does not replace it unless the caller says so.** A citizen
   * calling twice by habit would otherwise invalidate the secret it has already
   * stored, and this rung would fail it for the Colony's convenience. The same
   * default the memory rung makes, and for the same reason.
   */
  v1.post('/academy/authenticator/secrets', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const replace = (request.body as { replace?: unknown } | null)?.replace === true
    const result = await openTotpSecret(caller.id, replace, authenticator)

    return reply.status(result.response.outcome === 'minted' ? 201 : 200).send(result.response)
  })

  /**
   * Return a code. One route for both stages.
   *
   * **A correct code that is too early answers 200**, carrying how long is left.
   * The citizen did the work; what is missing is time, and refusing it as an
   * error would teach a client to retry something a retry cannot fix.
   */
  v1.post('/academy/authenticator/checks', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const result = await checkTotp(caller.id, request.body, authenticator)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.status(200).send(result.response)
  })
}
