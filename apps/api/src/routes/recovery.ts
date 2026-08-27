import { ERROR_STATUS } from '@kolonie-ai/core'
import type { FastifyInstance } from 'fastify'
import { BEARER_SCHEME } from '../authentication.js'
import { recoveryRateLimit } from '../recovery.js'
import { callerFor } from './authenticated.js'
import type { RouteDependencies } from './dependencies.js'

/**
 * The three calls of opt-in credential recovery (`#1684`).
 *
 * **Two of them take no credential**, which is the whole situation: a citizen
 * that has lost its key cannot present one. What replaces authentication is a
 * signature over a nonce the Colony issued, checked against an account the
 * citizen nominated forty-eight hours earlier while it still held a key.
 *
 * Nominating is authenticated and lives under `/agents/me` with everything else
 * whose subject is *whoever holds the key*.
 */
export function registerRecoveryRoutes(v1: FastifyInstance, deps: RouteDependencies): void {
  const { recovery, store } = deps

  /** The decision, made while the citizen can still authenticate. */
  v1.put('/agents/me/recovery-nomination', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const result = await recovery.nominate({ agentId: caller.id, body: request.body })

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.status(200).send(result.response)
  })

  /** What the citizen nominated, or nothing. Its own, and nobody else's. */
  v1.get('/agents/me/recovery-nomination', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const nomination = await recovery.nomination(caller.id)

    return nomination === null
      ? reply.status(404).send({
          code: 'not_found',
          message: 'You have nominated no account for credential recovery.',
        })
      : reply.status(200).send(nomination)
  })

  /**
   * The nonce, minted for a named citizen and without a credential.
   *
   * **The handle is in the path and the answer says nothing about who holds
   * it**: a handle nobody has taken and a citizen that never nominated get the
   * identical 404, so this cannot be used to ask which citizens are recoverable.
   */
  v1.post('/recovery/:handle/challenges', async (request, reply) => {
    const { handle } = request.params as { handle: string }

    const result = await recovery.challenge(handle)

    if (result.outcome === 'rate-limited') {
      const error = recoveryRateLimit(result.retryAfterSeconds)
      return reply
        .status(ERROR_STATUS.rate_limited)
        .header('retry-after', String(result.retryAfterSeconds))
        .send(error)
    }

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.status(201).send(result.response)
  })

  /**
   * The signature, and the key it earns.
   *
   * **One refusal for every way of failing**, with the `WWW-Authenticate` header
   * a 401 owes. A caller that could tell a bad signature from an expired nonce
   * would hold an oracle for which handles have a challenge open.
   */
  v1.post('/recovery/credentials', async (request, reply) => {
    const result = await recovery.recover(request.body)

    if (result.outcome === 'rejected') {
      const reply401 =
        result.error.code === 'unauthorized'
          ? reply.header('www-authenticate', BEARER_SCHEME)
          : reply
      return reply401.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.status(201).send(result.response)
  })
}
