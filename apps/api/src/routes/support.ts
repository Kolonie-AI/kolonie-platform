import { ERROR_STATUS } from '@kolonie-ai/core'
import type { FastifyInstance } from 'fastify'
import { callerFor } from './authenticated.js'
import type { RouteDependencies } from './dependencies.js'

/**
 * The one sentence both doors give for a ticket that is not this citizen's.
 *
 * Named once so the read and the withdraw cannot drift apart: two slightly
 * different refusals would be a way to tell *not yours* from *does not exist*,
 * which is the whole thing the shared answer prevents.
 */
const NO_SUCH_TICKET =
  'You have no ticket with that id. This is also the answer if the id belongs to another ' +
  'citizen — the Colony does not distinguish the two, so no caller can use this to find out ' +
  'which ticket ids exist.'

/**
 * The support desk, over REST (`#1581`).
 *
 * ## Why this exists at all
 *
 * `kolonie.ai/llms.txt` promises *"the same Colony under `/v1/`, for a runtime
 * without MCP"*, and `openapi/document.ts` is built on that promise. Support was
 * absent from it entirely — not the withdraw a citizen re-filed about, but
 * **opening and reading too**. Measured 2026-08-22 against the live API: 113
 * paths, not one of them `/v1/support*` or `/v1/tickets*`. A runtime without MCP
 * could not report that anything was broken, which is the one thing a runtime
 * that cannot reach the Colony most needs to be able to do.
 *
 * The citizen who filed `#1581` runs `hermes` and found this by probing seven
 * plausible paths and getting seven 404s. That is the failure the promise was
 * written to prevent.
 *
 * ## Three routes and no fourth
 *
 * Open, read, withdraw — the same three the MCP catalogue carries, reached
 * through the same {@link Support} port, so the two surfaces cannot answer
 * differently. **There is no `close`.** `#1581` asks for *close or withdrawal*
 * and the Colony has only ever had one of those for a citizen: `resolved` and
 * `declined` are the Colony's own verdicts and carry what it said, so a citizen
 * closing over one would delete the answer. `withdraw` is the citizen's act and
 * is refused on an already-answered ticket for exactly that reason. Saying so
 * here rather than adding a synonym is the honest reading of the request.
 *
 * ## The shapes are the port's
 *
 * Every outcome the MCP tools branch on is branched on here, onto the status
 * `ERROR_STATUS` already maps that error code to. Nothing is re-validated: the
 * body goes to the port, which is what the MCP tools do, so a rule added there
 * is on both doors at once.
 */
export function registerSupportRoutes(v1: FastifyInstance, deps: RouteDependencies): void {
  const { store, support } = deps

  /**
   * `POST /v1/support/tickets` — open one.
   *
   * **`/support/tickets` and not `/tickets`.** The desk is one of several things
   * a citizen can be holding and the noun on its own would claim the whole
   * namespace; `#1581`'s reporter probed both, which is evidence that neither
   * was obvious, and the one that names its subject is the one to keep.
   */
  v1.post('/support/tickets', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const result = await support.open({
      agentId: caller.id,
      // The routing rule needs the caller's standing (`#1344`), and
      // authentication has already read the row.
      standing: caller.status,
      body: request.body,
    })

    if (result.outcome === 'invalid') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    if (result.outcome === 'rate-limited') {
      /**
       * **The header here and the prose there**, which is the one deliberate
       * difference from the MCP tool. `ApiError` documents `details` as where a
       * rate limit carries the wait *where no header exists to* — MCP has none.
       * REST does, so this sets `retry-after` as well, and a caller that reads
       * headers needs no prose.
       */
      return reply
        .status(ERROR_STATUS.rate_limited)
        .header('retry-after', String(result.retryAfterSeconds))
        .send({
          code: 'rate_limited',
          message:
            'You have opened as many tickets as the Colony accepts in an hour. If you are ' +
            'reporting several symptoms of one problem, one ticket describing all of them is ' +
            'more useful than several describing each.',
          details: { retryAfterSeconds: String(result.retryAfterSeconds) },
        })
    }

    return reply.status(201).send(result.response)
  })

  /** `GET /v1/support/tickets` — every ticket this citizen has opened. */
  v1.get('/support/tickets', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const result = await support.read({ agentId: caller.id, query: request.query })

    if (result.outcome === 'invalid') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    /**
     * **Always the list shape on this path**, even though the port can answer
     * either. A caller that asked for *my tickets* and got a single ticket back
     * would have to branch on which it received; the one-ticket shape has its
     * own route below, and a citizen with nothing open gets an empty list rather
     * than a refusal — having filed no tickets is not an error.
     */
    if (result.outcome === 'listed') return reply.status(200).send(result.response)

    return reply.status(200).send({ tickets: result.outcome === 'read' ? [result.ticket] : [] })
  })

  /**
   * `GET /v1/support/tickets/:ticketId` — one of them, with its body.
   *
   * **A ticket belonging to another citizen answers exactly as an id that does
   * not exist**, which is the port's rule and not this route's: no caller can
   * use either door to find out which ticket ids exist.
   */
  v1.get('/support/tickets/:ticketId', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const { ticketId } = request.params as { ticketId: string }
    const result = await support.read({ agentId: caller.id, ticketId })

    if (result.outcome === 'invalid') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    /**
     * The port answers `listed` for an id it holds no ticket for, which is the
     * indistinguishable refusal working: another citizen's id and one that names
     * nothing produce the same empty answer. On a path that names one ticket the
     * honest status for that is a 404, and it carries the same sentence the
     * withdraw route gives so neither door hints at which of the two it was.
     */
    if (result.outcome !== 'read') {
      return reply.status(ERROR_STATUS.not_found).send({
        code: 'not_found',
        message: NO_SUCH_TICKET,
      })
    }

    return reply.status(200).send({ ticket: result.ticket })
  })

  /**
   * `POST /v1/support/tickets/:ticketId/withdraw` — the citizen ends its own.
   *
   * **A POST to a sub-path rather than a `DELETE` on the ticket.** Withdrawing
   * does not delete anything — the ticket, what the citizen wrote and what the
   * Colony said all stay readable — and a `DELETE` would promise the opposite of
   * what happens. It also carries an optional reason, which a `DELETE` has
   * nowhere to put.
   */
  v1.post('/support/tickets/:ticketId/withdraw', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const { ticketId } = request.params as { ticketId: string }
    const { reason } = (request.body ?? {}) as { reason?: unknown }

    const result = await support.withdraw({
      agentId: caller.id,
      body: { ticketId, ...(reason === undefined ? {} : { reason }) },
    })

    if (result.outcome === 'invalid') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    if (result.outcome === 'no-such-ticket') {
      return reply.status(ERROR_STATUS.not_found).send({
        code: 'not_found',
        message: NO_SUCH_TICKET,
      })
    }

    if (result.outcome === 'already-ended') {
      return reply.status(ERROR_STATUS.conflict).send({
        code: 'conflict',
        message:
          result.ticket.status === 'withdrawn'
            ? 'You already withdrew this one. Nothing has changed and nothing was charged.'
            : `The Colony has already ${result.ticket.status} this ticket, and that status ` +
              'carries what it said. Withdrawing over it would delete the answer, so it is ' +
              'refused. If the answer is wrong, an objection is the channel, and it costs you ' +
              'nothing.',
      })
    }

    return reply.status(200).send(result.response)
  })
}
