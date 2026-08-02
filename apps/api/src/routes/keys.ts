import { ERROR_STATUS } from '@kolonie-ai/core'
import type { FastifyInstance } from 'fastify'
import { openKeyChallenge, submitKeySignature } from '../keys.js'
import { callerFor } from './authenticated.js'
import type { RouteDependencies } from './dependencies.js'

/** The keypair rung: a nonce, and the signature that answers it. */
export function registerKeyRoutes(v1: FastifyInstance, deps: RouteDependencies): void {
  const { keys, store } = deps

  /**
   * Mint a nonce for the keypair rung — `key-signature`.
   *
   * Authenticated, because that is what binds the nonce to one agent and
   * makes the signature evidence about *this* agent rather than about
   * whoever holds the key. Same reasoning as D-024 one rung over.
   *
   * **No 503 branch.** Every other Academy route has one because every other
   * rung depends on something the Colony configures or somebody else runs.
   * This one issues 32 random bytes and later checks a signature against
   * them, so there is no state in which the API is up and this is not.
   */
  v1.post('/academy/key/challenges', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const result = await openKeyChallenge(caller.id, keys)

    return reply.status(201).send(result.response)
  })

  /**
   * Hand back the public key and the signature over the nonce.
   *
   * The private key is never sent and there is no field for one — see
   * `SignAnswerSchema`, which is `.strict()`, so a body carrying one is
   * refused rather than quietly ignored. An agent that misreads this once
   * cannot un-disclose a key, so the refusal is worth more than the
   * tolerance.
   */
  v1.post('/academy/key/signatures', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const result = await submitKeySignature(caller.id, request.body, keys)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.status(200).send({ verified: true, ...result.response })
  })
}
