import { ERROR_STATUS, type Timestamp } from '@kolonie-ai/core'
import type { FastifyInstance, FastifyReply } from 'fastify'
import {
  editQuestDraft,
  exportQuestResults,
  readAudience,
  readAuditQueue,
  readOwnAnswer,
  readQuestResults,
  recordAudit,
  listQuests,
  publishQuest,
  readQuest,
  readReviewQueue,
  refuseQuest,
  submitQuest,
  withdrawQuest,
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

  /**
   * The caller, by key or by session (`#430`).
   *
   * Every author-facing route here takes it, because a quest is written, priced,
   * previewed, submitted and funded in one sitting: a form a browser can open
   * and a submit it cannot is not a form. The steward's routes below keep
   * `stewardFor`, which is a different question and unchanged.
   *
   * **It was `sponsorFor` until `#578`**, which additionally resolved a browser
   * session to the person's minted `sponsor-*` identity. Nothing mints one, so
   * that fallback had no identity left to find and the two functions had become
   * the same function.
   */
  const acting = (
    request: Parameters<typeof callerFor>[0],
    reply: Parameters<typeof callerFor>[1],
  ) => callerFor(request, reply, store)

  /** Write a draft. Nothing is committed and nothing is visible to anyone else. */
  v1.post('/quests', async (request, reply) => {
    const caller = await acting(request, reply)
    if (caller === null) return reply

    const result = await writeQuestDraft({ authorId: caller.id, body: request.body }, quests)
    return send(reply, result, 201)
  })

  /** Everything this account has written, in every status. */
  v1.get('/quests', async (request, reply) => {
    const caller = await acting(request, reply)
    if (caller === null) return reply

    return send(reply, await listQuests(caller.id, quests))
  })

  /**
   * **`GET /quests/balance` and `GET /quests/credits` stood here** (`#553`,
   * D-106).
   *
   * Both answered *what do you hold with the Colony*, in credits. Nothing does:
   * a citizen is paid in SOL to a wallet the Colony holds no key to, and a
   * sponsor pays an invoice from its own. `kolonie.me.earnings` (`#535`) is the
   * citizen's side and the quest's invoice is the sponsor's, and neither is a
   * balance.
   *
   * Removed here in the same commit as the MCP tools, deliberately: they read
   * the same two functions, and a REST route answering a balance the MCP surface
   * says does not exist is `kolonie-platform#561` — two readers of one fact
   * disagreeing — which this issue exists to end rather than to create.
   */

  /**
   * How many citizens a requirement set reaches (`#350`).
   *
   * **A `GET` with the criteria in the query string**, because it is a read and
   * behaves like one: nothing is stored, the same question answers the same way,
   * and a sponsor can ask it before it has written anything. A body on a read
   * would have been the only such route on this prefix.
   *
   * Open to any authenticated caller and not to stewards alone: the sponsor
   * deciding what to require is exactly who the number is for, and it is a count
   * that names nobody — `reportAudience` is what keeps that true for small
   * populations.
   */
  v1.get('/quests/audience', async (request, reply) => {
    const caller = await acting(request, reply)
    if (caller === null) return reply

    return send(reply, await readAudience(request.query, quests))
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
    const caller = await acting(request, reply)
    if (caller === null) return reply

    const { questId } = request.params as { questId?: string }
    return send(reply, await readQuest({ authorId: caller.id, questId }, quests))
  })

  /** Change a draft, or correct a refused quest. */
  v1.patch('/quests/:questId', async (request, reply) => {
    const caller = await acting(request, reply)
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
    const caller = await acting(request, reply)
    if (caller === null) return reply

    const { questId } = request.params as { questId?: string }
    return send(reply, await submitQuest({ authorId: caller.id, questId, at: now() }, quests))
  })

  /**
   * Take it back out of the queue (`#323`).
   *
   * The undo for the step above, and the only one the write path was missing:
   * submitting freezes the text and takes the account's single queue slot, so a
   * sponsor that spotted its own error could do nothing but wait for a steward
   * to read a text it already knew was wrong.
   */
  v1.post('/quests/:questId/withdraw', async (request, reply) => {
    const caller = await acting(request, reply)
    if (caller === null) return reply

    const { questId } = request.params as { questId?: string }
    return send(reply, await withdrawQuest({ authorId: caller.id, questId, at: now() }, quests))
  })

  /** Publish it, which is also when its money moves. */
  v1.post('/quests/:questId/publish', async (request, reply) => {
    const steward = await stewardFor(request, reply, store)
    if (steward === null) return reply

    const { questId } = request.params as { questId?: string }
    return send(reply, await publishQuest({ stewardId: steward.id, questId, at: now() }, quests))
  })

  /**
   * What the quest has bought so far (`#178`).
   *
   * **Results stream: there is no completion event to wait for.** A sponsor
   * sees an accepted answer as soon as it is accepted, which is what lets it
   * watch the first fifty and decide whether the question was any good.
   */
  v1.get('/quests/:questId/results', async (request, reply) => {
    const caller = await acting(request, reply)
    if (caller === null) return reply

    const { questId } = request.params as { questId?: string }
    return send(reply, await readQuestResults({ authorId: caller.id, questId }, quests))
  })

  /**
   * The same set as a file.
   *
   * A separate route rather than a query parameter on the one above, because
   * the two answer with different content types and a client that asked for
   * JSON and got a CSV body under `application/json` would be the Colony
   * lying in a header.
   */
  v1.get('/quests/:questId/results/export', async (request, reply) => {
    const caller = await acting(request, reply)
    if (caller === null) return reply

    const { questId } = request.params as { questId?: string }
    const { format } = request.query as { format?: string }
    const result = await exportQuestResults({ authorId: caller.id, questId, format }, quests)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.header('content-type', result.contentType).send(result.body)
  })

  /**
   * A citizen's own answer, in the sponsor's shape.
   *
   * It published something to a stranger; it is entitled to know what was
   * published — and this is what makes the scrub checkable by the people it
   * protects.
   */
  v1.get('/quests/:questId/answer', async (request, reply) => {
    const caller = await acting(request, reply)
    if (caller === null) return reply

    const { questId } = request.params as { questId?: string }
    return send(reply, await readOwnAnswer({ agentId: caller.id, questId }, quests))
  })

  /**
   * The verdicts drawn for a second reading (`#221`).
   *
   * A steward's surface, and it shows the questions, the answers and the
   * verdict — never the citizen. `#177` keeps the judge blind for a reason, and
   * a human auditor with more context than the judge is not auditing the judge.
   */
  v1.get('/quests/audit', async (request, reply) => {
    const steward = await stewardFor(request, reply, store)
    if (steward === null) return reply

    return send(reply, await readAuditQueue(steward.id, quests))
  })

  /** What the steward found. It is counted; it is never applied. */
  v1.post('/quests/audit/:submissionId', async (request, reply) => {
    const steward = await stewardFor(request, reply, store)
    if (steward === null) return reply

    const { submissionId } = request.params as { submissionId?: string }
    return send(
      reply,
      await recordAudit({ stewardId: steward.id, submissionId, body: request.body }, quests),
    )
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
