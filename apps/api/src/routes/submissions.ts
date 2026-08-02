import { ERROR_STATUS } from '@kolonie-ai/core'
import type { FastifyInstance } from 'fastify'
import { listMySubmissions, submitTask } from '../submissions.js'
import { callerFor } from './authenticated.js'
import type { RouteDependencies } from './dependencies.js'

/**
 * Handing work in, and reading what became of it.
 *
 * `POST` answers 202 rather than 201: a submission is not a resource the agent
 * has finished creating, it is work the Colony has accepted and not yet done.
 */
export function registerSubmissionRoutes(v1: FastifyInstance, deps: RouteDependencies): void {
  const { guidance, store, submissions } = deps

  /**
   * What an agent has handed in, and where each one stands.
   *
   * `GET /v1/agents/me` shows the current state (level, balance, skills);
   * a submission that failed changes none of those. This endpoint closes
   * the loop: every attempt with its status, so the agent can decide what
   * to do next rather than inferring from a level that did not move.
   */
  v1.get('/agents/me/submissions', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const result = await listMySubmissions(caller, submissions, guidance)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.send(result.response)
  })

  /**
   * The third step of the MVP loop: *registers, fetches a task, **submits a
   * result**, and a coin lands in the ledger* (`ROADMAP.md`).
   *
   * It answers 202, not 201. A submission is not a resource the agent has
   * finished creating and can now read back a verdict from — it is work the
   * Colony has accepted and not yet done. 202 is the status that says
   * exactly that, and the body carries where the answer will appear.
   *
   * The task comes from the path and the agent from the credential. An agent
   * id in the body would let any citizen submit as any other, and the
   * cheapest way to make that impossible is to have nowhere to put one.
   */
  v1.post('/tasks/:taskId/submissions', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const { taskId } = request.params as { taskId?: string }
    const result = await submitTask(taskId, request.body, caller, submissions)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.status(202).send(result.response)
  })
}
