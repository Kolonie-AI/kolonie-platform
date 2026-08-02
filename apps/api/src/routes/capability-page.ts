import { ERROR_STATUS } from '@kolonie-ai/core'
import type { FastifyInstance } from 'fastify'
import { currentProbe, reportStep, verifyCaptcha } from '../academy.js'
import type { RouteDependencies } from './dependencies.js'

/**
 * The Browser Capability Gate: the page a browser drives, and the retired badge.
 *
 * These are called by a browser following a link rather than by an agent holding
 * a contract, which is why the pages themselves are static files mounted in
 * `app.ts` and only the state transitions are here.
 */
export function registerCapabilityPageRoutes(v1: FastifyInstance, deps: RouteDependencies): void {
  const { academy, capabilityDown, unavailable } = deps

  /**
   * The step the capability challenge is on, and the declaration to measure.
   *
   * **Unauthenticated, like the verify route below and for the same reason**
   * — the caller is a browser holding no API key, and the challenge id is
   * the credential (D-024).
   *
   * Only the outstanding step is ever returned. Handing out all three at
   * once would turn a sequence into a document, and the property this rung
   * claims — that the page was *operated*, not merely fetched — lives
   * entirely in that ordering.
   */
  v1.get('/academy/browser/:challengeId', async (request, reply) => {
    if (capabilityDown !== undefined) return reply.status(503).send(capabilityDown)

    const { challengeId } = request.params as { challengeId: string }
    const result = await currentProbe(challengeId, academy)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    /**
     * **Never cached, and a real browser is what proved this necessary.**
     *
     * The url is stable while the answer is not: it names a challenge, and
     * what it returns is whichever step is outstanding *now*. Without this
     * header Firefox served run three the step-one probe it had kept from
     * run two — so the page measured a step already done, the server
     * correctly refused it as out of order, and the challenge sat at two
     * forever. Every layer behaved exactly as designed and the rung was
     * still unpassable.
     *
     * It cost nothing to find here and would have cost an arriving agent an
     * afternoon, with nothing in the response to suggest a cache.
     */
    return reply.header('cache-control', 'no-store').send(result.response)
  })

  /**
   * One measured step, checked and recorded.
   *
   * Answers the next probe while steps remain and the cleared verdict on the
   * last, so the page never has to ask what to do next. Same public-surface
   * caveat as registration: `#10` covers rate limiting here too.
   */
  v1.post('/academy/browser/:challengeId/steps', async (request, reply) => {
    if (capabilityDown !== undefined) return reply.status(503).send(capabilityDown)

    const { challengeId } = request.params as { challengeId: string }
    const result = await reportStep(challengeId, request.body, academy)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.send(result.response)
  })

  /**
   * What the challenge page needs in order to render the widget.
   *
   * An hCaptcha sitekey is a public value by design — it is embedded in
   * every page that uses one. It is served rather than baked into the HTML
   * so the static file stays static and the key stays configuration; the
   * secret half never leaves this process.
   */
  v1.get('/academy/captcha-config', async (_request, reply) => {
    if (unavailable !== undefined) return reply.status(503).send(unavailable)
    return reply.send({ sitekey: academy.captcha.sitekey })
  })

  /**
   * Where a solved challenge is checked and bound to an agent.
   *
   * **Deliberately unauthenticated**, and the only other write in this API
   * that is. The caller is a browser holding no API key; the challenge id
   * stands in for the credential, being unguessable, single-use and
   * short-lived. `#10` (rate limiting on the public surface) covers this
   * endpoint as well as registration.
   */
  v1.post('/academy/verify-captcha', async (request, reply) => {
    if (unavailable !== undefined) return reply.status(503).send(unavailable)

    const result = await verifyCaptcha(request.body, academy)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.send(result.response)
  })
}
