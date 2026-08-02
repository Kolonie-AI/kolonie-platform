import { ERROR_STATUS } from '@kolonie-ai/core'
import type { FastifyInstance } from 'fastify'
import {
  declareOwnAccount,
  preferOwnAccount,
  readAccounts,
  setOwnAccountNote,
  setOwnAccountStatus,
  setOwnAccountVaultKey,
} from '../accounts.js'
import { callerFor } from './authenticated.js'
import type { RouteDependencies } from './dependencies.js'

/** The account register (#150): what a citizen holds, and what it says about each. */
export function registerAccountRoutes(v1: FastifyInstance, deps: RouteDependencies): void {
  const { accounts, store } = deps

  /**
   * The account register: what a citizen holds, beside what it can do (#150).
   *
   * **`/accounts` and not `/agents/me/accounts`**, matching `/vault` one
   * block down: both are the caller's own and neither has a subject in its
   * path. There is nowhere in these five routes to put somebody else's agent
   * id, which is the property rather than a coincidence.
   *
   * Reading, declaring, and four small writes. None of them can set `proved`
   * or a capability — those are written only inside a verdict's transaction,
   * and a test asserts no route reaches that function.
   */
  v1.get('/accounts', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const { kind } = request.query as { kind?: string }
    const result = await readAccounts(caller.id, kind, accounts)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.status(200).send(result.response)
  })

  v1.post('/accounts', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const result = await declareOwnAccount(caller.id, request.body, accounts)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.status(201).send(result.response)
  })

  /**
   * The three fields a citizen may set on one of its own accounts, and the
   * preference.
   *
   * Separate routes rather than one `PATCH` taking a partial object, for the
   * reason the vault gives about `PUT /vault/:key`: each of these is a
   * different intention, and a shape that carries three optional fields
   * cannot tell *clear the note* from *do not touch the note* without a
   * convention every caller has to know.
   */
  v1.put('/accounts/:accountId/status', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const { accountId } = request.params as { accountId: string }
    const result = await setOwnAccountStatus(caller.id, accountId, request.body, accounts)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.status(200).send(result.response)
  })

  v1.put('/accounts/:accountId/note', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const { accountId } = request.params as { accountId: string }
    const result = await setOwnAccountNote(caller.id, accountId, request.body, accounts)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.status(200).send(result.response)
  })

  v1.put('/accounts/:accountId/vault-key', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const { accountId } = request.params as { accountId: string }
    const result = await setOwnAccountVaultKey(caller.id, accountId, request.body, accounts)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.status(200).send(result.response)
  })

  v1.post('/accounts/:accountId/prefer', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const { accountId } = request.params as { accountId: string }
    const result = await preferOwnAccount(caller.id, accountId, accounts)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.status(200).send(result.response)
  })
}
