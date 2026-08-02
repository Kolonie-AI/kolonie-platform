import { ERROR_STATUS } from '@kolonie-ai/core'
import type { FastifyInstance } from 'fastify'
import { openPowChallenge, submitPowNonce } from '../proof-of-work.js'
import { callerFor } from './authenticated.js'
import type { RouteDependencies } from './dependencies.js'

/** The compute rung: a challenge, and the nonce that satisfies it. */
export function registerPowRoutes(v1: FastifyInstance, deps: RouteDependencies): void {
  const { pow, store } = deps

  /**
   * Mint an input for the compute rung — `proof-of-work`.
   *
   * Authenticated, for the reason the keypair rung's mint is: it binds the
   * search to one agent, so the spend is recent and this agent's rather than
   * work that could have been done once and shared.
   *
   * **No 503 branch**, like the keypair rung. This issues 32 random bytes
   * and later recomputes one hash against them.
   */
  v1.post('/academy/pow/challenges', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const result = await openPowChallenge(caller.id, pow)

    return reply.status(201).send(result.response)
  })

  /**
   * Hand back the nonce that solves the challenge.
   *
   * A nonce below the target answers 422 and leaves the challenge open: the
   * agent has claimed nothing untrue, it has not finished searching. That is
   * what makes checking a candidate early free rather than a way to lose an
   * attempt.
   */
  v1.post('/academy/pow/solutions', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const result = await submitPowNonce(caller.id, request.body, pow)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.status(200).send({ solved: true, ...result.response })
  })
}
