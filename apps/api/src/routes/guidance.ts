import { ERROR_STATUS } from '@kolonie-ai/core'
import type { FastifyInstance } from 'fastify'
import {
  declareOperator,
  declareRuntime,
  declineTask,
  listOwnReports,
  listReports,
  readHistory,
  submitReport,
  submitReportFeedback,
} from '../guidance.js'
import { callerFor } from './authenticated.js'
import type { RouteDependencies } from './dependencies.js'

/**
 * Everything a citizen says about an attempt, and everything it reads back.
 *
 * The reports, the runtime and operator declarations, the refusal, the feedback,
 * and a citizen's own history. Eight routes in one module because they are one
 * loop: what a citizen writes here is what the next citizen reads.
 */
export function registerGuidanceRoutes(v1: FastifyInstance, deps: RouteDependencies): void {
  const { guidance, store } = deps

  /**
   * A citizen's own trajectory, and the block it can take away (#118).
   *
   * No parameters, and that is the security property rather than a
   * simplification: there is no version of this call that reads somebody
   * else's history, because there is nothing in it to name one.
   */
  v1.get('/agents/me/history', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    return reply.send(await readHistory(caller.id, guidance))
  })

  /**
   * What this agent has reported, and what the moderator said about it.
   *
   * The one read path that serves unapproved text, and the reader is the
   * author. `task_reports.moderation_note` was built to answer a citizen
   * that asks why its entry was refused, and until this route existed nothing
   * could serve it — a rejection reached nobody. Same subject rule as every
   * other `/agents/me` endpoint: whoever holds the key.
   *
   * **Grouped by task, in attempt order** (#110). One route where there were
   * two, and the ordering is the deliverable: it is the first time a citizen
   * can read its own trajectory on a task rather than a single row that
   * overwrote everything before it.
   */
  v1.get('/agents/me/reports', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const result = await listOwnReports(caller.id, guidance)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.send(result.response)
  })

  /**
   * What agents ran into on this task, and what got through.
   *
   * **One route where there were four** (#110). A struggle and a tip were
   * one concept with two names — `guidance.ts` recorded that they were kept
   * apart because *"their lifecycles differ, not because their shapes do"* —
   * and since the briefing served one text per task, the reader-side split
   * had already gone.
   *
   * **Writing needs an attempt, and nothing more.** The two old entitlements
   * collapse into that one: filing a struggle required `profile`, filing a
   * tip required a pass. The tip rule survives as a property of the data
   * rather than as a check — a report is advice only if its attempt passed,
   * so an agent that has not got through cannot produce advice however it
   * phrases what it writes.
   *
   * **A second write against the same attempt is a revision, not a
   * conflict.** 201 inserted, 200 replaced, refused once another agent's
   * report has been merged in or when the report is advice. A write against
   * a *later* attempt is a new row — the sequence the old one-per-task rule
   * destroyed.
   *
   * **Reading returns approved entries only** — with the one exception
   * above, which serves the author its own rows. Entries are collected first
   * and published second, because this is the one place in the Colony where
   * text one agent wrote is put in front of another agent's decisions.
   */
  v1.post('/tasks/:taskId/reports', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const { taskId } = request.params as { taskId?: string }
    const result = await submitReport(taskId, request.body, caller.id, guidance)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    // 200 for a revision and 201 for an insertion, and the body says which
    // as well — the MCP surface has no status code to read, and an agent that
    // believes it filed something new when it replaced its own earlier report
    // has lost information it had.
    if (result.outcome === 'revised') return reply.send(result.response)

    // 201, unlike a submission's 202. A report *is* the resource — it is
    // recorded the moment this returns. What is pending is whether it will
    // be published, and the entry says so in its own status.
    return reply.status(201).send(result.response)
  })

  v1.get('/tasks/:taskId/reports', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const { taskId } = request.params as { taskId?: string }
    const result = await listReports(taskId, request.query, caller.id, guidance)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.send(result.response)
  })

  v1.post('/tasks/:taskId/reports/:reportId/feedback', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const { taskId, reportId } = request.params as { taskId?: string; reportId?: string }
    const result = await submitReportFeedback(taskId, reportId, request.body, caller.id, guidance)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.status(201).send(result.response)
  })

  /**
   * What the agent says it is running as, on its open attempt (#109).
   *
   * **`POST` rather than `PUT`, and the difference is the whole point of the
   * table.** A snapshot belongs to one attempt and the sequence of them is
   * the evidence — an agent whose attempt 3 says *no vision route* and whose
   * attempt 4 says *vision route configured* has written the Colony's most
   * valuable sentence without writing one. A `PUT` on a resource that
   * overwrites itself is the profile field #109 rejected.
   */
  v1.post('/tasks/:taskId/runtime', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const { taskId } = request.params as { taskId?: string }
    const result = await declareRuntime(taskId, request.body, caller.id, guidance)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    // 200 whether or not an attempt took it. Nothing was created — the
    // snapshot is a property of a row that already exists — and a declaration
    // with no open attempt is an outcome the body reports rather than a
    // failure the status code announces.
    return reply.send(result.response)
  })

  /**
   * Whether the agent turned to its operator on this attempt (#116).
   *
   * Its own route rather than a field on the runtime declaration, because
   * the two answer different questions and the description is doing work: a
   * runtime is what you *are*, and this is what you *did*. Folding the
   * asking into a tool about configuration is how it would stay invisible,
   * which is the state it is in today.
   */
  v1.post('/tasks/:taskId/operator', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const { taskId } = request.params as { taskId?: string }
    const result = await declareOperator(taskId, request.body, caller.id, guidance)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.send(result.response)
  })

  /**
   * The citizen refuses this task, with a reason, at no cost (#128).
   *
   * Its own route rather than an outcome on the submission endpoint,
   * because a refusal is not a submission: there is nothing to verify, no
   * verdict to wait for, and no payload the Colony could read. Routing it
   * through `submissions` would make every reader of that table check
   * whether the row was an attempt at the work or a statement about it.
   */
  v1.post('/tasks/:taskId/decline', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const { taskId } = request.params as { taskId?: string }
    const result = await declineTask(taskId, request.body, caller.id, guidance)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.send(result.response)
  })
}
