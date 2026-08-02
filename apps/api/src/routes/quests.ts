import { ERROR_STATUS, type Timestamp } from '@kolonie-ai/core'
import type { FastifyInstance, FastifyReply } from 'fastify'
import {
  editQuestDraft,
  listQuests,
  publishQuest,
  readQuest,
  readReviewQueue,
  refuseQuest,
  submitQuest,
  writeQuestDraft,
  type QuestResult,
} from '../quests.js'
import { callerFor } from './authenticated.js'
import { stewardFor } from './privileged.js'
import type { RouteDependencies } from './dependencies.js'

/**
 * The quest write path and the review (`#176`).
 *
 * **Two audiences on one prefix, separated by the guard and not by the path.**
 * `/v1/quests/review` is a steward's; everything else belongs to whoever wrote
 * the quest. Splitting them onto different prefixes would suggest a second
 * surface exists, and there is only one — `stewardFor` is the whole difference.
 *
 * **There is no route here that edits somebody else's quest text**, and that
 * absence is load-bearing rather than incidental. A steward publishes or
 * refuses; a steward that edited would become the author, and the self-approval
 * ban would have been walked around rather than enforced. `quests.test.ts`
 * asserts the router carries no such route.
 */
export function registerQuestRoutes(v1: FastifyInstance, deps: RouteDependencies): void {
  const { store, quests } = deps

  /** Write a draft. Nothing is committed and nothing is visible to anyone else. */
  v1.post('/quests', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const result = await writeQuestDraft({ authorId: caller.id, body: request.body }, quests)
    return send(reply, result, 201)
  })

  /** Everything this account has written, in every status. */
  v1.get('/quests', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    return send(reply, await listQuests(caller.id, quests))
  })

  /**
   * The steward's queue.
   *
   * Declared before `/quests/:questId` for readability rather than for
   * correctness — Fastify's radix router prefers a static segment over a
   * parametric one regardless of registration order — and there is a test
   * asserting a steward reaches this rather than the read-one route.
   */
  v1.get('/quests/review', async (request, reply) => {
    const steward = await stewardFor(request, reply, store)
    if (steward === null) return reply

    return send(reply, await readReviewQueue(quests))
  })

  /** One of the caller's own quests. */
  v1.get('/quests/:questId', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const { questId } = request.params as { questId?: string }
    return send(reply, await readQuest({ authorId: caller.id, questId }, quests))
  })

  /** Change a draft, or correct a refused quest. */
  v1.patch('/quests/:questId', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const { questId } = request.params as { questId?: string }
    const result = await editQuestDraft(
      { authorId: caller.id, questId, body: request.body, at: now() },
      quests,
    )

    return send(reply, result)
  })

  /** Submit it for review. From here the text is fixed until somebody decides. */
  v1.post('/quests/:questId/submit', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const { questId } = request.params as { questId?: string }
    return send(reply, await submitQuest({ authorId: caller.id, questId, at: now() }, quests))
  })

  /** Publish it, which is also when its money moves. */
  v1.post('/quests/:questId/publish', async (request, reply) => {
    const steward = await stewardFor(request, reply, store)
    if (steward === null) return reply

    const { questId } = request.params as { questId?: string }
    return send(reply, await publishQuest({ stewardId: steward.id, questId, at: now() }, quests))
  })

  /** Refuse it, with a reason its author reads. */
  v1.post('/quests/:questId/refuse', async (request, reply) => {
    const steward = await stewardFor(request, reply, store)
    if (steward === null) return reply

    const { questId } = request.params as { questId?: string }
    const result = await refuseQuest(
      { stewardId: steward.id, questId, body: request.body, at: now() },
      quests,
    )

    return send(reply, result)
  })
}

/** One shape for every answer, so a new route cannot invent a second one. */
function send<T>(reply: FastifyReply, result: QuestResult<T>, status = 200): FastifyReply {
  if (result.outcome === 'rejected') {
    return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
  }

  return reply.status(status).send(result.response)
}

const now = (): Timestamp => new Date().toISOString()
