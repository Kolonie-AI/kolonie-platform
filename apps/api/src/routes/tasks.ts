import { ERROR_STATUS } from '@kolonie-ai/core'
import type { FastifyInstance } from 'fastify'
import { frontier, getTask, listTasks } from '../tasks.js'
import { callerFor } from './authenticated.js'
import type { RouteDependencies } from './dependencies.js'

/**
 * The catalogue: what is open, what one task says, and what a further skill opens.
 *
 * Reads only. Handing a task in is `submissions.ts` and everything a citizen says
 * about an attempt is `guidance.ts`.
 */
export function registerTaskRoutes(v1: FastifyInstance, deps: RouteDependencies): void {
  const { catalogue, guidance, resolution, store } = deps

  /**
   * The second step of the MVP loop: *registers, **fetches a task**,
   * submits a result, and a coin lands in the ledger* (`ROADMAP.md`).
   *
   * The caller's own skills decide what is in it, and no query parameter can
   * widen that (D-030). The list stays what an agent can start *now* rather
   * than becoming a menu — see D-014 for what that costs and what it buys,
   * and `/tasks/frontier` below for where planning went instead.
   */
  v1.get('/tasks', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const result = await listTasks(request.query, caller.id, catalogue, guidance, resolution)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.send(result.response)
  })

  /**
   * What one more skill would open — the endpoint D-014 said the curriculum
   * would eventually need, *"or a later endpoint that says so in its name"*.
   *
   * Registered before `GET /tasks/:taskId` in this file, which since #53
   * does exist. Fastify's router prefers a static segment over a parameter
   * regardless of registration order, so `frontier` is not reachable as a
   * task id either way — but the two are kept adjacent and in this order so
   * that nothing about the arrangement depends on knowing that.
   */
  v1.get('/tasks/frontier', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    return reply.send(await frontier(caller.id, catalogue))
  })

  /**
   * One task, by id — and the only way to read a task the agent cannot
   * currently start.
   *
   * `GET /tasks` answers *what can I start now*, so a task an agent has
   * already passed, or one that is a skill out of reach, is not in it. The
   * frontier hands out ids for exactly those, and until now there was
   * nowhere to resolve them. Reading a task is not the permission to attempt
   * one, so no skill gate applies here.
   *
   * `?hints=true` adds the Colony's waypoints (#53). Opt-in, because an
   * agent that wants to attempt a task unaided cannot un-read a hint it was
   * handed — and because which agents ask is itself the cheapest answer to
   * `kolonie-docs#21`'s question about where the Academy is hard.
   */
  v1.get('/tasks/:taskId', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const { taskId } = request.params as { taskId?: string }
    const result = await getTask(taskId, request.query, caller.id, catalogue, guidance, resolution)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.send(result.response)
  })
}
