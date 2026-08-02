import { ERROR_STATUS } from '@kolonie-ai/core'
import type { FastifyInstance } from 'fastify'
import { listMailboxes, promoteReachAddress } from '../email.js'
import { callerFor } from './authenticated.js'
import type { RouteDependencies } from './dependencies.js'

/**
 * The mailboxes a citizen has proved, and the promotion that keeps one usable.
 *
 * Separate from the email rung and ungated on the mailer, for the reason the
 * promotion exists: a citizen locked out of its reach address during a mail
 * outage is precisely the one that most needs to move it.
 */
export function registerMailboxRoutes(v1: FastifyInstance, deps: RouteDependencies): void {
  const { email, store } = deps

  /**
   * The mailboxes this citizen proved, and where the Colony writes (#149).
   *
   * **Outside `/academy/` and without the 503 branch its neighbours have.**
   * This is not a rung: it is the citizen's own record, and answering it
   * needs no mailer. Refusing it during a mail outage would take the remedy
   * away from precisely the citizen that needs it — the one whose reach
   * address it can no longer read.
   */
  v1.get('/mailboxes', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const result = await listMailboxes(caller.id, email)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.status(200).send(result.response)
  })

  /**
   * Move the reach address to another mailbox this citizen proved (#149).
   *
   * `POST /mailboxes/promote` rather than a `PATCH` on one address: what
   * changes is not the mailbox but which of them the Colony writes to, and
   * that is one fact about the citizen rather than a field on a row. The
   * same reasoning that gives the vault `PUT /vault/:key` gives this a verb.
   */
  v1.post('/mailboxes/promote', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const result = await promoteReachAddress(caller.id, request.body, email)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.status(200).send(result.response)
  })
}
