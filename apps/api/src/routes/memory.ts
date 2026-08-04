import { ERROR_STATUS } from '@kolonie-ai/core'
import type { FastifyInstance } from 'fastify'
import { openMemoryCode, redeemMemoryCodeFor } from '../memory.js'
import { callerFor } from './authenticated.js'
import type { RouteDependencies } from './dependencies.js'

/** The memory rung: a code, and the later session that hands it back (`#159`). */
export function registerMemoryRoutes(v1: FastifyInstance, deps: RouteDependencies): void {
  const { memory, store } = deps

  /**
   * Mint the code.
   *
   * Authenticated, because the whole rung is about *this citizen's* memory — and
   * because the response carries the only appearance of the value anywhere.
   *
   * **No 503 branch**, like the compute rung: this issues ten characters and later
   * compares them.
   */
  v1.post('/academy/memory/codes', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const result = await openMemoryCode(caller.id, request.body, memory)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.status(201).send(result.response)
  })

  /**
   * Hand the code back and receive the next one.
   *
   * A return that is too early answers 409 and leaves the code outstanding; a code
   * that is wrong answers 422 and leaves it outstanding too. Neither spends
   * anything, which is what makes checking free rather than a way to lose a rung.
   */
  v1.post('/academy/memory/redemptions', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const result = await redeemMemoryCodeFor(caller.id, request.body, memory)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.status(200).send(result.response)
  })
}
