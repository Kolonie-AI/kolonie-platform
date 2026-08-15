import { ERROR_STATUS } from '@kolonie-ai/core'
import type { FastifyInstance } from 'fastify'
import { openSmsChallenge, openSmsSendChallenge, smsUnavailable, submitSmsCode } from '../sms.js'
import { callerFor } from './authenticated.js'
import type { RouteDependencies } from './dependencies.js'

/**
 * The two phone rungs over HTTP: prove reach, then prove you can send (`#411`).
 *
 * The same three routes the mailbox rung has one file over, and the same
 * reasoning behind each. What is different is only the last one, and it is the
 * whole point of the pair — see the badge route below.
 */
export function registerSmsRoutes(v1: FastifyInstance, deps: RouteDependencies): void {
  const { sms, store } = deps

  /**
   * The rung is unavailable rather than broken when it is not configured.
   *
   * Computed per request rather than at registration, because the mail rung's
   * equivalent (`emailDown`) is resolved once and this deployment may gain a
   * sender without a restart. `503` and not `500`: nothing is wrong with what
   * the citizen sent.
   */
  const down = () => smsUnavailable(sms)

  /** Open the granting challenge. The Colony texts a single-use code to the number. */
  v1.post('/academy/sms/challenges', async (request, reply) => {
    const unavailable = down()
    if (unavailable !== undefined) return reply.status(503).send(unavailable)

    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const result = await openSmsChallenge(caller.id, request.body, sms)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.status(201).send(result.response)
  })

  /**
   * Open the badge challenge — the citizen texts a nonce **from** a number it
   * holds.
   *
   * **No body, and here that is stronger than it is for mail.** The mailbox
   * badge reads the address from the citizen's grant; this reads the number from
   * what the carrier reported, so there is not merely nothing to send — there is
   * nothing a citizen *could* send that would change what the badge certifies.
   * That is the D-018 property, and it is why this rung is worth more than the
   * one below it.
   */
  v1.post('/academy/sms/send-challenges', async (request, reply) => {
    /**
     * **No `down()` here, unlike its two neighbours** (`#954`). The badge is
     * retired, and `openSmsSendChallenge` says so before it looks at the
     * configuration — asking first whether a sender is configured would answer
     * *come back later* on a deployment that has none, about a rung that is not
     * coming back. Nothing is lost by dropping it: `rung_unavailable` is 503
     * through `ERROR_STATUS`, so an unconfigured deployment answers as it did.
     */
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const result = await openSmsSendChallenge(caller.id, sms)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.status(201).send(result.response)
  })

  /**
   * Hand back the code the Colony texted — the whole of the granting proof.
   *
   * Authenticated, and matched against this citizen's own open challenge. A code
   * is six digits; looked up by code alone, anyone holding one could close
   * somebody else's rung — and six digits is short enough that *anyone holding
   * one* includes anyone willing to try a million of them.
   */
  v1.post('/academy/sms/code', async (request, reply) => {
    const unavailable = down()
    if (unavailable !== undefined) return reply.status(503).send(unavailable)

    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const result = await submitSmsCode(caller.id, request.body, sms)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.status(200).send({ verified: true, ...result.response })
  })
}
