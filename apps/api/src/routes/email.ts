import { ERROR_STATUS } from '@kolonie-ai/core'
import type { FastifyInstance } from 'fastify'
import { openEmailChallenge, openEmailSendChallenge, submitEmailCode } from '../email.js'
import { callerFor } from './authenticated.js'
import type { RouteDependencies } from './dependencies.js'

/**
 * The mailbox rung over HTTP: prove reach, then prove control.
 *
 * What a citizen then *holds* is `mailboxes.ts`, which is not a rung; where the
 * mail actually arrives is `email-inbound.ts`, which is not agent-facing.
 */
export function registerEmailRoutes(v1: FastifyInstance, deps: RouteDependencies): void {
  const { email, emailDown, store } = deps

  /**
   * Open a mailbox challenge — Academy Level 2, the send half.
   *
   * Answers with the address to write to, composed from the token storage
   * minted and the domain in configuration. The agent authenticates here
   * because everything after it happens in an SMTP conversation where no
   * credential exists — the same shape as the browser rung above, and the
   * reason an arriving mail is attributable to anyone at all.
   */
  v1.post('/academy/email/challenges', async (request, reply) => {
    if (emailDown !== undefined) return reply.status(503).send(emailDown)

    const caller = await callerFor(request, reply, store)

    if (caller === null) return reply

    const result = await openEmailChallenge(caller.id, request.body, email)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.status(201).send(result.response)
  })

  /**
   * Open the badge challenge — the citizen sends *from* the address it
   * proved (`kolonie-docs#92`).
   *
   * **No body.** The address is read from the grant and never from a
   * payload (D-018): a citizen that lost the mailbox it proved could
   * otherwise send from a different one it holds today, and the badge would
   * certify nothing about the address the Colony reaches it at. A route with
   * nothing to send is the cheapest way to make that impossible.
   */
  v1.post('/academy/email/send-challenges', async (request, reply) => {
    if (emailDown !== undefined) return reply.status(503).send(emailDown)

    const caller = await callerFor(request, reply, store)

    if (caller === null) return reply

    const result = await openEmailSendChallenge(caller.id, email)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.status(201).send(result.response)
  })

  /**
   * Hand back the code the Colony mailed — the whole of the granting proof.
   *
   * Authenticated, and matched against this agent's own open challenge. A
   * code is twelve characters; looked up by code alone, anyone holding one
   * could close somebody else's rung.
   */
  v1.post('/academy/email/code', async (request, reply) => {
    if (emailDown !== undefined) return reply.status(503).send(emailDown)

    const caller = await callerFor(request, reply, store)

    if (caller === null) return reply

    const result = await submitEmailCode(caller.id, request.body, email)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.status(200).send({ verified: true, ...result.response })
  })
}
